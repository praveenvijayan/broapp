/**
 * Serving what the launcher knows to the engineer's turn.
 *
 * The AI layer's context providers are the one door: `search` names the
 * documents a turn should have, `resolve` renders them, and the AI layer fits
 * them into its budget and puts them under the Rules that say documents are
 * data. Three documents at most — the orientation, the task evidence, and the
 * lessons the request's words match — and nothing from here reaches the
 * instructions, which stay the one trusted statement of how to work.
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
import type { AppRow } from '../launcher/apps.ts';
import type { BuildProblem } from '../launcher/candidate.ts';
import type { Layout } from '../spec/index.ts';

import { sourceRevision, type FullOrigin } from './ids.ts';
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
}

/** Which of an application's two documents a turn is given. Both, unless said otherwise. */
export interface ServedDocuments {
  readonly digest: boolean;
  readonly evidence: boolean;
}

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

/** What one turn has been offered so far. */
interface Turn {
  readonly appId: string | null;
  readonly tokens: readonly string[];
  readonly lessons: readonly LessonHit[];
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
   * Which application a message is about: the one it names, else the one the
   * person or the engineer last chose, else the only one there is.
   */
  function chooseApp(text: string, words: readonly string[], rows: readonly AppRow[]): string | null {
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
        const appId = chooseApp(query.text, words, rows);
        const evidence = appId === null ? null : taskEvidence({ layout, appId, tokens: words, index: indexOf(appId) });
        const routes = new Set(
          (evidence?.entries ?? []).filter((entry) => entry.kind === 'route').map((entry) => entry.name),
        );
        const lessons: LessonHit[] = [];
        if (appId !== null) {
          const matched = findLessons(query.text, appId, TURN_CANDIDATES).filter((lesson) =>
            strongMatch(lesson, words, routes),
          );
          for (const lesson of [...pinnedLessons(appId), ...matched]) {
            if (lessons.length < TURN_LESSONS && !lessons.some((held) => held.id === lesson.id)) lessons.push(lesson);
          }
        }
        const refs: ContextRef[] =
          appId === null
            ? []
            : [
                ...(documents.digest ? [{ ref: `digest:${appId}`, title: `Where ${appId} stands` }] : []),
                ...(documents.evidence
                  ? [{ ref: `evidence:${appId}`, title: `What this request touches in ${appId}` }]
                  : []),
                ...lessons.map((lesson) => ({ ref: `lesson:${String(lesson.id)}`, title: 'A lesson from earlier work' })),
              ];
        const offered = refs.slice(0, query.limit);
        if (query.runId !== undefined) {
          turns.set(query.runId, {
            appId,
            tokens: words,
            lessons,
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
      for (const lesson of turn.lessons) {
        if (!turn.resolved.includes(`lesson:${String(lesson.id)}`)) continue;
        // Included only when its whole line reached the model: a lesson cut in
        // half by the budget was not delivered as written.
        const reached = lessonsDocument?.content.split('\n').includes(bullet(lesson)) === true;
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
        { tokens: turn.tokens, hits: turn.requested.length, requested: turn.requested, resolved: turn.resolved, included },
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
