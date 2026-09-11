/**
 * The structured log.
 *
 * Every build, check, edit, activation and turn becomes one row with the
 * identity it had when it happened — run, call, application, release, source
 * revision — or `NULL` where it had none. A row with no origin stays that way:
 * nothing here, or later, may decide which run a line "probably" belonged to.
 *
 * Two filters stand between a caller and the table. Free text passes
 * {@link sanitise}, which removes the shapes secrets usually come in. And the
 * structured part is built from an allow-list per kind: a field the list does
 * not name is dropped, not stored, so a caller that passes a whole object by
 * accident stores only what somebody decided was worth keeping.
 *
 * A log is never a reason for the launcher to fail. A write that fails is
 * counted, reported once, and the next write that succeeds says how many were
 * lost.
 */
import { homedir } from 'node:os';

import { canonicalJson } from 'broapp/host';
import type { HostLogger } from 'broapp/host';

import { redact } from '../host/run-store.ts';

import type { Knowledge } from './store.ts';

/** What an event is about. */
export type EventKind =
  | 'log'
  | 'build'
  | 'check'
  | 'edit'
  | 'run'
  | 'usage'
  | 'activate'
  | 'stderr'
  | 'search'
  | 'dropped';

/** Who an event belongs to, as it was known when the event happened. */
export interface Origin {
  readonly runId?: string;
  readonly callId?: string;
  readonly appId?: string;
  readonly releaseId?: string;
  readonly sourceRev?: string;
}

/** The launcher's log: a `HostLogger`, plus structured events. */
export interface EventLog extends HostLogger {
  event(
    kind: EventKind,
    message: string,
    data?: Record<string, unknown>,
    origin?: Origin,
    source?: string,
  ): void;
  /** A logger for one child's stderr: source `child:<appId>`, kind `stderr`. */
  child(appId: string, pid?: number): HostLogger;
  stats(): { written: number; dropped: number };
}

/** Options for {@link createEventLog}. */
export interface EventLogOptions {
  /** The `source` of every row this log writes, unless an event names another. */
  readonly source: string;
  /** Where warnings, errors and child lines also go: the console, or nothing in a test. */
  readonly tee?: HostLogger;
}

/** The longest message kept, after sanitising. */
const MAX_MESSAGE = 2_000;
/** The longest `data`, as canonical JSON, after sanitising. */
const MAX_DATA = 4_000;

/**
 * How one allowed field is kept.
 *
 * `keep` is a host-made value — an identifier, a count, a flag — stored as it
 * is, because sanitising an identifier destroys it: a release id is exactly the
 * 32 hex characters the sanitiser removes. `text` is words, which may have come
 * from anywhere and are sanitised. An object lists the fields of each element of
 * an array.
 */
type FieldRule = 'keep' | 'text' | { readonly [field: string]: 'keep' | 'text' };

/** What each kind may carry. Anything else is dropped. */
const ALLOWED: Readonly<Record<EventKind, Readonly<Record<string, FieldRule>>>> = {
  build: {
    ok: 'keep',
    releaseId: 'keep',
    stagesRun: 'keep',
    problems: { stage: 'keep', message: 'text' },
    ms: 'keep',
  },
  check: {
    releaseId: 'keep',
    previewId: 'keep',
    results: { id: 'keep', passed: 'keep', detail: 'text' },
  },
  edit: { paths: 'keep', hunks: 'keep', matchedBy: 'keep', bytes: 'keep' },
  run: { status: 'keep', steps: 'keep', ms: 'keep' },
  usage: { inputTokens: 'keep', outputTokens: 'keep' },
  activate: { ok: 'keep', phase: 'keep', reason: 'text', recovered: 'text', releaseId: 'keep' },
  // `miss` and `lessonId` are the distiller's: a lesson that existed and was
  // not in what the engineer was given, which is the one thing a search that
  // matched nothing cannot say about itself.
  search: {
    tokens: 'text',
    hits: 'keep',
    requested: 'keep',
    resolved: 'keep',
    included: 'keep',
    miss: 'keep',
    lessonId: 'keep',
  },
  stderr: { pid: 'keep' },
  log: {},
  dropped: {},
};

/**
 * Remove what secrets usually look like from free text.
 *
 * A courtesy, not a guarantee, like `redact` beside it: it catches a key after
 * the word that names it, a bearer token, a provider key's prefix, long hex and
 * base64 runs, a URL's credentials and query, and the home directory. It cannot
 * catch a secret that looks like an ordinary word. The real rule is still that
 * nothing puts one in a message in the first place.
 */
export function sanitise(text: string): string {
  let out = text;
  // The scheme word is taken with the value, so `Authorization: Bearer x`
  // loses `x` rather than only the word "Bearer".
  out = out.replace(
    /(api[_-]?key|secret|token|password|authorization)\s*[=:]\s*(?:(?:bearer|basic)\s+)?\S+/gi,
    '$1=<redacted>',
  );
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '<redacted>');
  // Forty, not thirty-two: a release id is exactly 32 hex characters and is an
  // identifier the log wants to keep. A SHA-256 (64) or a 40-character token
  // is still taken.
  out = out.replace(/[A-Fa-f0-9]{40,}/g, '<redacted>');
  out = out.replace(/[A-Za-z0-9+/=]{40,}/g, '<redacted>');
  // A URL keeps its scheme, host and path. Its `user:pass@` and its query go:
  // a launch token is a query parameter.
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1');
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi, '$1');
  const home = homedir();
  if (home !== '' && home !== '/') out = out.split(home).join('~');
  return out;
}

/** Sanitise every string inside a value, at any depth. */
function sanitiseDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitise(value);
  if (Array.isArray(value)) return value.map(sanitiseDeep);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitiseDeep(member);
    }
    return out;
  }
  return value;
}

/** One field, by its rule. */
function keepField(value: unknown, rule: FieldRule): unknown {
  if (rule === 'keep') return value;
  // `redact` works by key name, so it applies inside free text and not to the
  // allow-listed fields themselves: those names were chosen here, and
  // `inputTokens` is a count, not the secret its name happens to contain.
  if (rule === 'text') return sanitiseDeep(redact(value));
  if (!Array.isArray(value)) return undefined;
  return value.map((element) => {
    if (typeof element !== 'object' || element === null) return undefined;
    const out: Record<string, unknown> = {};
    for (const [field, inner] of Object.entries(rule)) {
      const member = (element as Record<string, unknown>)[field];
      if (member !== undefined) out[field] = keepField(member, inner);
    }
    return out;
  });
}

/**
 * The stored form of an event's data: allowed fields only, sanitised, capped.
 *
 * Capped as valid JSON rather than cut mid-string: a reader that cannot parse
 * a row has lost all of it, where a reader told it was truncated has lost only
 * the tail.
 */
export function eventData(kind: EventKind, data: Record<string, unknown> | undefined): string | null {
  if (data === undefined) return null;
  const allowed = ALLOWED[kind];
  const kept: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(allowed)) {
    const value = data[field];
    if (value === undefined) continue;
    const stored = keepField(value, rule);
    if (stored !== undefined) kept[field] = stored;
  }
  if (Object.keys(kept).length === 0) return null;
  const text = canonicalJson(kept);
  if (text.length <= MAX_DATA) return text;
  let cut = MAX_DATA - 50;
  for (;;) {
    const shorter = canonicalJson({ truncated: text.slice(0, cut) });
    if (shorter.length <= MAX_DATA || cut <= 0) return shorter;
    cut -= 200;
  }
}

/** An empty identity is no identity: stored as `NULL`. */
function column(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** Build the launcher's log over a knowledge store. */
export function createEventLog(knowledge: Knowledge, options: EventLogOptions): EventLog {
  const tee = options.tee;
  let written = 0;
  let dropped = 0;
  /** Lost since the last `dropped` event, and whether that loss has been reported. */
  let lost = 0;
  let reported = false;

  function insert(
    level: string,
    source: string,
    kind: EventKind,
    message: string,
    data: string | null,
    origin: Origin,
  ): void {
    knowledge.db
      .query<
        null,
        [
          number,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string,
          string | null,
        ]
      >(
        `INSERT INTO events (at, level, source, kind, app_id, run_id, call_id, release_id, source_rev, message, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        level,
        source,
        kind,
        column(origin.appId),
        column(origin.runId),
        column(origin.callId),
        column(origin.releaseId),
        column(origin.sourceRev),
        message,
        data,
      );
  }

  function write(
    level: string,
    kind: EventKind,
    message: string,
    data: Record<string, unknown> | undefined,
    origin: Origin,
    source: string,
  ): void {
    try {
      insert(level, source, kind, sanitise(message).slice(0, MAX_MESSAGE), eventData(kind, data), origin);
      written += 1;
    } catch (cause) {
      // Counted and reported once, and nothing else is attempted against the
      // database while it is refusing: a loop of "could not write the error
      // about not writing" helps nobody.
      dropped += 1;
      lost += 1;
      if (!reported) {
        reported = true;
        tee?.error(
          `[autoapp] the knowledge log could not write an event: ${String(cause instanceof Error ? cause.message : cause)}`,
        );
      }
      return;
    }
    if (lost === 0) return;
    const count = lost;
    try {
      insert('warn', options.source, 'dropped', `${String(count)} events could not be written`, null, {});
      written += 1;
      lost = 0;
      reported = false;
    } catch {
      // Still refusing; the count stays and the next success tries again.
    }
  }

  const log: EventLog = {
    warn(message) {
      tee?.warn(message);
      write('warn', 'log', message, undefined, {}, options.source);
    },
    error(message) {
      tee?.error(message);
      write('error', 'log', message, undefined, {}, options.source);
    },
    event(kind, message, data, origin = {}, source = options.source) {
      write('info', kind, message, data, origin, source);
    },
    child(appId, pid) {
      const source = `child:${appId}`;
      const data = pid === undefined ? undefined : { pid };
      return {
        warn(line) {
          tee?.warn(`[child] ${line}`);
          write('warn', 'stderr', line, data, { appId }, source);
        },
        error(line) {
          tee?.error(`[child] ${line}`);
          write('error', 'stderr', line, data, { appId }, source);
        },
      };
    },
    stats: () => ({ written, dropped }),
  };
  return log;
}
