/**
 * Distillation: one structured question about a resolved case.
 *
 * When a failure's repair lands, the engineer's own model is asked what
 * explains the failure — and, from the six answers below, whether the engineer
 * could have known. The answer is always written to the case. Only two of the
 * six can carry a lesson, and a lesson is inserted **provisional**: served,
 * labelled, ranked below confirmed ones, and never promoted by anything in the
 * launcher. `knowledge confirm` is a person.
 *
 * The distiller reads blobs, never live files. What the engineer knew is what
 * the case's `contexts` row says it was given, at the corpus version it was
 * given it; the request, the example and the edits are what the case recorded
 * when they happened. A workspace edited since, or a lesson added since, cannot
 * change what the question is about.
 *
 * One question at a time, on one promise chain, after a turn has ended and
 * never during a turn's own model call: a local model asked two things at once
 * answers both slowly.
 */
import { jsonSchema, streamObject, type LanguageModel } from 'ai';
import { canonicalJson } from 'broapp/host';
import { s } from 'broapp/shared';

import { BUILD_STAGES } from '../launcher/candidate.ts';

import { sanitise, type EventLog } from './log.ts';
import type { Knowledge } from './store.ts';

/** The six causes a failure can be put down to. */
export const DIAGNOSES = [
  'knowledge_missing',
  'knowledge_not_retrieved',
  'method_unclear',
  'method_not_followed',
  'tool_or_environment',
  'insufficient_evidence',
] as const;

/** The two causes that may carry a lesson. */
const TEACHABLE: readonly string[] = ['knowledge_missing', 'method_unclear'];

/** The one answer the distiller asks for. The `parse` is the validation. */
export const DIAGNOSIS = s.object({
  diagnosis: s.enum(DIAGNOSES),
  reasoning: s.string({ max: 600 }),
  /** An existing lesson id, when the cause is the same. */
  sameCauseAs: s.nullable(s.number()),
  lesson: s.nullable(
    s.object({
      scope: s.enum(['global', 'app']),
      applies: s.object({
        stage: s.optional(s.enum([...BUILD_STAGES, 'check'] as const)),
        files: s.optional(s.array(s.string({ max: 120 }), { max: 5 })),
        routes: s.optional(s.array(s.string({ max: 80 }), { max: 5 })),
      }),
      summary: s.string({ min: 20, max: 400 }),
      detail: s.string({ min: 20, max: 2000 }),
      trigger: s.array(s.string({ min: 3, max: 40 }), { min: 3, max: 8 }),
    }),
  ),
});

/** A validated answer. */
export type Diagnosis = ReturnType<typeof DIAGNOSIS.parse>;

/** The distiller's standing instructions. Fixed text; the attribution test is in these words. */
export const DISTILLER_SYSTEM =
  'You are reviewing one failure the engineer hit and the repair that followed. You are shown exactly what the engineer had been told at the time. Decide which one thing explains the failure: the fact it needed was nowhere in what it was given (knowledge_missing); the fact existed as a lesson but was not in what it was given (knowledge_not_retrieved); the instructions covered this but were unclear (method_unclear); the instructions were clear and were not followed (method_not_followed); a tool, the build or the environment failed rather than the engineer (tool_or_environment); or you cannot tell from this evidence (insufficient_evidence). Write a lesson only for knowledge_missing or method_unclear. A lesson is one fact or one rule, stated once, that would have let the engineer avoid this failure. Do not restate the instructions. Do not include paths from this machine.';

/** How long one question may take, and how many times a case is asked. */
const DISTILL_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
/** How long `close()` waits for the question in flight to stop. */
const CLOSE_WAIT_MS = 5_000;
/** How many of the application's events around the case the distiller is shown. */
const EVENT_WINDOW = 20;

/** The distiller: a queue of resolved cases and the one question asked of each. */
export interface Distiller {
  enqueue(episodeIds: readonly number[]): void;
  /** Resolves when nothing is queued or in flight. */
  idle(): Promise<void>;
  /** Stop the question in flight, and wait for the queue to drain, at most five seconds. */
  close(): Promise<void>;
}

/** What {@link createDistiller} needs. */
export interface CreateDistillerInput {
  readonly knowledge: Knowledge;
  readonly log: EventLog;
  /** The configured model, asked for each question so a settings change is honoured. */
  readonly model: () => Promise<LanguageModel>;
  /** The engineer's instructions, whose hash a lesson records as what it was written against. */
  readonly instructions: string;
  readonly autoappVersion: string;
}

interface EpisodeRow {
  id: number;
  app_id: string;
  stage: string;
  signature: string;
  problem: string;
  example_blob: string | null;
  request_blob: string;
  context_id: number | null;
  run_id: string;
  source_rev_before: string;
  release_before: string | null;
  edits: string;
  opened_at: number;
  resolved_at: number | null;
  resolved_run_id: string | null;
  source_rev_after: string | null;
  release_after: string | null;
  distill_attempts: number;
}

interface LessonRow {
  id: number;
  version: number;
  status: string;
  scope: string;
  summary: string;
  detail: string;
}

/** A lesson for the same failure that already exists, and what the engineer was shown of it. */
interface Prior {
  readonly lesson: LessonRow;
  readonly existed: boolean;
  readonly delivered: boolean;
}

/**
 * The shapes a lesson must not carry.
 *
 * A path from this machine (`/Users/…`, `~/…`, `C:\…`) and a URL with a port are
 * facts about one computer, not about the engineer's work; a secret is a
 * secret. The test for a secret is whether the sanitiser would change the text.
 */
const ABSOLUTE_PATH = /(?:^|[\s'"`(=])(?:~\/|\/(?:[\w.-]+\/)+[\w.-]*|[A-Za-z]:[\\/])/;
const URL_WITH_PORT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*:\d+/i;

/** Why a lesson's text is refused, or `null` when it may be stored. */
function refusal(text: string): string | null {
  if (text.length > 400) return 'it is longer than 400 characters';
  if (ABSOLUTE_PATH.test(text)) return 'it names a path on this machine';
  if (URL_WITH_PORT.test(text)) return 'it names an address with a port';
  if (sanitise(text) !== text) return 'it contains something shaped like a secret';
  return null;
}

/** Reject when the signal aborts, whatever the promise is doing. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // The work may still settle after losing the race; its rejection is not news.
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
}

/** The lesson for this failure that already exists, if any, and whether the engineer had it. */
function priorLesson(knowledge: Knowledge, episode: EpisodeRow): Prior | null {
  const { db } = knowledge;
  const lesson = db
    .query<LessonRow, [string, string]>(
      `SELECT id, version, status, scope, summary, detail FROM lessons
        WHERE json_extract(applies, '$.signature') = ? AND status IN ('provisional', 'confirmed')
          AND (scope = 'global' OR scope = ?)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(episode.signature, `app:${episode.app_id}`);
  if (lesson === null) return null;
  const context =
    episode.context_id === null
      ? null
      : db
          .query<{ corpus_version: number; included: string }, [number]>(
            'SELECT corpus_version, included FROM contexts WHERE id = ?',
          )
          .get(episode.context_id);
  if (context === null) return { lesson, existed: false, delivered: false };
  const existed = lesson.version <= context.corpus_version;
  let delivered = false;
  try {
    const included = JSON.parse(context.included) as { ref?: unknown; blob?: unknown }[];
    delivered = included.some(
      (entry) =>
        typeof entry.ref === 'string' &&
        entry.ref.startsWith('lessons:') &&
        typeof entry.blob === 'string' &&
        (knowledge.getBlob(entry.blob) ?? '').includes(lesson.summary),
    );
  } catch {
    // An unreadable row says nothing was delivered, which is what it can prove.
  }
  return { lesson, existed, delivered };
}

/**
 * The question about one case, assembled from what was recorded.
 *
 * Exported so a report can say how large the question is, and so a test can
 * read it; the distiller is the only thing that sends it.
 */
export function distillerPrompt(knowledge: Knowledge, episodeId: number): string | null {
  const { db } = knowledge;
  const episode = db.query<EpisodeRow, [number]>('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (episode === null) return null;
  return assemble(knowledge, episode, priorLesson(knowledge, episode));
}

function assemble(knowledge: Knowledge, episode: EpisodeRow, prior: Prior | null): string {
  const { db } = knowledge;
  const blob = (hash: string | null): string => (hash === null ? '' : (knowledge.getBlob(hash) ?? ''));
  const parts: string[] = [];

  parts.push('# What the person asked for', blob(episode.request_blob) || '(not recorded)');

  const context =
    episode.context_id === null
      ? null
      : db
          .query<{ instructions_blob: string; included: string }, [number]>(
            'SELECT instructions_blob, included FROM contexts WHERE id = ?',
          )
          .get(episode.context_id);
  if (context === null) {
    parts.push('# What the engineer was given', '(no record of what the engineer was given for this turn)');
  } else {
    parts.push('# The instructions the engineer was given', blob(context.instructions_blob));
    let included: { ref?: unknown; blob?: unknown; truncated?: unknown }[] = [];
    try {
      included = JSON.parse(context.included) as typeof included;
    } catch {
      // Nothing readable was delivered.
    }
    parts.push('# The documents the engineer was given');
    if (included.length === 0) parts.push('(none)');
    for (const entry of included) {
      const ref = typeof entry.ref === 'string' ? entry.ref : '?';
      parts.push(`## ${ref}${entry.truncated === true ? ' (cut short by the budget)' : ''}`);
      parts.push(typeof entry.blob === 'string' ? blob(entry.blob) : '');
    }
  }

  parts.push('# The failure', `Stage: ${episode.stage}`, `Problem: ${episode.problem}`);
  if (episode.example_blob !== null) {
    parts.push('# The acceptance example that failed', blob(episode.example_blob));
  }

  parts.push('# The edits that followed', episode.edits === '' ? '(none recorded)' : episode.edits);
  const until = episode.resolved_at ?? Date.now();
  const edits = db
    .query<{ data: string | null }, [string, number, number]>(
      "SELECT data FROM events WHERE kind = 'edit' AND app_id = ? AND at >= ? AND at <= ? ORDER BY id",
    )
    .all(episode.app_id, episode.opened_at, until);
  for (const edit of edits) {
    try {
      const data = JSON.parse(edit.data ?? '{}') as { paths?: unknown; matchedBy?: unknown };
      parts.push(`- ${JSON.stringify(data.paths ?? [])} matched by ${JSON.stringify(data.matchedBy ?? [])}`);
    } catch {
      // An event that does not parse adds nothing.
    }
  }

  parts.push(
    '# Revisions',
    `Before: ${episode.source_rev_before}${episode.release_before === null ? '' : ` (release ${episode.release_before})`}`,
    `After: ${episode.source_rev_after ?? 'unknown'}${episode.release_after === null ? '' : ` (release ${episode.release_after})`}`,
  );

  const events = db
    .query<{ kind: string; level: string; message: string; data: string | null }, [string, number, number]>(
      `SELECT kind, level, message, data FROM events
        WHERE app_id = ? AND at >= ? AND at <= ? ORDER BY id DESC LIMIT ${String(EVENT_WINDOW)}`,
    )
    .all(episode.app_id, episode.opened_at, until)
    .reverse();
  parts.push('# What was logged while the case was open');
  if (events.length === 0) parts.push('(nothing)');
  for (const event of events) {
    parts.push(`- ${event.kind}/${event.level}: ${event.message}${event.data === null ? '' : ` ${event.data}`}`);
  }

  if (prior !== null) {
    parts.push(
      '# A lesson that already exists for this failure',
      `Lesson ${String(prior.lesson.id)} (${prior.lesson.status}, ${prior.lesson.scope}): ${prior.lesson.summary}`,
      prior.lesson.detail,
      prior.existed
        ? `This lesson existed when the failure happened and ${prior.delivered ? 'was' : 'was not'} among the documents delivered.`
        : 'This lesson did not exist yet when the failure happened.',
      'If the cause is the same, set sameCauseAs to its id.',
    );
  } else {
    parts.push('# Lessons for this failure', 'None exists. Set sameCauseAs to null.');
  }
  // The shape, in words the model reads. `streamObject` also sends it as the
  // response format, but a provider without structured outputs — Ollama's
  // OpenAI-compatible endpoint, the one this was measured against — drops
  // that with a warning, and the model is left guessing the field names.
  parts.push(
    '# Your answer',
    `One JSON object and nothing else, matching this JSON Schema. \`diagnosis\` is exactly one of: ${DIAGNOSES.join(', ')}. \`lesson\` is null unless the diagnosis is knowledge_missing or method_unclear.`,
    JSON.stringify(DIAGNOSIS.toJsonSchema()),
  );
  return parts.join('\n');
}

/** Ask the model, and validate what it says. */
async function ask(model: LanguageModel, prompt: string, signal: AbortSignal): Promise<Diagnosis> {
  const result = streamObject({
    model,
    // Without `validate`, `jsonSchema` validates nothing: it tells the model the
    // shape. The `parse` below is the validation, by the same schema.
    schema: jsonSchema(DIAGNOSIS.toJsonSchema()),
    system: DISTILLER_SYSTEM,
    prompt,
    abortSignal: signal,
    // The default prints the error; the distiller logs it itself, sanitised.
    onError: () => undefined,
  });
  // `object` settles only once the stream has been read to its end: nothing
  // drains it on its own, and awaiting `object` alone waits for ever. The
  // partial objects are unvalidated and are not used.
  for await (const partial of result.partialObjectStream) void partial;
  return DIAGNOSIS.parse(await result.object);
}

/**
 * Every resolved case still waiting for its question, oldest first.
 *
 * Not only the ones the turn that just ended resolved: a case whose question
 * failed stays `pending` until its third attempt, and this is how it is asked
 * again.
 */
export function pendingCases(knowledge: Knowledge): number[] {
  return knowledge.db
    .query<{ id: number }, []>(
      "SELECT id FROM episodes WHERE resolved_at IS NOT NULL AND distill_state = 'pending' ORDER BY id",
    )
    .all()
    .map((row) => row.id);
}

/** Build the distiller over a knowledge store. */
export function createDistiller(input: CreateDistillerInput): Distiller {
  const { knowledge, log } = input;
  const { db } = knowledge;
  const hash = new Bun.CryptoHasher('sha256').update(input.instructions).digest('hex').slice(0, 32);

  let chain: Promise<void> = Promise.resolve();
  const queued = new Set<number>();
  let inflight: AbortController | null = null;
  let closed = false;

  /**
   * Claim a case: bump its attempts in the same transaction that reads it, so
   * a launcher that dies mid-question has still spent the attempt.
   */
  function claim(id: number): EpisodeRow | null {
    return db.transaction((): EpisodeRow | null => {
      const row = db
        .query<EpisodeRow, [number]>(
          "SELECT * FROM episodes WHERE id = ? AND resolved_at IS NOT NULL AND distill_state = 'pending'",
        )
        .get(id);
      if (row === null) return null;
      db.query<null, [number]>('UPDATE episodes SET distill_attempts = distill_attempts + 1 WHERE id = ?').run(id);
      return { ...row, distill_attempts: row.distill_attempts + 1 };
    })();
  }

  /** Write the answer: the diagnosis always, a lesson only where it is warranted and clean. */
  function record(episode: EpisodeRow, answer: Diagnosis, prior: Prior | null): void {
    const notes: string[] = [];
    let missed: number | null = null;
    let lessonId: number | null = null;
    const now = Date.now();

    db.transaction(() => {
      db.query<null, [string, number]>(
        "UPDATE episodes SET diagnosis = ?, distill_state = 'done' WHERE id = ? AND distill_state = 'pending'",
      ).run(canonicalJson({ diagnosis: answer.diagnosis, reasoning: sanitise(answer.reasoning) }), episode.id);

      // The lesson the answer says is the same cause, when it names a live one.
      const same =
        answer.sameCauseAs === null
          ? null
          : db
              .query<{ id: number; status: string }, [number]>(
                "SELECT id, status FROM lessons WHERE id = ? AND status IN ('provisional', 'confirmed')",
              )
              .get(answer.sameCauseAs);
      if (answer.diagnosis === 'knowledge_not_retrieved') missed = same?.id ?? prior?.lesson.id ?? null;

      const lesson = answer.lesson;
      if (lesson === null) return;
      if (!TEACHABLE.includes(answer.diagnosis)) {
        notes.push(`a lesson came with ${answer.diagnosis}, which does not carry one; it was dropped`);
        return;
      }
      const texts = [lesson.summary, lesson.detail, ...lesson.trigger];
      const refused = texts.map(refusal).find((reason) => reason !== null);
      if (refused !== undefined && refused !== null) {
        notes.push(`the lesson was dropped because ${refused}`);
        return;
      }

      // A `method_unclear` lesson is about the instructions, which are global:
      // it is the queue a person reads before editing them, never served.
      const scope = answer.diagnosis === 'method_unclear' || lesson.scope === 'global' ? 'global' : `app:${episode.app_id}`;
      const applies = {
        stage: lesson.applies.stage ?? episode.stage,
        ...(lesson.applies.files === undefined ? {} : { files: lesson.applies.files }),
        ...(lesson.applies.routes === undefined ? {} : { routes: lesson.applies.routes }),
        signature: episode.signature,
      };
      const version =
        (db.query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM corpus_versions').get()?.v ?? 0) + 1;
      const inserted = db
        .query<
          null,
          [number, number, number | null, string, string, string, string, string, string, string, string, number, number]
        >(
          `INSERT OR IGNORE INTO lessons
             (version, status, origin, episode_id, supersedes, diagnosis, scope, applies, summary, detail, trigger,
              instructions_hash, autoapp_version, created_at, updated_at)
           VALUES (?, 'provisional', 'distilled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version,
          episode.id,
          same?.id ?? null,
          answer.diagnosis,
          scope,
          JSON.stringify(applies),
          sanitise(lesson.summary),
          sanitise(lesson.detail),
          lesson.trigger.map(sanitise).join(' '),
          hash,
          input.autoappVersion,
          now,
          now,
        );
      // The unique index on `episode_id`: a second distillation of the same
      // case is a no-op, whatever the model said the second time.
      if (inserted.changes === 0) return;
      lessonId = Number(inserted.lastInsertRowid);
      db.query<null, [number, string, string]>('INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)').run(
        lessonId,
        sanitise(lesson.summary),
        lesson.trigger.map(sanitise).join(' '),
      );
      db.query<null, [number, number, number]>(
        "INSERT INTO corpus_versions (version, lesson_id, change, at) VALUES (?, ?, 'distil', ?)",
      ).run(version, lessonId, now);

      if (same === null) return;
      if (same.status === 'provisional') {
        // Superseded and out of the index, so it is neither served nor matched.
        db.query<null, [number, number]>("UPDATE lessons SET status = 'superseded', updated_at = ? WHERE id = ?").run(now, same.id);
        db.query<null, [number]>('DELETE FROM lessons_fts WHERE rowid = ?').run(same.id);
        db.query<null, [number, number, number]>(
          "INSERT INTO corpus_versions (version, lesson_id, change, at) VALUES (?, ?, 'supersede', ?)",
        ).run(version + 1, same.id, now);
      } else {
        // A person confirmed it. An unconfirmed lesson does not overrule a
        // person: the old one keeps its status and is flagged for them.
        db.query<null, [number, number]>(
          "UPDATE lessons SET review = 'needs_review:superseded', updated_at = ? WHERE id = ? AND review IS NULL",
        ).run(now, same.id);
      }
    })();

    const where = { appId: episode.app_id };
    log.event(
      'log',
      `case ${String(episode.id)} was diagnosed ${answer.diagnosis}${lessonId === null ? '' : `; provisional lesson ${String(lessonId)}`}`,
      undefined,
      where,
    );
    for (const note of notes) log.event('log', `case ${String(episode.id)}: ${note}`, undefined, where);
    if (missed !== null) {
      log.event(
        'search',
        `case ${String(episode.id)}: lesson ${String(missed)} existed and was not retrieved`,
        { miss: 1, lessonId: missed },
        where,
      );
    }
  }

  async function distil(id: number): Promise<void> {
    let episode: EpisodeRow | null;
    try {
      episode = claim(id);
    } catch (cause) {
      log.error(`[autoapp] could not read case ${String(id)}: ${sanitise(String(cause instanceof Error ? cause.message : cause))}`);
      return;
    }
    if (episode === null) return;
    const controller = new AbortController();
    inflight = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(DISTILL_TIMEOUT_MS)]);
    try {
      const prior = priorLesson(knowledge, episode);
      const prompt = assemble(knowledge, episode, prior);
      const model = await input.model();
      const answer = await abortable(ask(model, prompt, signal), signal);
      record(episode, answer, prior);
    } catch (cause) {
      if (controller.signal.aborted && closed) {
        // Stopped with the launcher: the case stays pending for the next one.
        log.event('log', `distilling case ${String(id)} stopped with the launcher; it stays pending`, undefined, {
          appId: episode.app_id,
        });
        return;
      }
      const failed = episode.distill_attempts >= MAX_ATTEMPTS;
      try {
        if (failed) {
          db.query<null, [number]>("UPDATE episodes SET distill_state = 'failed' WHERE id = ? AND distill_state = 'pending'").run(id);
        }
      } catch {
        // The error below says what happened; the state is retried next time.
      }
      log.error(
        `[autoapp] could not distil case ${String(id)} (attempt ${String(episode.distill_attempts)} of ${String(MAX_ATTEMPTS)}${failed ? ', giving up' : ''}): ${sanitise(String(cause instanceof Error ? cause.message : cause))}`,
      );
    } finally {
      inflight = null;
    }
  }

  async function idle(): Promise<void> {
    for (;;) {
      const at = chain;
      await at;
      if (chain === at) return;
    }
  }

  return {
    enqueue(ids) {
      if (closed) return;
      for (const id of ids) {
        if (queued.has(id)) continue;
        queued.add(id);
        chain = chain.then(async () => {
          try {
            if (!closed) await distil(id);
          } finally {
            queued.delete(id);
          }
        });
      }
    },
    idle,
    async close() {
      closed = true;
      inflight?.abort(new Error('the launcher is stopping'));
      await Promise.race([idle(), Bun.sleep(CLOSE_WAIT_MS)]);
    },
  };
}
