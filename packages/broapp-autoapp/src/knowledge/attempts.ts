/**
 * What a task's earlier attempts did, for the turn that tries it again.
 *
 * A retry used to be told the last verdict's sentences and nothing else: not
 * which files the attempt before it changed, not which build problem it left,
 * not that the same problem had come back twice. One bounded document says
 * that, built from what was recorded when it happened — the edit, build and
 * check events of each earlier run, the task's own history, and the planning
 * model's diagnosis — and from nothing a model wrote except that diagnosis.
 *
 * {@link attemptsDocument} is pure: plain input, one string or `null`. The
 * reads that feed it are {@link attemptsInput}, beside it, so a test can hand
 * the function exactly the case it means.
 */
import type { RunStore } from '../host/run-store.ts';
import { NOT_AN_ATTEMPT, reasonsFromNote, refusalLine, type IntentStore, type RefusalGroup, type TaskRecord } from '../intent/index.ts';

import { sanitise } from './log.ts';
import { problemSignature } from './scoring.ts';
import type { Knowledge } from './store.ts';

/** The most an attempts document may be. */
export const ATTEMPTS_DOCUMENT_CHARS = 1_500;
/** The most paths an attempt's `Changed:` line names. */
const MAX_PATHS = 8;
/** The most paths an attempt's `Read:` line names. */
const MAX_READ_PATHS = 6;
/**
 * The one line in the document that tells a builder what to do.
 *
 * 14a's only retry followed an attempt that read four files, edited nothing
 * and was ended by the idle limit; told "Changed: nothing", the retry read the
 * same two files and went silent the same way. So when the newest earlier
 * attempt changed nothing, the document ends with this, once.
 */
export const START_FROM_AN_EDIT =
  'The last attempt read these and changed nothing. Do not read them again: make the first edit the plan calls for, then use candidate.cycle.';
/** The most lines under `Ended with:`, `Refused:` and `Still wrong at the end:`. */
const MAX_LINES = 3;
/** How many paths `Changed:` keeps when the newest attempt alone is over the cap. */
const TRIMMED_PATHS = 3;
/** The longest error a `Refused:` line keeps. */
const REFUSAL_CHARS = 120;
/** The longest one problem, detail or reason may be. */
const LINE_CHARS = 160;

/** One problem the last build of an attempt left. */
export interface AttemptProblem {
  readonly stage: string;
  readonly message: string;
}

/** One example the last check of an attempt ran. */
export interface AttemptCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** One earlier attempt, as plain data. */
export interface AttemptRecord {
  readonly attempt: number;
  /** How its move out of `in-progress` was written down; `null` when nothing was. */
  readonly ended: { readonly to: 'failed' | 'interrupted'; readonly note: string } | null;
  /** The paths its `edit` events name, in the order they were first edited. */
  readonly edited: readonly string[];
  /** The problems of its last build; empty when that build passed or none ran. */
  readonly lastBuild: readonly AttemptProblem[];
  /** The results of its last check, when that check came after its last build. */
  readonly lastCheck: readonly AttemptCheck[];
  /**
   * The distinct paths its `source.read` calls named, in the order first read,
   * from the launcher's run store. Shown only for an attempt that edited
   * nothing: for one that did, what it changed says more than what it looked at.
   */
  readonly read?: readonly string[];
  /**
   * What the tools refused in its turn, largest group first, from the
   * launcher's run store. A builder whose every cycle was refused for its
   * input and is then told only "Nothing was built" repeats the same call.
   */
  readonly refused?: readonly RefusalGroup[];
}

/** What {@link attemptsDocument} is built from. */
export interface AttemptsInput {
  readonly attempts: readonly AttemptRecord[];
  /** The planning model's diagnosis of the task's last failure, when there is one. */
  readonly diagnosis: string | null;
}

/** The first line of a text, sanitised and cut. */
function firstLine(text: string): string {
  const line = sanitise(text).split(/\r?\n/).find((part) => part.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length <= LINE_CHARS ? trimmed : `${trimmed.slice(0, LINE_CHARS - 1)}…`;
}

/** At most `max` lines, then "and <k> more". */
function bounded(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines];
  return [...lines.slice(0, max), `- and ${String(lines.length - max)} more`];
}

/** Whether an attempt is one the builder made. A move marked {@link NOT_AN_ATTEMPT} was not. */
function isAttempt(record: AttemptRecord): boolean {
  return record.ended === null || !record.ended.note.startsWith(NOT_AN_ATTEMPT);
}

/** How much of an attempt a block shows: every section, or less when over the cap. */
interface BlockShape {
  /** Whether the `Refused:` section is shown. */
  readonly refused: boolean;
  /** How many paths `Changed:` names before "and <k> more". */
  readonly paths: number;
}

const WHOLE: BlockShape = { refused: true, paths: MAX_PATHS };

/** One attempt's lines. */
function block(record: AttemptRecord, shape: BlockShape = WHOLE): string[] {
  const stopped = record.ended?.to === 'interrupted';
  const lines = [`Attempt ${String(record.attempt)}${stopped ? ' (stopped before it finished)' : ''}`];
  const paths = record.edited.map((path) => sanitise(path));
  const named = paths.slice(0, shape.paths).join(', ');
  const more = paths.length > shape.paths ? ` and ${String(paths.length - shape.paths)} more` : '';
  lines.push(`Changed: ${paths.length === 0 ? 'nothing' : `${named}${more}`}`);
  const read = paths.length === 0 ? (record.read ?? []).map((path) => sanitise(path)) : [];
  if (read.length > 0) {
    const extra = read.length > MAX_READ_PATHS ? ` and ${String(read.length - MAX_READ_PATHS)} more` : '';
    lines.push(`Read: ${read.slice(0, MAX_READ_PATHS).join(', ')}${extra}`);
  }
  // An interrupted attempt lists only what it changed: how it would have
  // ended is not known, and what the build said halfway is not a result.
  if (stopped) return lines;
  if (record.ended !== null) {
    // How the turn ended first: when the list is cut, "The turn made no tool
    // call for 8 minutes" says more than a fourth "No example named … was run".
    const all = reasonsFromNote(record.ended.to, record.ended.note);
    const ordered = [...all.filter((reason) => reason.startsWith('The turn ')), ...all.filter((reason) => !reason.startsWith('The turn '))];
    const reasons = ordered.map((reason) => `- ${firstLine(reason)}`);
    if (reasons.length > 0) lines.push('Ended with:', ...bounded(reasons, MAX_LINES));
  }
  // What the tools refused, after how it ended: the reason nothing was built
  // is often here, and it is what the next attempt must not send again.
  const refused = shape.refused ? (record.refused ?? []).slice(0, MAX_LINES) : [];
  if (refused.length > 0) {
    lines.push('Refused:', ...refused.map((group) => `- ${refusalLine({ ...group, error: sanitise(group.error) }, REFUSAL_CHARS)}`));
  }
  const wrong = [
    ...record.lastBuild.map((problem) => `- ${problem.stage}: ${firstLine(problem.message)}`),
    ...record.lastCheck.filter((check) => !check.passed).map((check) => `- ${check.id}: ${firstLine(check.detail ?? 'failed')}`),
  ];
  if (wrong.length > 0) lines.push('Still wrong at the end:', ...bounded(wrong, MAX_LINES));
  return lines;
}

/**
 * The problems present in the last build of two or more attempts, by
 * signature, with the attempts named. This is the line that tells a builder
 * not to try the same repair again.
 */
function cameBack(attempts: readonly AttemptRecord[]): string[] {
  const seen = new Map<string, { problem: AttemptProblem; attempts: number[] }>();
  for (const record of attempts) {
    const mine = new Set<string>();
    for (const problem of record.lastBuild) {
      const key = problemSignature(problem.stage, problem.message);
      if (mine.has(key)) continue;
      mine.add(key);
      const entry = seen.get(key) ?? { problem, attempts: [] };
      entry.attempts.push(record.attempt);
      seen.set(key, entry);
    }
  }
  const lines: string[] = [];
  for (const { problem, attempts: numbers } of seen.values()) {
    if (numbers.length < 2) continue;
    const named = `${numbers.slice(0, -1).join(', ')} and ${String(numbers[numbers.length - 1])}`;
    lines.push(`- ${problem.stage}: ${firstLine(problem.message)} (attempts ${named})`);
  }
  return lines.length === 0 ? [] : ['Came back:', ...bounded(lines, MAX_LINES)];
}

/** Lines joined, and how long that is. */
function size(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/**
 * What a task's earlier attempts did, or `null` when it has none that were
 * attempts.
 *
 * Oldest first. When the whole does not fit in {@link ATTEMPTS_DOCUMENT_CHARS},
 * the older attempts are cut at a line from the end, then the diagnosis goes,
 * then what came back, then the newest attempt's `Refused:` lines, and last its
 * `Changed:` paths are trimmed — each bounded so that the newest attempt alone
 * always fits. When the newest attempt changed
 * nothing, {@link START_FROM_AN_EDIT} closes the document and is never cut.
 */
export function attemptsDocument(input: AttemptsInput): string | null {
  const attempts = input.attempts.filter(isAttempt).sort((a, b) => a.attempt - b.attempt);
  const newest = attempts[attempts.length - 1];
  if (newest === undefined) return null;
  const older = attempts.slice(0, -1).flatMap((record) => block(record));
  let last = block(newest);
  const closing = newest.edited.length === 0 ? [START_FROM_AN_EDIT] : [];
  const back = cameBack(attempts);
  const diagnosis =
    input.diagnosis === null || input.diagnosis.trim() === ''
      ? []
      : [`How the planning model read it: ${sanitise(input.diagnosis).replace(/\s+/g, ' ').trim().slice(0, 400)}`];

  // The cut order, after the older attempts: the diagnosis, what came back,
  // the newest attempt's refusals, then its changed paths trimmed.
  const budget = ATTEMPTS_DOCUMENT_CHARS - size(closing);
  const over = (): boolean => size(last) + size(tail) > budget;
  let tail = [...back, ...diagnosis];
  if (over()) tail = back;
  if (over()) tail = [];
  if (over()) last = block(newest, { ...WHOLE, refused: false });
  if (over()) last = block(newest, { refused: false, paths: TRIMMED_PATHS });
  const room = budget - size(last) - size(tail);
  const kept: string[] = [];
  if (size(older) <= room) {
    kept.push(...older);
  } else {
    for (const line of older) {
      if (size(kept) + line.length + 1 > room - 2) break;
      kept.push(line);
    }
    kept.push('…');
  }
  return [...kept, ...last, ...tail, ...closing].join('\n');
}

interface EventRow {
  id: number;
  kind: 'edit' | 'build' | 'check';
  data: string | null;
}

function parsedData(row: EventRow): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.data ?? '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The paths an `edit` event names, as the event wrote them. */
export function editedPaths(data: Record<string, unknown>): string[] {
  return listOf(data['paths']).filter((path): path is string => typeof path === 'string');
}

/** What one run left, read from its events. */
export function runRecord(knowledge: Knowledge, runId: string): Pick<AttemptRecord, 'edited' | 'lastBuild' | 'lastCheck'> {
  const rows = knowledge.db
    .query<EventRow, [string]>(
      "SELECT id, kind, data FROM events WHERE run_id = ? AND kind IN ('edit', 'build', 'check') ORDER BY id",
    )
    .all(runId);
  const edited: string[] = [];
  let build: EventRow | null = null;
  let check: EventRow | null = null;
  for (const row of rows) {
    if (row.kind === 'edit') {
      for (const path of editedPaths(parsedData(row))) if (!edited.includes(path)) edited.push(path);
    } else if (row.kind === 'build') {
      build = row;
    } else {
      check = row;
    }
  }
  const lastBuild: AttemptProblem[] = [];
  if (build !== null) {
    for (const problem of listOf(parsedData(build)['problems'])) {
      const { stage, message } = (problem ?? {}) as { stage?: unknown; message?: unknown };
      if (typeof stage === 'string' && typeof message === 'string') lastBuild.push({ stage, message });
    }
  }
  // A check older than the last build checked something that is gone.
  const lastCheck: AttemptCheck[] = [];
  if (check !== null && (build === null || check.id > build.id)) {
    for (const result of listOf(parsedData(check)['results'])) {
      const { id, passed, detail } = (result ?? {}) as { id?: unknown; passed?: unknown; detail?: unknown };
      if (typeof id !== 'string' || typeof passed !== 'boolean') continue;
      lastCheck.push({ id, passed, ...(typeof detail === 'string' ? { detail } : {}) });
    }
  }
  return { edited, lastBuild, lastCheck };
}

/**
 * The distinct paths one run's `source.read` calls named, in order, from the
 * launcher's run store — which records every gated call's input, so a read is
 * already written down there and is not recorded a second time anywhere else.
 */
export function sourceReads(store: Pick<RunStore, 'getRun'>, runId: string): string[] {
  const paths: string[] = [];
  for (const step of store.getRun(runId)?.steps ?? []) {
    if (step.route !== 'source.read' || step.outcome !== 'succeeded') continue;
    const path = (step.input as { path?: unknown } | null)?.path;
    if (typeof path === 'string' && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * The input for a task's attempts document: every run of the task before
 * `currentRunId`, joined to how each ended by its attempt number, and the
 * planning model's diagnosis. Each store is read through its own handle;
 * `reads` and `refusals` are the run store's, absent where there is none.
 */
export function attemptsInput(
  knowledge: Knowledge,
  intents: IntentStore,
  task: TaskRecord,
  currentRunId: string | null,
  reads?: (runId: string) => readonly string[],
  refusals?: (runId: string) => readonly RefusalGroup[],
): AttemptsInput {
  const runs = intents.runsOf(task.id);
  const current = runs.find((run) => run.runId === currentRunId)?.attempt ?? Number.POSITIVE_INFINITY;
  const notes = intents.attemptNotes(task.id);
  const attempts = runs
    .filter((run) => run.attempt < current)
    .map((run) => {
      const note = notes.find((row) => row.attempt === run.attempt);
      return {
        attempt: run.attempt,
        ended: note === undefined ? null : { to: note.to, note: note.note },
        ...runRecord(knowledge, run.runId),
        ...(reads === undefined ? {} : { read: reads(run.runId) }),
        ...(refusals === undefined ? {} : { refused: refusals(run.runId) }),
      };
    });
  const advice = task.advice as { diagnosis?: unknown } | null;
  return { attempts, diagnosis: typeof advice?.diagnosis === 'string' ? advice.diagnosis : null };
}
