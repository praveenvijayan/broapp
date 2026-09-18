/**
 * Serving what the launcher knows to the engineer's turn.
 *
 * The AI layer's context providers are the one door: `search` names the
 * documents a turn should have, `resolve` renders them, and the AI layer fits
 * them into its budget and puts them under the Rules that say documents are
 * data. The orientation, the task evidence, the lessons the request's words
 * match, and, for a builder's turn in a backlog run, what the task's earlier
 * attempts did — and nothing from here reaches the instructions, which stay
 * the one trusted statement of how to work.
 *
 * A builder's turn is known by its exact run id (14a): the backlog records
 * which task each run built, and `search` looks the run up. Its lessons are
 * then chosen by fixed rules — pinned, then at most two that share a file with
 * the task, then the task's own words — and never by any outcome.
 *
 * A serving is written only once `onContext` shows what was delivered. A
 * lesson that was found, rendered and then cut by the budget was never seen by
 * the model, and is recorded as `included = 0` so that nothing later credits
 * or blames it for a turn it took no part in.
 *
 * Lessons come from two places: the curated seeds, and lessons distilled from
 * resolved cases (12c), which stay provisional until a person confirms them and
 * are labelled so. A lesson distilled as `method_unclear` is never served: it
 * is a note that the instructions need a person's attention, and a document
 * that amended the instructions would be a second method beside the first.
 */
import type { AiContextProviders, ContextDocument, ContextRef, DeliveredContext } from 'broapp/ai/host';

import type { CandidateStates } from '../engineer/state.ts';
import type { IntentStore, TaskRecord } from '../intent/index.ts';
import type { AppRow } from '../launcher/apps.ts';
import type { BuildProblem } from '../launcher/candidate.ts';
import type { Layout } from '../spec/index.ts';

import { attemptsDocument, attemptsInput } from './attempts.ts';
import { sourceRevision, type FullOrigin } from './ids.ts';
import { stagesFor } from './links.ts';
import type { EventLog } from './log.ts';
import { indexWorkspace, orientation, taskEvidence, type SymbolIndex, type TaskEvidence } from './path.ts';
import { problemSignature } from './scoring.ts';
import { seedLessons } from './seed.ts';
import type { Session } from './session.ts';
import { ftsQuery, tokens, type Knowledge } from './store.ts';

/** A fact returned beside a build failure. */
export interface Hint {
  readonly lessonId: number;
  readonly status: 'confirmed' | 'provisional';
  readonly text: string;
  /** Why a person should look at it again, when somebody should. */
  readonly review?: string;
}

/** What a turn was served, for its `contexts` row. */
export interface ServedTurn {
  readonly appId: string | null;
  readonly requested: readonly string[];
  readonly resolved: readonly string[];
}

/** The launcher's context providers, and the bookkeeping around them. */
export interface Serve extends AiContextProviders {
  /** The documents a turn should have: its application's two, then matching lessons. */
  search(query: { text: string; limit: number; runId?: string }, signal: AbortSignal): Promise<ContextRef[]>;
  /** Render them. Refs this serving does not know are skipped. */
  resolve(refs: readonly string[], signal: AbortSignal): Promise<ContextDocument[]>;
  /**
   * Called from the tab's `onContext`, with what was actually delivered: writes
   * the servings and the `search` event, and returns what the `contexts` row
   * records. The row itself is written by the tab afterwards, from the same
   * delivered documents, so both see the same `included`.
   */
  delivered(runId: string, delivered: DeliveredContext): ServedTurn;
  /**
   * A turn has ended: forget whatever it was offered and never delivered.
   *
   * A turn that throws between `search` and `onContext` never reaches
   * `delivered`, and without this its entry would stay for the life of the
   * launcher.
   */
  ended(runId: string): void;
  /** How many turns are between `search` and `delivered`. For tests. */
  inFlight(): number;
  /** Facts matching a build's problems, each recorded as a serving. */
  hints(appId: string, problems: readonly BuildProblem[], origin: FullOrigin): readonly Hint[];
}

/**
 * Which lessons a serving may offer.
 *
 * The launcher serves every lesson it holds. A replay freezes the corpus to the
 * one lesson under test, or to nothing, so that what it measures is that lesson
 * and not whatever else a person happened to have confirmed since; the
 * evaluation compares corpora the same way.
 */
export interface Corpus {
  /**
   * Lessons given to every turn about an application, whatever its words, and
   * hinted beside a failure of their stage. A replay pins the lesson under test.
   */
  readonly pinned?: readonly number[];
  /** Which other lessons may match: all of them (the default), the curated seeds, the confirmed ones, or none. */
  readonly match?: 'all' | 'curated' | 'confirmed' | 'none';
  /**
   * Whether a task's turn may be given lessons that share a file with the
   * task (the second tier). Defaults to `true`; a replay or an evaluation
   * turns it off to measure without it.
   */
  readonly related?: boolean;
}

/** Which of an application's documents a turn is given. All of them, unless said otherwise. */
export interface ServedDocuments {
  readonly digest: boolean;
  readonly evidence: boolean;
  /** What a task's earlier attempts did, for a builder's retry. Defaults to `true`. */
  readonly attempts?: boolean;
}

/**
 * Why a document was in a turn: the closed list the `search` event records.
 * `related:<file>` names the file the lesson and the task share.
 */
export type WhyReason = 'application' | 'backlog' | 'attempts' | 'pinned' | 'words' | `related:${string}`;

/** What {@link createServe} needs. */
export interface CreateServeInput {
  readonly knowledge: Knowledge;
  readonly log: EventLog;
  readonly layout: Layout;
  readonly states: CandidateStates;
  readonly session: Session;
  /** The engineer's instructions, which the seeded lessons are recorded against. */
  readonly instructions: string;
  /** Every application, as the launcher's own list has them. */
  readonly apps: () => readonly AppRow[];
  /** Which lessons may be served. Defaults to every one. */
  readonly corpus?: Corpus;
  readonly documents?: ServedDocuments;
  /**
   * Whether the curated seeds are written into the store. Defaults to `true`;
   * a replay's store holds only the lesson under test.
   */
  readonly seed?: boolean;
  /**
   * The backlog. Present, a turn about an application with an unfinished
   * intent is given its state, after the orientation.
   */
  readonly intents?: IntentStore;
}

/** The most a backlog document may be. */
export const BACKLOG_DOCUMENT_CHARS = 1_500;

/** The first line of whatever a failed task recorded about its failure. */
function failureLine(failure: unknown): string | null {
  if (failure === null || failure === undefined) return null;
  const text =
    typeof failure === 'string'
      ? failure
      : typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string'
        ? failure.message
        : JSON.stringify(failure);
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '');
  return first === undefined ? null : first.trim().slice(0, 160);
}

/**
 * The backlog of one application as the engineer is given it, or `null` when
 * it has nothing unfinished.
 *
 * Every live intent — a draft, one running, one stopped — newest first: its
 * status, its open questions, then one line per task with its slug, status,
 * tier and title, and a failed task's reason. This is how the model keeps
 * track of a backlog across turns without being asked to remember one, so it
 * is short, and cut at a line rather than mid-word.
 */
export function backlogDocument(intents: IntentStore, appId: string): string | null {
  const live = intents.live(appId);
  if (live.length === 0) return null;
  const lines: string[] = [];
  for (const intent of live) {
    const writing = intent.status === 'draft' && intent.submittedAt === null ? ', being written' : '';
    lines.push(`Intent ${String(intent.id)} (${intent.status}${writing}): ${intent.restated ?? intent.request.slice(0, 120)}`);
    if (intent.questions.length > 0) {
      lines.push('Open questions:', ...intent.questions.map((question) => `- ${question}`));
    }
    const tasks = intents.runOrder(intent.id).filter((task: TaskRecord) => task.stored !== 'removed');
    if (tasks.length === 0) lines.push('No tasks yet.');
    for (const task of tasks) {
      const reason = task.status === 'failed' ? failureLine(task.failure) : null;
      lines.push(`- ${task.slug} · ${task.status} · ${task.tier} · ${task.title}${reason === null ? '' : ` — failed: ${reason}`}`);
    }
  }
  const out: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > BACKLOG_DOCUMENT_CHARS - 2) {
      out.push('…');
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join('\n');
}

/** How many lessons one turn may be given, and one build problem. */
const TURN_LESSONS = 3;
const HINTS_PER_PROBLEM = 2;
const MAX_HINTS = 3;
/** How many full-text matches a turn looks through for three strong ones. */
const TURN_CANDIDATES = 24;
/** How many distinct request words a lesson must share to be served on words alone. */
const TURN_MIN_SHARED = 2;
/** A turn that has neither delivered nor ended after this long is forgotten. */
const TURN_TTL_MS = 3_600_000;

interface LessonHit {
  id: number;
  status: 'confirmed' | 'provisional';
  review: string | null;
  summary: string;
  trigger: string;
  applies: string;
}

/** A lesson chosen for a turn, and the tier that chose it. */
interface ChosenLesson extends LessonHit {
  reason: WhyReason;
}

/** How many lessons the second tier — a shared file — may give one task. */
const TURN_RELATED = 2;

/** What one turn has been offered so far. */
interface Turn {
  readonly appId: string | null;
  /** The task a builder's turn is building, found by its run id; `null` for any other turn. */
  readonly task: TaskRecord | null;
  /** The attempts document, rendered once in `search`. */
  readonly attempts: string | null;
  readonly tokens: readonly string[];
  readonly lessons: readonly ChosenLesson[];
  /** Why each offered ref was offered. */
  readonly why: ReadonlyMap<string, WhyReason>;
  /** Computed once in `search`, rendered in `resolve`: the same words, the same answer. */
  readonly evidence: TaskEvidence | null;
  readonly at: number;
  requested: string[];
  resolved: string[];
}

/** "(provisional)", "(needs review: recurring)", both, or nothing. */
function labelOf(lesson: { status: string; review: string | null }): string {
  let label = lesson.status === 'provisional' ? ' (provisional)' : '';
  if (lesson.review !== null) label += ` (needs review: ${lesson.review.replace(/^needs_review:/, '')})`;
  return label;
}

/** The line a lesson is rendered as; also how its delivery is recognised. */
function bullet(lesson: LessonHit): string {
  return `- ${lesson.summary}${labelOf(lesson)}`;
}

/** The words of a text as FTS5's `unicode61` tokenizer splits them, near enough. */
function wordsOf(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ''));
}

/** A lesson's `applies.<field>`, as a list of strings. */
function appliesList(applies: string, field: 'routes' | 'files'): readonly string[] {
  try {
    const value = (JSON.parse(applies) as Record<string, unknown>)[field];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Whether a lesson matched a request by more than one shared word.
 *
 * Full-text search joins the request's words with `OR`, because `AND` would
 * match nothing; the price is that one common word is a match. In 12b's rerun
 * "list" served the migration seed to a request about tags. So a turn keeps a
 * lesson only when two distinct request words occur in its summary or trigger,
 * or when a route it applies to is one the task evidence also names.
 */
function strongMatch(lesson: LessonHit, words: readonly string[], routes: ReadonlySet<string>): boolean {
  if (appliesList(lesson.applies, 'routes').some((route) => routes.has(route))) return true;
  const own = wordsOf(`${lesson.summary} ${lesson.trigger}`);
  return words.filter((word) => own.has(word)).length >= TURN_MIN_SHARED;
}

/** A task's own words: its title, summary and criteria, never the builder's fixed sentences. */
function taskText(task: TaskRecord): string {
  return [task.title, task.summary, ...task.criteria.map((criterion) => criterion.text)].join('\n');
}

/** A lesson's `applies.stage`, or `null`. */
function stageOf(applies: string): string | null {
  try {
    const stage = (JSON.parse(applies) as { stage?: unknown }).stage;
    return typeof stage === 'string' ? stage : null;
  } catch {
    return null;
  }
}

/** `\b` for identifiers that may contain a hyphen. */
function namesId(text: string, appId: string): boolean {
  const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`).test(text);
}

/** Build the launcher's serving over its knowledge store. */
export function createServe(input: CreateServeInput): Serve {
  const { knowledge, log, layout, states, session } = input;
  const { db } = knowledge;
  const match = input.corpus?.match ?? 'all';
  // Integers by type and by check, because they are written into the SQL below.
  const pinned = (input.corpus?.pinned ?? []).filter((id) => Number.isInteger(id) && id > 0);
  const documents: ServedDocuments = input.documents ?? { digest: true, evidence: true };

  if (input.seed !== false) {
    try {
      seedLessons(knowledge, input.instructions);
    } catch (cause) {
      log.error(`[autoapp] the starting lessons could not be written: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  }

  const turns = new Map<string, Turn>();
  /**
   * Which turn asked for a ref most recently.
   *
   * `resolve` is not told the run it resolves for. The AI layer calls it
   * immediately after that turn's `search`, so the most recent asker of a ref
   * is the turn it belongs to; two turns about the same application would have
   * to interleave between those two calls to confuse it.
   */
  const askedBy = new Map<string, string>();
  const indexes = new Map<string, SymbolIndex>();

  /** Forget one turn and every ref it asked for. */
  function forget(runId: string): void {
    turns.delete(runId);
    for (const [ref, owner] of askedBy) if (owner === runId) askedBy.delete(ref);
  }

  /** A workspace's symbols, recomputed when its revision moves and every time when it has none. */
  function indexOf(appId: string): SymbolIndex {
    const source = layout.app(appId).source;
    const rev = sourceRevision(source);
    const cached = indexes.get(appId);
    if (cached !== undefined && cached.rev === rev && rev !== 'no-git') return cached;
    const fresh = indexWorkspace(source, rev);
    indexes.set(appId, fresh);
    return fresh;
  }

  /**
   * Which application a message is about: the one its first line declares as
   * `Application: <appId>`, else the one it names, else the one the person or
   * the engineer last chose, else the only one there is.
   *
   * The declaration comes first because a backlog run writes one into every
   * builder's message, above a plan whose own words may name another
   * application: 13c's tests watched "an empty list" serve a turn about
   * `items` with the documents of an application called `empty`.
   */
  function chooseApp(text: string, words: readonly string[], rows: readonly AppRow[]): string | null {
    const declared = /^Application: (\S+)\s*$/.exec(text.split('\n', 1)[0] ?? '')?.[1];
    if (declared !== undefined && rows.some((row) => row.appId === declared)) return declared;
    const lower = text.toLowerCase();
    const byId = rows.find((row) => namesId(lower, row.appId));
    if (byId !== undefined) return byId.appId;
    const byName = rows.find((row) => tokens(row.name).some((word) => words.includes(word)));
    if (byName !== undefined) return byName.appId;
    const selected = session.get().selectedAppId;
    if (selected !== null && rows.some((row) => row.appId === selected)) return selected;
    return rows.length === 1 ? (rows[0]?.appId ?? null) : null;
  }

  /** The SQL that admits a lesson from the corpus, or from the pinned list. */
  function admitted(from: 'corpus' | 'pinned'): string | null {
    if (from === 'pinned') return pinned.length === 0 ? null : `l.id IN (${pinned.map(String).join(', ')})`;
    if (match === 'none') return null;
    if (match === 'curated') return "l.origin = 'curated'";
    if (match === 'confirmed') return "l.status = 'confirmed'";
    return '1 = 1';
  }

  /**
   * Lessons matching a text: confirmed ranked above provisional, never a
   * `method_unclear` one, global or this application's own, and, for a build
   * problem, only those about exactly its stage.
   *
   * A lesson with no stage is never a hint. Report 12c watched the MCP seed,
   * which names no stage, be hinted for a contract failure through the one word
   * "effect" and then credited `resolved` beside the lesson that actually
   * applied; a hint is a claim about the part of the build that failed, and a
   * lesson that names no part cannot make it. Such a lesson can still be served
   * to a turn, where its words have to earn it.
   */
  function findLessons(
    text: string,
    appId: string | null,
    limit: number,
    stage?: string,
    from: 'corpus' | 'pinned' = 'corpus',
  ): LessonHit[] {
    const query = ftsQuery(text);
    const admit = admitted(from);
    if (query === null || admit === null) return [];
    return db
      .query<LessonHit, [string, string, string | null, string | null, number]>(
        `SELECT l.id, l.status, l.review, l.summary, l.trigger, l.applies
           FROM lessons_fts JOIN lessons l ON l.id = lessons_fts.rowid
          WHERE lessons_fts MATCH ?
            AND ${admit}
            AND l.status IN ('confirmed', 'provisional')
            AND (l.diagnosis IS NULL OR l.diagnosis <> 'method_unclear')
            AND (l.scope = 'global' OR l.scope = ?)
            AND (? IS NULL OR json_extract(l.applies, '$.stage') = ?)
          -- bm25 is negative and the sort ascends, so the best match is the most
          -- negative. Every factor in this product is positive and larger means
          -- better, which is why multiplying by 0.6 moves a provisional lesson
          -- down. Never add a term here by addition, or a factor that can be
          -- zero or negative: either would invert or erase the order.
          ORDER BY bm25(lessons_fts, 1.0, 2.0) * CASE l.status WHEN 'confirmed' THEN 1.0 ELSE 0.6 END
          LIMIT ?`,
      )
      .all(query, appId === null ? '' : `app:${appId}`, stage ?? null, stage ?? null, limit);
  }

  /** The pinned lessons that may be served to a turn about this application, words or not. */
  function pinnedLessons(appId: string): LessonHit[] {
    const admit = admitted('pinned');
    if (admit === null) return [];
    return db
      .query<LessonHit, [string]>(
        `SELECT l.id, l.status, l.review, l.summary, l.trigger, l.applies FROM lessons l
          WHERE ${admit}
            AND l.status IN ('confirmed', 'provisional')
            AND (l.diagnosis IS NULL OR l.diagnosis <> 'method_unclear')
            AND (l.scope = 'global' OR l.scope = ?)
          ORDER BY l.id`,
      )
      .all(`app:${appId}`);
  }

  /**
   * Lessons distilled from a case that edited a file this task edited in an
   * earlier attempt or planned in its `locks`: the second tier, read from the
   * relationship index. The same admission, status, `method_unclear` and scope
   * rules as {@link findLessons}; confirmed before provisional, then newest.
   * Each comes with the file it shares.
   *
   * File overlap is a signal, not proof: two changes to one file can be about
   * different things, which is why this tier is capped and sits under pinned.
   */
  function relatedLessons(appId: string, slug: string, limit: number): (LessonHit & { file: string })[] {
    const admit = admitted('corpus');
    if (admit === null || limit <= 0) return [];
    const rows = db
      .query<LessonHit & { file: string }, [string, string, string]>(
        `SELECT l.id, l.status, l.review, l.summary, l.trigger, l.applies, mine.dst_id AS file
           FROM links mine
           JOIN links touched ON touched.app_id = mine.app_id AND touched.src_kind = 'case' AND touched.rel = 'edited'
                              AND touched.dst_kind = 'file' AND touched.dst_id = mine.dst_id
           JOIN links taught ON taught.app_id = mine.app_id AND taught.src_kind = 'lesson' AND taught.rel = 'distilled_from'
                             AND taught.dst_kind = 'case' AND taught.dst_id = touched.src_id
           JOIN lessons l ON l.id = CAST(taught.src_id AS INTEGER)
          WHERE mine.app_id = ? AND mine.src_kind = 'task' AND mine.src_id = ?
            AND mine.rel IN ('edited', 'planned') AND mine.dst_kind = 'file'
            AND ${admit}
            AND l.status IN ('confirmed', 'provisional')
            AND (l.diagnosis IS NULL OR l.diagnosis <> 'method_unclear')
            AND (l.scope = 'global' OR l.scope = ?)
          ORDER BY CASE l.status WHEN 'confirmed' THEN 0 ELSE 1 END, l.created_at DESC, l.id DESC, mine.dst_id`,
      )
      .all(appId, slug, `app:${appId}`);
    const out: (LessonHit & { file: string })[] = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!out.some((held) => held.id === row.id)) out.push(row);
    }
    return out;
  }

  /**
   * A task's lessons, in three tiers filled in order up to {@link TURN_LESSONS},
   * no lesson twice: pinned; at most {@link TURN_RELATED} sharing a file; then
   * the task's own words, a lesson about a stage its labels point at first.
   */
  function taskLessons(task: TaskRecord, appId: string, routes: ReadonlySet<string>): ChosenLesson[] {
    const chosen: ChosenLesson[] = [];
    const take = (lesson: LessonHit, reason: WhyReason): void => {
      if (chosen.length < TURN_LESSONS && !chosen.some((held) => held.id === lesson.id)) chosen.push({ ...lesson, reason });
    };
    for (const lesson of pinnedLessons(appId)) take(lesson, 'pinned');
    if (input.corpus?.related !== false) {
      for (const lesson of relatedLessons(appId, task.slug, TURN_RELATED)) take(lesson, `related:${lesson.file}`);
    }
    const text = taskText(task);
    const words = tokens(text);
    const stages = stagesFor(task.labels);
    const matched = findLessons(text, appId, TURN_CANDIDATES).filter((lesson) => strongMatch(lesson, words, routes));
    // A stable sort: within each half, full-text order stands.
    const ordered = [
      ...matched.filter((lesson) => stages.has(stageOf(lesson.applies) ?? '')),
      ...matched.filter((lesson) => !stages.has(stageOf(lesson.applies) ?? '')),
    ];
    for (const lesson of ordered) take(lesson, 'words');
    return chosen;
  }

  /** Write one serving; the unique index makes a repeat a no-op. */
  function serving(row: {
    lessonId: number;
    runId: string;
    appId: string;
    how: 'turn' | 'hint';
    forSignature: string;
    forStage: string;
    included: boolean;
  }): void {
    db.query<null, [number, string, string, string, string, string, number, number]>(
      `INSERT OR IGNORE INTO servings
         (lesson_id, run_id, app_id, how, for_signature, for_stage, for_example_hash, included, served_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
    ).run(row.lessonId, row.runId, row.appId, row.how, row.forSignature, row.forStage, row.included ? 1 : 0, Date.now());
  }

  /** Render one of this application's documents, or nothing when the ref is not one. */
  function render(ref: string, rows: readonly AppRow[]): ContextDocument | null {
    const colon = ref.indexOf(':');
    const kind = ref.slice(0, colon);
    const appId = ref.slice(colon + 1);
    if (!rows.some((row) => row.appId === appId)) return null;
    const turn = turns.get(askedBy.get(ref) ?? '');
    if (kind === 'digest') {
      return { ref, title: `Where ${appId} stands`, content: orientation({ layout, appId, states, apps: rows }).text };
    }
    if (kind === 'intent') {
      const text = input.intents === undefined ? null : backlogDocument(input.intents, appId);
      return text === null ? null : { ref, title: `The backlog for ${appId}`, content: text };
    }
    if (kind === 'attempts') {
      if (turn?.task === null || turn?.task === undefined || turn.attempts === null) return null;
      return { ref, title: `Earlier attempts at ${turn.task.slug}`, content: turn.attempts };
    }
    if (kind === 'evidence') {
      const evidence =
        turn?.evidence ?? taskEvidence({ layout, appId, tokens: turn?.tokens ?? [], index: indexOf(appId) });
      return { ref, title: `What this request touches in ${appId}`, content: evidence.text };
    }
    return null;
  }

  return {
    search(query) {
      try {
        const now = Date.now();
        for (const [runId, turn] of turns) if (now - turn.at > TURN_TTL_MS) forget(runId);
        const words = tokens(query.text);
        const rows = input.apps();
        // A builder's turn is found by its exact run id, which the executor
        // wrote into the backlog before the turn began. Its task names its
        // application; the message's first line is for every other caller.
        const task =
          query.runId === undefined || input.intents === undefined ? null : input.intents.taskForRun(query.runId);
        const appId = task !== null ? task.appId : chooseApp(query.text, words, rows);
        const evidence = appId === null ? null : taskEvidence({ layout, appId, tokens: words, index: indexOf(appId) });
        const routes = new Set(
          (evidence?.entries ?? []).filter((entry) => entry.kind === 'route').map((entry) => entry.name),
        );
        const lessons: ChosenLesson[] = [];
        if (appId !== null && task !== null) {
          lessons.push(...taskLessons(task, appId, routes));
        } else if (appId !== null) {
          const matched = findLessons(query.text, appId, TURN_CANDIDATES).filter((lesson) =>
            strongMatch(lesson, words, routes),
          );
          const pinnedHere = pinnedLessons(appId);
          for (const lesson of [...pinnedHere, ...matched]) {
            if (lessons.length < TURN_LESSONS && !lessons.some((held) => held.id === lesson.id)) {
              lessons.push({ ...lesson, reason: pinnedHere.includes(lesson) ? 'pinned' : 'words' });
            }
          }
        }
        const attempts =
          appId === null || task === null || input.intents === undefined || documents.attempts === false
            ? null
            : attemptsDocument(attemptsInput(knowledge, input.intents, task, query.runId ?? null));
        const why = new Map<string, WhyReason>();
        const refs: ContextRef[] =
          appId === null
            ? []
            : [
                ...(documents.digest ? [{ ref: `digest:${appId}`, title: `Where ${appId} stands` }] : []),
                // Second: for a retry this is the document worth most, and the
                // budget cuts from the end.
                ...(attempts !== null && task !== null
                  ? [{ ref: `attempts:${appId}`, title: `Earlier attempts at ${task.slug}` }]
                  : []),
                ...(input.intents !== undefined && input.intents.live(appId).length > 0
                  ? [{ ref: `intent:${appId}`, title: `The backlog for ${appId}` }]
                  : []),
                ...(documents.evidence
                  ? [{ ref: `evidence:${appId}`, title: `What this request touches in ${appId}` }]
                  : []),
                ...lessons.map((lesson) => ({ ref: `lesson:${String(lesson.id)}`, title: 'A lesson from earlier work' })),
              ];
        if (appId !== null) {
          why.set(`digest:${appId}`, 'application');
          why.set(`attempts:${appId}`, 'attempts');
          why.set(`intent:${appId}`, 'backlog');
          why.set(`evidence:${appId}`, 'application');
        }
        for (const lesson of lessons) why.set(`lesson:${String(lesson.id)}`, lesson.reason);
        const offered = refs.slice(0, query.limit);
        if (query.runId !== undefined) {
          turns.set(query.runId, {
            appId,
            task,
            attempts,
            tokens: words,
            lessons,
            why,
            evidence,
            at: now,
            requested: offered.map((ref) => ref.ref),
            resolved: [],
          });
          for (const ref of offered) askedBy.set(ref.ref, query.runId);
        }
        return Promise.resolve(offered);
      } catch (cause) {
        // Knowledge is a help, never a reason for a turn to fail.
        log.error(`[autoapp] a turn's documents could not be found: ${String(cause instanceof Error ? cause.message : cause)}`);
        return Promise.resolve([]);
      }
    },

    resolve(refs) {
      const out: ContextDocument[] = [];
      try {
        const rows = input.apps();
        const lessonRefs: string[] = [];
        for (const ref of refs) {
          if (ref.startsWith('lesson:')) {
            lessonRefs.push(ref);
            continue;
          }
          const document = render(ref, rows);
          if (document === null) continue;
          out.push(document);
          turns.get(askedBy.get(ref) ?? '')?.resolved.push(ref);
        }
        // One document for all of a turn's lessons, after the other two, so the
        // budget cuts it first.
        const turn = turns.get(askedBy.get(lessonRefs[0] ?? '') ?? '');
        const lessons = (turn?.lessons ?? []).filter((lesson) => lessonRefs.includes(`lesson:${String(lesson.id)}`));
        if (turn !== undefined && lessons.length > 0) {
          out.push({
            ref: `lessons:${turn.appId ?? 'global'}`,
            title: 'Lessons from earlier work',
            content: ['Lessons from earlier work', ...lessons.map(bullet)].join('\n'),
          });
          for (const lesson of lessons) turn.resolved.push(`lesson:${String(lesson.id)}`);
        }
      } catch (cause) {
        log.error(`[autoapp] a turn's documents could not be rendered: ${String(cause instanceof Error ? cause.message : cause)}`);
      }
      return Promise.resolve(out);
    },

    delivered(runId, delivered) {
      const turn = turns.get(runId);
      forget(runId);
      if (turn === undefined) return { appId: null, requested: [], resolved: [] };

      const included = delivered.documents.map((document) => document.ref);
      const lessonsDocument = delivered.documents.find((document) => document.ref.startsWith('lessons:'));
      // Why each delivered document was there: one entry per delivered
      // document, and per lesson whose whole line reached the model.
      const why: { ref: string; reason: WhyReason }[] = [];
      for (const ref of included) {
        const reason = turn.why.get(ref);
        if (reason !== undefined) why.push({ ref, reason });
      }
      for (const lesson of turn.lessons) {
        if (!turn.resolved.includes(`lesson:${String(lesson.id)}`)) continue;
        // Included only when its whole line reached the model: a lesson cut in
        // half by the budget was not delivered as written.
        const reached = lessonsDocument?.content.split('\n').includes(bullet(lesson)) === true;
        if (reached) why.push({ ref: `lesson:${String(lesson.id)}`, reason: lesson.reason });
        let stage = '';
        try {
          const applies = JSON.parse(lesson.applies) as { stage?: unknown };
          if (typeof applies.stage === 'string') stage = applies.stage;
        } catch {
          // No stage: the serving waits for no particular one.
        }
        serving({
          lessonId: lesson.id,
          runId,
          appId: turn.appId ?? '',
          how: 'turn',
          forSignature: '',
          forStage: stage,
          included: reached,
        });
      }
      log.event(
        'search',
        `a turn was served ${String(included.length)} document(s)`,
        { tokens: turn.tokens, hits: turn.requested.length, requested: turn.requested, resolved: turn.resolved, included, why },
        { runId, ...(turn.appId === null ? {} : { appId: turn.appId }) },
      );
      return { appId: turn.appId, requested: turn.requested, resolved: turn.resolved };
    },

    ended(runId) {
      forget(runId);
    },

    inFlight: () => turns.size,

    hints(appId, problems, origin) {
      const out: Hint[] = [];
      const seen = new Set<number>();
      for (const problem of problems) {
        if (out.length >= MAX_HINTS) break;
        // One shared word is enough here, unlike a turn: the stage filter has
        // already narrowed the lessons to the part of the build that failed.
        // A pinned lesson is looked for first, under the same two rules.
        const found = [
          ...findLessons(problem.message, appId, HINTS_PER_PROBLEM, problem.stage, 'pinned'),
          ...findLessons(problem.message, appId, HINTS_PER_PROBLEM, problem.stage),
        ];
        for (const lesson of found) {
          if (out.length >= MAX_HINTS || seen.has(lesson.id)) continue;
          seen.add(lesson.id);
          out.push({
            lessonId: lesson.id,
            status: lesson.status,
            text: lesson.summary,
            ...(lesson.review === null ? {} : { review: lesson.review.replace(/^needs_review:/, '') }),
          });
          // A tool result is delivered by construction: the model reads it.
          serving({
            lessonId: lesson.id,
            runId: origin.runId,
            appId,
            how: 'hint',
            forSignature: problemSignature(problem.stage, problem.message),
            forStage: problem.stage,
            included: true,
          });
        }
      }
      return out;
    },
  };
}
