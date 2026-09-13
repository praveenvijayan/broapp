/**
 * What the launcher's Knowledge panel reads.
 *
 * Reads only. Every function here is a query over rows something else wrote —
 * a turn's `contexts` row, its servings, the events of its run, the cases — put
 * into the shape a person can read down a column. Nothing is inferred that the
 * rows do not say, and where a row does not say something the answer is `null`
 * rather than a guess: a turn that opened no case carries no copy of its
 * request, and is shown with the words it was searched by instead.
 */
import type { RunStore } from '../host/run-store.ts';

import { blockedCount, replayEvidence, showLesson, type LessonRecord } from './cli.ts';
import { unrelatedHintCredit } from './scoring.ts';
import type { Knowledge } from './store.ts';

/** How much of one document's text a turn's detail returns. */
export const DOCUMENT_TEXT_MAX = 20_000;
/** How much of a case's problem a list returns. */
const PROBLEM_HEAD = 200;
/** How much of a request a turn row returns. */
const REQUEST_HEAD = 200;

/** One document a turn was given. */
export interface TurnDocument {
  readonly ref: string;
  readonly title: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** One lesson a turn was served, and what came of it. */
export interface TurnServing {
  readonly lessonId: number;
  readonly how: string;
  readonly included: boolean;
  /** A stored outcome, `blocked` while a build waits, `open`, or `not included`. */
  readonly outcome: string;
}

/** One turn, as the Turns view lists it. */
export interface TurnRow {
  readonly runId: string;
  readonly appId: string | null;
  readonly at: number;
  readonly corpusVersion: number;
  /** The request, when a case this turn opened kept it; otherwise `null`. */
  readonly request: string | null;
  /** The words the turn's documents were searched by, from its `search` event. */
  readonly words: readonly string[];
  readonly documents: readonly TurnDocument[];
  readonly servings: readonly TurnServing[];
  readonly counts: {
    readonly edits: number;
    readonly builds: number;
    readonly checks: number;
    readonly casesOpened: number;
    readonly casesResolved: number;
  };
  /** From the run store, when there is one and it recorded this run. */
  readonly run: { readonly steps: number; readonly ms: number | null; readonly status: string } | null;
}

/** One turn with what it was given, word for word. */
export interface TurnDetail extends TurnRow {
  readonly texts: readonly { readonly ref: string; readonly text: string; readonly cut: boolean }[];
  readonly instructions: { readonly sha256: string; readonly length: number };
  readonly systemLength: number;
}

/** One lesson, as the Lessons view lists it. */
export interface LessonListRow {
  readonly id: number;
  readonly status: string;
  readonly review: string | null;
  readonly origin: string;
  readonly diagnosis: string | null;
  readonly scope: string;
  readonly applies: unknown;
  readonly summary: string;
  readonly createdAt: number;
  readonly reviewedBy: string | null;
  readonly served: {
    readonly resolved: number;
    readonly recurred: number;
    readonly blocked: number;
    readonly inconclusive: number;
    readonly unrelated: number;
    readonly none: number;
    readonly open: number;
    readonly notIncluded: number;
  };
}

/** One case, as the Cases view lists it. */
export interface CaseRow {
  readonly id: number;
  readonly appId: string;
  readonly stage: string;
  readonly signature: string;
  readonly problem: string;
  readonly openedAt: number;
  readonly resolvedAt: number | null;
  readonly diagnosis: string | null;
  readonly distillState: string;
  readonly lessonId: number | null;
  readonly edits: number;
}

/** One case in full. */
export interface CaseDetail extends CaseRow {
  readonly runId: string;
  readonly request: string | null;
  readonly editLog: string;
  readonly reasoning: string | null;
  readonly sourceRevBefore: string;
  readonly sourceRevAfter: string | null;
  readonly releaseBefore: string | null;
  readonly releaseAfter: string | null;
}

/** A JSON column, or `null` when it does not parse. */
function json(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A string field of a parsed object. */
function field(value: unknown, name: string): string | null {
  const member = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;
  return typeof member === 'string' ? member : null;
}

/** What a document is called, from its ref: the titles `serve.ts` gives them. */
function titleOf(ref: string): string {
  const colon = ref.indexOf(':');
  const kind = colon < 0 ? ref : ref.slice(0, colon);
  const about = colon < 0 ? '' : ref.slice(colon + 1);
  if (kind === 'digest') return `Where ${about} stands`;
  if (kind === 'evidence') return `What this request touches in ${about}`;
  if (kind === 'lessons') return 'Lessons from earlier work';
  return ref;
}

interface ContextRow {
  run_id: string;
  app_id: string | null;
  corpus_version: number;
  instructions_blob: string;
  system_blob: string;
  included: string;
  at: number;
}

/** A turn's row, from its context and everything that points at its run. */
function turnOf(knowledge: Knowledge, row: ContextRow, store: RunStore | undefined): TurnRow {
  const { db } = knowledge;
  const included = json(row.included);
  const documents: TurnDocument[] = [];
  for (const item of Array.isArray(included) ? included : []) {
    const ref = field(item, 'ref');
    const blob = field(item, 'blob');
    if (ref === null) continue;
    const bytes = blob === null ? 0 : (db.query<{ bytes: number }, [string]>('SELECT bytes FROM blobs WHERE hash = ?').get(blob)?.bytes ?? 0);
    const truncated = typeof item === 'object' && item !== null && (item as { truncated?: unknown }).truncated === true;
    documents.push({ ref, title: titleOf(ref), bytes, truncated });
  }

  const blocked = (lessonId: number): boolean =>
    (db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND kind = 'log' AND message LIKE ?",
      )
      .get(row.run_id, `a serving of lesson ${String(lessonId)} waits:%`)?.n ?? 0) > 0;
  const servings = db
    .query<{ lesson_id: number; how: string; included: number; outcome: string | null }, [string]>(
      'SELECT lesson_id, how, included, outcome FROM servings WHERE run_id = ? ORDER BY id',
    )
    .all(row.run_id)
    .map((serving): TurnServing => ({
      lessonId: serving.lesson_id,
      how: serving.how,
      included: serving.included === 1,
      outcome:
        serving.included !== 1
          ? 'not included'
          : (serving.outcome ?? (blocked(serving.lesson_id) ? 'blocked' : 'open')),
    }));

  const count = (kind: string): number =>
    db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND kind = ?').get(row.run_id, kind)
      ?.n ?? 0;
  const casesOpened =
    db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM episodes WHERE run_id = ?').get(row.run_id)?.n ?? 0;
  const casesResolved =
    db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM episodes WHERE resolved_run_id = ?').get(row.run_id)?.n ?? 0;

  const opened = db
    .query<{ request_blob: string }, [string]>('SELECT request_blob FROM episodes WHERE run_id = ? ORDER BY id LIMIT 1')
    .get(row.run_id);
  const request = opened === null ? null : (knowledge.getBlob(opened.request_blob)?.slice(0, REQUEST_HEAD) ?? null);
  const search = db
    .query<{ data: string | null }, [string]>("SELECT data FROM events WHERE run_id = ? AND kind = 'search' ORDER BY id LIMIT 1")
    .get(row.run_id);
  const tokens = (json(search?.data ?? null) as { tokens?: unknown } | null)?.tokens;
  const words = Array.isArray(tokens) ? tokens.filter((word): word is string => typeof word === 'string') : [];

  let run: TurnRow['run'] = null;
  const recorded = store?.getRun(row.run_id) ?? null;
  if (recorded !== null) {
    run = {
      steps: recorded.steps.length,
      ms: recorded.run.endedAt === null ? null : recorded.run.endedAt - recorded.run.startedAt,
      status: recorded.run.status,
    };
  }

  return {
    runId: row.run_id,
    appId: row.app_id,
    at: row.at,
    corpusVersion: row.corpus_version,
    request,
    words,
    documents,
    servings,
    counts: { edits: count('edit'), builds: count('build'), checks: count('check'), casesOpened, casesResolved },
    run,
  };
}

/** The newest turns first. */
export function knowledgeTurns(
  knowledge: Knowledge,
  filter: { readonly limit?: number; readonly appId?: string },
  store?: RunStore,
): TurnRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
  const rows =
    filter.appId === undefined
      ? knowledge.db
          .query<ContextRow, [number]>('SELECT * FROM contexts ORDER BY at DESC, id DESC LIMIT ?')
          .all(limit)
      : knowledge.db
          .query<ContextRow, [string, number]>('SELECT * FROM contexts WHERE app_id = ? ORDER BY at DESC, id DESC LIMIT ?')
          .all(filter.appId, limit);
  return rows.map((row) => turnOf(knowledge, row, store));
}

/** One turn, with the text of every document it was given; `null` when there is no such turn. */
export function knowledgeTurn(knowledge: Knowledge, runId: string, store?: RunStore): TurnDetail | null {
  const row = knowledge.db.query<ContextRow, [string]>('SELECT * FROM contexts WHERE run_id = ?').get(runId);
  if (row === null) return null;
  const turn = turnOf(knowledge, row, store);
  const included = json(row.included);
  const texts: TurnDetail['texts'][number][] = [];
  for (const item of Array.isArray(included) ? included : []) {
    const ref = field(item, 'ref');
    const blob = field(item, 'blob');
    if (ref === null || blob === null) continue;
    const content = knowledge.getBlob(blob) ?? '';
    texts.push({ ref, text: content.slice(0, DOCUMENT_TEXT_MAX), cut: content.length > DOCUMENT_TEXT_MAX });
  }
  const instructions = knowledge.getBlob(row.instructions_blob) ?? '';
  const system = knowledge.getBlob(row.system_blob) ?? '';
  return {
    ...turn,
    texts,
    // The blob is named by the hash of its bytes, so the name is the hash.
    instructions: { sha256: row.instructions_blob, length: instructions.length },
    systemLength: system.length,
  };
}

/** Every lesson, oldest first, with how its servings came out. */
export function knowledgeLessons(
  knowledge: Knowledge,
  filter: { readonly status?: string; readonly review?: boolean },
): LessonListRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.review === true) clauses.push('review IS NOT NULL');
  if (filter.review === false) clauses.push('review IS NULL');
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  const rows = knowledge.db
    .query<
      {
        id: number;
        status: string;
        review: string | null;
        origin: string;
        diagnosis: string | null;
        scope: string;
        applies: string;
        summary: string;
        created_at: number;
        reviewed_by: string | null;
      },
      string[]
    >(
      `SELECT id, status, review, origin, diagnosis, scope, applies, summary, created_at, reviewed_by FROM lessons${where} ORDER BY id`,
    )
    .all(...params);
  return rows.map((row) => {
    const outcomes = knowledge.db
      .query<{ outcome: string | null; included: number; n: number }, [number]>(
        'SELECT outcome, included, COUNT(*) AS n FROM servings WHERE lesson_id = ? GROUP BY outcome, included',
      )
      .all(row.id);
    const count = (outcome: string): number =>
      outcomes.filter((entry) => entry.included === 1 && entry.outcome === outcome).reduce((sum, entry) => sum + entry.n, 0);
    return {
      id: row.id,
      status: row.status,
      review: row.review,
      origin: row.origin,
      diagnosis: row.diagnosis,
      scope: row.scope,
      applies: json(row.applies),
      summary: row.summary,
      createdAt: row.created_at,
      reviewedBy: row.reviewed_by,
      served: {
        resolved: count('resolved'),
        recurred: count('recurred'),
        blocked: blockedCount(knowledge, row.id),
        inconclusive: count('inconclusive'),
        unrelated: count('unrelated'),
        none: count('none'),
        open: outcomes.filter((entry) => entry.included === 1 && entry.outcome === null).reduce((sum, entry) => sum + entry.n, 0),
        notIncluded: outcomes.filter((entry) => entry.included !== 1).reduce((sum, entry) => sum + entry.n, 0),
      },
    };
  });
}

/** One lesson in full, as `knowledge show` prints it; `null` when there is none. */
export function knowledgeLesson(
  knowledge: Knowledge,
  id: number,
): { lesson: LessonRecord; blocked: number; unrelatedByStage: number; evidence: string[] } | null {
  const lesson = showLesson(knowledge, id);
  if (lesson === null) return null;
  return {
    lesson,
    blocked: blockedCount(knowledge, id),
    unrelatedByStage: unrelatedHintCredit(knowledge, id).byStage,
    evidence: replayEvidence(knowledge, id),
  };
}

interface EpisodeListRow {
  id: number;
  app_id: string;
  stage: string;
  signature: string;
  problem: string;
  request_blob: string;
  run_id: string;
  edits: string;
  opened_at: number;
  resolved_at: number | null;
  source_rev_before: string;
  source_rev_after: string | null;
  release_before: string | null;
  release_after: string | null;
  diagnosis: string | null;
  distill_state: string;
}

/** A case's row; `problemMax` is how much of its problem to keep. */
function caseOf(knowledge: Knowledge, row: EpisodeListRow, problemMax: number): CaseRow {
  const lessonId =
    knowledge.db.query<{ id: number }, [number]>('SELECT id FROM lessons WHERE episode_id = ?').get(row.id)?.id ?? null;
  return {
    id: row.id,
    appId: row.app_id,
    stage: row.stage,
    signature: row.signature,
    problem: row.problem.slice(0, problemMax),
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    diagnosis: field(json(row.diagnosis), 'diagnosis'),
    distillState: row.distill_state,
    lessonId,
    // Each appended edit is separated from the last by one blank line, which is
    // how `appendEdit` joins them.
    edits: row.edits === '' ? 0 : row.edits.split('\n\n').length,
  };
}

/** The newest cases first. */
export function knowledgeCases(knowledge: Knowledge, filter: { readonly limit?: number; readonly appId?: string }): CaseRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
  const rows =
    filter.appId === undefined
      ? knowledge.db
          .query<EpisodeListRow, [number]>('SELECT * FROM episodes ORDER BY opened_at DESC, id DESC LIMIT ?')
          .all(limit)
      : knowledge.db
          .query<EpisodeListRow, [string, number]>(
            'SELECT * FROM episodes WHERE app_id = ? ORDER BY opened_at DESC, id DESC LIMIT ?',
          )
          .all(filter.appId, limit);
  return rows.map((row) => caseOf(knowledge, row, PROBLEM_HEAD));
}

/** One case in full; `null` when there is none. */
export function knowledgeCase(knowledge: Knowledge, id: number): CaseDetail | null {
  const row = knowledge.db.query<EpisodeListRow, [number]>('SELECT * FROM episodes WHERE id = ?').get(id);
  if (row === null) return null;
  return {
    ...caseOf(knowledge, row, row.problem.length),
    runId: row.run_id,
    request: knowledge.getBlob(row.request_blob),
    editLog: row.edits,
    reasoning: field(json(row.diagnosis), 'reasoning'),
    sourceRevBefore: row.source_rev_before,
    sourceRevAfter: row.source_rev_after,
    releaseBefore: row.release_before,
    releaseAfter: row.release_after,
  };
}
