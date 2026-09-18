/**
 * The launcher's backlog: intents, their tasks, and every move a task made.
 *
 * One SQLite file beside `knowledge.sqlite`, with its own migrations and its
 * own `user_version`, because it is a different thing with a different life: a
 * lesson is evidence and is never rewritten, a task is work and moves. What the
 * two share is the shape of the file and the reasoning about durability.
 *
 * Every write is one transaction, and every change of a task's status goes
 * through {@link IntentStore.moveTask}, which refuses a move the table in
 * `types.ts` does not list and appends the event in the same transaction. A
 * status that changed without an event is a history that lies.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { publicError } from 'broapp/host';

import {
  ambiguousReference,
  makeSlug,
  referenceProblems,
  resolveReference,
  slugWords,
  validateGraph,
  validateTask,
  type GraphTask,
} from './plan.ts';
import { tierOf } from './tier.ts';
import {
  isAllowedMove,
  NOT_AN_ATTEMPT,
  TASK_STATUSES,
  type Criterion,
  type IntentAnalysis,
  type IntentRecord,
  type IntentStatus,
  type Label,
  type PlanProblem,
  type Priority,
  type Reasoning,
  type Risk,
  type AttemptNote,
  type StoredTaskStatus,
  type TaskEvent,
  type TaskInput,
  type TaskRecord,
  type TaskRun,
  type TaskStatus,
  type Tier,
} from './types.ts';

/** The file, inside the launcher's own data directory. */
export const INTENTS_FILE = 'intents.sqlite';

/**
 * The migrations, in order. Append; never edit one that has shipped.
 *
 * The first creates every column 13b and 13c will write, so the prompts that
 * fill the backlog and run it add behaviour rather than schema. `app_id` is on
 * a task as well as on its intent because a slug is unique per application,
 * and a unique index can only name columns of its own table.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE intents (
     id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, request TEXT NOT NULL,
     restated TEXT, fits TEXT,
     conflicts TEXT NOT NULL DEFAULT '[]', out_of_reach TEXT NOT NULL DEFAULT '[]',
     assumptions TEXT NOT NULL DEFAULT '[]', questions TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'stopped', 'done', 'withdrawn')),
     proposed_by_run TEXT, hub_model TEXT,
     created_at INTEGER NOT NULL, submitted_at INTEGER, started_at INTEGER, ended_at INTEGER, stop_reason TEXT);
   CREATE INDEX intents_app ON intents(app_id, created_at);
   CREATE TABLE tasks (
     id INTEGER PRIMARY KEY, intent_id INTEGER NOT NULL REFERENCES intents(id), app_id TEXT NOT NULL,
     seq INTEGER NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, priority TEXT NOT NULL,
     labels TEXT NOT NULL, blocked_by TEXT NOT NULL, estimated_lines INTEGER NOT NULL, locks TEXT NOT NULL,
     risk TEXT NOT NULL, stub INTEGER NOT NULL, repaid_by TEXT, summary TEXT NOT NULL,
     criteria TEXT NOT NULL, no_failure_path TEXT,
     non_functional TEXT NOT NULL DEFAULT '[]', test_notes TEXT NOT NULL DEFAULT '[]', runbook TEXT NOT NULL DEFAULT '[]',
     reasoning TEXT NOT NULL, tier TEXT NOT NULL, tier_reasons TEXT NOT NULL, model_override TEXT,
     status TEXT NOT NULL CHECK (status IN (${TASK_STATUSES.map((status) => `'${status}'`).join(', ')})),
     attempts INTEGER NOT NULL DEFAULT 0, rev_before TEXT, rev_after TEXT, release_id TEXT, actual_lines INTEGER,
     run_ids TEXT NOT NULL DEFAULT '[]', failure TEXT, advice TEXT, question TEXT, answers TEXT NOT NULL DEFAULT '[]',
     started_at INTEGER, ended_at INTEGER);
   CREATE UNIQUE INDEX tasks_slug ON tasks(app_id, slug);
   CREATE UNIQUE INDEX tasks_seq ON tasks(intent_id, seq);
   CREATE TABLE task_events (
     id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL,
     from_status TEXT, to_status TEXT NOT NULL, note TEXT NOT NULL);
   CREATE INDEX task_events_task ON task_events(task_id, id);
   CREATE TRIGGER task_events_append_only_update BEFORE UPDATE ON task_events
   BEGIN SELECT RAISE(ABORT, 'a task''s history is appended to, never rewritten'); END;
   CREATE TRIGGER task_events_append_only_delete BEFORE DELETE ON task_events
   BEGIN SELECT RAISE(ABORT, 'a task''s history is appended to, never rewritten'); END;`,
  // 14a: one row per run of a task, so a turn is found from its run id by
  // equality and never by reading the id's shape. Backfilled from every task's
  // `run_ids`, the attempt by position; `run_ids` stays, because the panel and
  // 13c's tests read it.
  `CREATE TABLE task_runs (
     run_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
     attempt INTEGER NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX task_runs_task ON task_runs(task_id, at);
   INSERT INTO task_runs (run_id, task_id, attempt, at)
     SELECT r.value, t.id, CAST(r.key AS INTEGER) + 1, COALESCE(s.at, t.started_at, 0)
       FROM tasks t
       JOIN json_each(CASE WHEN json_valid(t.run_ids) THEN t.run_ids ELSE '[]' END) AS r
       LEFT JOIN (SELECT task_id, at, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id) AS n
                    FROM task_events WHERE to_status = 'in-progress') AS s
         ON s.task_id = t.id AND s.n = CAST(r.key AS INTEGER) + 1
      WHERE r.type = 'text';`,
];

/** An intent as the list shows it. */
export interface IntentSummary {
  readonly id: number;
  readonly appId: string;
  readonly status: IntentStatus;
  /** The restatement, or the first 120 characters of the request. */
  readonly restated: string;
  readonly createdAt: number;
  /** When the engineer said the plan was finished; `null` while it is being written. */
  readonly submittedAt: number | null;
  /** How many tasks are in each status a reader sees, `blocked` included. */
  readonly counts: Readonly<Record<TaskStatus, number>>;
}

/** A task and its history. */
export interface TaskWithEvents extends TaskRecord {
  readonly events: readonly TaskEvent[];
}

/** An intent in full, with its tasks in run order. */
export interface IntentDetail {
  readonly intent: IntentRecord;
  readonly tasks: readonly TaskWithEvents[];
}

/** What a new intent is opened with. */
export interface NewIntent {
  readonly appId: string;
  readonly request: string;
  readonly proposedByRun?: string;
  readonly hubModel?: string;
}

/** The backlog. */
export interface IntentStore {
  /** The directory the store and the tier-to-model file live in. */
  readonly dataDir: string;
  /** For tests and the sibling modules in this directory only. */
  readonly db: Database;
  createIntent(intent: NewIntent): IntentRecord;
  /** Replace what the intent was understood to be. Only while it is a draft. */
  replaceAnalysis(intentId: number, analysis: IntentAnalysis): IntentRecord;
  /**
   * Everything wrong with adding `input` to an intent, or with replacing task
   * `replaces` by it, without writing anything. References to tasks not yet
   * planned are left for {@link submit}.
   */
  planProblems(intentId: number, input: TaskInput, replaces?: number): PlanProblem[];
  /** Validate a task, give it a slug and a tier, and add it as `proposed`. */
  addTask(intentId: number, input: TaskInput, options?: PlanOptions): TaskRecord;
  /** Replace a `proposed` task's plan. The slug stays. */
  replaceTask(taskId: number, input: TaskInput, options?: PlanOptions): TaskRecord;
  /**
   * Say a draft's plan is finished: every reference resolves, the graph has no
   * cycle, and there is at least one task. Returns what is wrong, and stamps
   * `submitted_at` only when nothing is.
   */
  submit(intentId: number): PlanProblem[];
  /** An application's intents that are not finished — `draft`, `running`, `stopped` — newest first. */
  live(appId: string): IntentRecord[];
  /**
   * The one way a task's status changes. Moving to `in-progress` counts an
   * attempt and records `runId` among the task's runs.
   */
  moveTask(taskId: number, to: StoredTaskStatus, note: string, runId?: string): TaskRecord;
  /** A task's own model, or `null` for its tier's. */
  setModel(taskId: number, modelId: string | null): TaskRecord;
  /** Remove a task nothing live depends on. */
  removeTask(taskId: number, note?: string): TaskRecord;
  /** Withdraw a draft or stopped intent; every task not completed is removed. */
  withdraw(intentId: number): IntentRecord;
  /**
   * Say where a run of an intent stands: `running` from a submitted draft or a
   * stopped intent, `stopped` with a reason or `done` from `running`.
   */
  setRun(intentId: number, status: 'running' | 'stopped' | 'done', reason?: string): IntentRecord;
  /** Write what an attempt left: revisions, release, lines, and which criteria passed. */
  recordResult(taskId: number, result: TaskResult): TaskRecord;
  /** A failed task's reasons, or `null` to clear them. */
  setFailure(taskId: number, failure: unknown): TaskRecord;
  /** The main model's advice on a failed task, or `null` to clear it. */
  setAdvice(taskId: number, advice: unknown): TaskRecord;
  /** A builder's question: an `in-progress` task becomes `needs-answer`. */
  ask(taskId: number, question: string, note: string): TaskRecord;
  /**
   * A person's answer, kept with the question it answers. A `needs-answer`
   * task goes back to the queue; a failed one keeps its status.
   */
  answer(taskId: number, answer: string, by: string): TaskRecord;
  get(intentId: number): IntentDetail | null;
  task(taskId: number): TaskRecord | null;
  list(filter?: { readonly appId?: string; readonly limit?: number }): IntentSummary[];
  /** An intent's tasks: blockers first, then priority, then slug. */
  runOrder(intentId: number): TaskRecord[];
  /** The task a run built, found by its exact run id; `null` for any other run. */
  taskForRun(runId: string): TaskRecord | null;
  /** A task's runs, oldest first. */
  runsOf(taskId: number): TaskRun[];
  /**
   * How each of a task's attempts ended: every move from `in-progress` to
   * `failed` or `interrupted`, oldest first, with the attempt it ended. A row
   * whose note starts with {@link NOT_AN_ATTEMPT} is marked, not left out: the
   * history is whole, and the reader decides.
   */
  attemptNotes(taskId: number): AttemptNote[];
  close(): void;
}

/** What {@link IntentStore.recordResult} writes. Every field is optional. */
export interface TaskResult {
  readonly revBefore?: string | null;
  readonly revAfter?: string | null;
  readonly releaseId?: string | null;
  readonly actualLines?: number | null;
  /** Criterion ids whose example passed; the others are marked not passed. */
  readonly passed?: readonly string[];
}

/** Why a run that was going when the launcher stopped is not going now. */
export const LAUNCHER_STOPPED = 'The launcher stopped.';

/** How a plan written one task at a time is checked as it is written. */
export interface PlanOptions {
  /** Leave references to tasks not yet planned for {@link IntentStore.submit}. */
  readonly deferReferences?: boolean;
}

/** Options for {@link openIntents}. */
export interface OpenIntentsOptions {
  /** The clock rows are stamped with. Tests move it. */
  readonly now?: () => number;
  /**
   * Interrupt what a stopped launcher left in progress, and stop what it left
   * running. Only the launcher that runs backlogs passes it: `serve <appId>`
   * and the one-shot commands open this store beside a launcher that may be
   * running one, and must not stop it.
   */
  readonly recover?: boolean;
}

interface IntentRow {
  id: number;
  app_id: string;
  request: string;
  restated: string | null;
  fits: string | null;
  conflicts: string;
  out_of_reach: string;
  assumptions: string;
  questions: string;
  status: IntentStatus;
  proposed_by_run: string | null;
  hub_model: string | null;
  created_at: number;
  submitted_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  stop_reason: string | null;
}

interface TaskRow {
  id: number;
  intent_id: number;
  app_id: string;
  seq: number;
  slug: string;
  title: string;
  priority: Priority;
  labels: string;
  blocked_by: string;
  estimated_lines: number;
  locks: string;
  risk: Risk;
  stub: number;
  repaid_by: string | null;
  summary: string;
  criteria: string;
  no_failure_path: string | null;
  non_functional: string;
  test_notes: string;
  runbook: string;
  reasoning: Reasoning;
  tier: Tier;
  tier_reasons: string;
  model_override: string | null;
  status: StoredTaskStatus;
  attempts: number;
  rev_before: string | null;
  rev_after: string | null;
  release_id: string | null;
  actual_lines: number | null;
  run_ids: string;
  failure: string | null;
  advice: string | null;
  question: string | null;
  answers: string;
  started_at: number | null;
  ended_at: number | null;
}

interface EventRow {
  id: number;
  task_id: number;
  at: number;
  from_status: StoredTaskStatus | null;
  to_status: StoredTaskStatus;
  note: string;
}

/** JSON the store wrote itself; anything else reads as the fallback. */
function parsed<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function strings(text: string): string[] {
  const value = parsed<unknown>(text, []);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { high: 0, medium: 1, low: 2 };

/** The statuses whose model may still be chosen: before it runs, or after it stopped. */
const MODEL_EDITABLE: readonly StoredTaskStatus[] = ['proposed', 'in-queue', 'failed', 'interrupted'];
/** The statuses a person may remove a task from. */
const REMOVABLE: readonly StoredTaskStatus[] = ['proposed', 'in-queue'];

function invalid(problems: readonly PlanProblem[]): never {
  throw publicError.invalidInput(problems.map((problem) => `${problem.field}: ${problem.message}`).join(' '));
}

/** Open (and create) the backlog inside `dataDir`. */
export function openIntents(dataDir: string, options: OpenIntentsOptions = {}): IntentStore {
  const now = options.now ?? Date.now;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, INTENTS_FILE), { create: true, strict: true });
  // `synchronous` stays at WAL's NORMAL for the reasons written beside the same
  // pragmas in `knowledge/store.ts`: nothing here is read by recovery.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const at = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  for (let index = at; index < MIGRATIONS.length; index += 1) {
    const statement = MIGRATIONS[index];
    if (statement === undefined) break;
    db.transaction(() => {
      db.exec(statement);
      db.exec(`PRAGMA user_version = ${String(index + 1)}`);
    })();
  }

  // A run does not survive the launcher that ran it. Whatever was in progress when it
  // stopped may have left half a change, and a person decides what happens to
  // an outcome nobody saw, so nothing resumes by itself: the task is
  // interrupted and the intent stopped, with the reason, before anything reads
  // them. The attempt is given back, because it was not the builder's failure.
  if (options.recover === true) db.transaction(() => {
    const at = now();
    for (const row of db.query<{ id: number }, []>("SELECT id FROM tasks WHERE status = 'in-progress'").all()) {
      db.query<null, [number, number]>(
        "UPDATE tasks SET status = 'interrupted', ended_at = ?, attempts = MAX(attempts - 1, 0) WHERE id = ?",
      ).run(at, row.id);
      db.query<null, [number, number, string]>(
        "INSERT INTO task_events (task_id, at, from_status, to_status, note) VALUES (?, ?, 'in-progress', 'interrupted', ?)",
      ).run(row.id, at, 'the launcher stopped');
    }
    db.query<null, [number, string]>("UPDATE intents SET status = 'stopped', ended_at = ?, stop_reason = ? WHERE status = 'running'").run(
      at,
      LAUNCHER_STOPPED,
    );
  })();

  const intentRow = (id: number): IntentRow | null =>
    db.query<IntentRow, [number]>('SELECT * FROM intents WHERE id = ?').get(id);
  const taskRow = (id: number): TaskRow | null => db.query<TaskRow, [number]>('SELECT * FROM tasks WHERE id = ?').get(id);
  const appTasks = (appId: string): TaskRow[] =>
    db.query<TaskRow, [string]>('SELECT * FROM tasks WHERE app_id = ? ORDER BY slug').all(appId);

  function toIntent(row: IntentRow): IntentRecord {
    return {
      id: row.id,
      appId: row.app_id,
      request: row.request,
      restated: row.restated,
      fits: row.fits,
      conflicts: strings(row.conflicts),
      outOfReach: strings(row.out_of_reach),
      assumptions: strings(row.assumptions),
      questions: strings(row.questions),
      status: row.status,
      proposedByRun: row.proposed_by_run,
      hubModel: row.hub_model,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      stopReason: row.stop_reason,
    };
  }

  /** A row as a record, with `blocked` derived from its application's other tasks. */
  function toTask(row: TaskRow, statusOf: ReadonlyMap<string, StoredTaskStatus>): TaskRecord {
    const blockedBy = strings(row.blocked_by);
    const waitingOn = row.status === 'in-queue' ? blockedBy.filter((slug) => statusOf.get(slug) !== 'completed') : [];
    return {
      id: row.id,
      intentId: row.intent_id,
      appId: row.app_id,
      seq: row.seq,
      slug: row.slug,
      title: row.title,
      priority: row.priority,
      labels: strings(row.labels) as Label[],
      blockedBy,
      estimatedLines: row.estimated_lines,
      locks: strings(row.locks),
      risk: row.risk,
      stub: row.stub === 1,
      repaidBy: row.repaid_by,
      summary: row.summary,
      criteria: parsed<Criterion[]>(row.criteria, []),
      noFailurePath: row.no_failure_path,
      nonFunctional: strings(row.non_functional),
      testNotes: strings(row.test_notes),
      runbook: strings(row.runbook),
      reasoning: row.reasoning,
      tier: row.tier,
      tierReasons: strings(row.tier_reasons),
      modelOverride: row.model_override,
      stored: row.status,
      status: waitingOn.length > 0 ? 'blocked' : row.status,
      waitingOn,
      attempts: row.attempts,
      revBefore: row.rev_before,
      revAfter: row.rev_after,
      releaseId: row.release_id,
      actualLines: row.actual_lines,
      runIds: strings(row.run_ids),
      failure: parsed<unknown>(row.failure, null),
      advice: parsed<unknown>(row.advice, null),
      question: row.question,
      answers: parsed<TaskRecord['answers']>(row.answers, []),
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  function statuses(appId: string): Map<string, StoredTaskStatus> {
    return new Map(
      db
        .query<{ slug: string; status: StoredTaskStatus }, [string]>('SELECT slug, status FROM tasks WHERE app_id = ?')
        .all(appId)
        .map((row) => [row.slug, row.status]),
    );
  }

  function readTask(id: number): TaskRecord {
    const row = taskRow(id);
    if (row === null) throw publicError.notFound(`There is no task ${String(id)}.`);
    return toTask(row, statuses(row.app_id));
  }

  function readIntent(id: number): IntentRecord {
    const row = intentRow(id);
    if (row === null) throw publicError.notFound(`There is no intent ${String(id)}.`);
    return toIntent(row);
  }

  function graphOf(rows: readonly TaskRow[]): GraphTask[] {
    return rows.map((row) => ({
      slug: row.slug,
      intentId: row.intent_id,
      blockedBy: strings(row.blocked_by),
      stored: row.status,
    }));
  }

  /** The plan columns of a task, as bound parameters, in one fixed order. */
  function planColumns(input: TaskInput): (string | number | null)[] {
    const { tier, reasons } = tierOf(input);
    const criteria: Criterion[] = input.criteria.map((criterion, index) => ({
      id: `c${String(index + 1)}`,
      text: criterion.text,
      failure: criterion.failure,
    }));
    return [
      input.title,
      input.priority,
      JSON.stringify(input.labels),
      JSON.stringify(input.blockedBy),
      input.estimatedLines,
      JSON.stringify(input.locks),
      input.risk,
      input.stub ? 1 : 0,
      input.repaidBy ?? null,
      input.summary,
      JSON.stringify(criteria),
      input.noFailurePath ?? null,
      JSON.stringify(input.nonFunctional ?? []),
      JSON.stringify(input.testNotes ?? []),
      JSON.stringify(input.runbook ?? []),
      input.reasoning,
      tier,
      JSON.stringify(reasons),
    ];
  }

  const PLAN_COLUMNS = [
    'title', 'priority', 'labels', 'blocked_by', 'estimated_lines', 'locks', 'risk', 'stub', 'repaid_by',
    'summary', 'criteria', 'no_failure_path', 'non_functional', 'test_notes', 'runbook', 'reasoning', 'tier', 'tier_reasons',
  ] as const;

  /**
   * A plan with its references resolved to whole slugs, where they can be.
   *
   * A reference to a task's words becomes that task's slug among the intent's
   * live tasks; one that matches nothing is left as it was, for the validator
   * to refuse or for {@link IntentStore.submit} to resolve once the task
   * exists. The task's own slug is among the candidates, so naming itself by
   * its words is refused as naming itself.
   */
  function resolveInput(
    input: TaskInput,
    row: { slug: string; intentId: number; id: number | null },
    appId: string,
  ): { input: TaskInput; problems: PlanProblem[] } {
    const all = appTasks(appId);
    const known = new Set(all.filter((task) => task.status !== 'removed').map((task) => task.slug));
    known.add(row.slug);
    const candidates = [
      ...all.filter((task) => task.intent_id === row.intentId && task.status !== 'removed' && task.id !== row.id),
      { slug: row.slug },
    ];
    const problems: PlanProblem[] = [];
    const one = (field: string, reference: string): string => {
      const resolved = resolveReference(reference, candidates, known);
      if ('slug' in resolved) return resolved.slug;
      if ('ambiguous' in resolved) problems.push(ambiguousReference(field, reference, resolved.ambiguous));
      return reference;
    };
    return {
      input: {
        ...input,
        blockedBy: input.blockedBy.map((reference) => one('blocked_by', reference)),
        ...(input.repaidBy === undefined ? {} : { repaidBy: one('repaid_by', input.repaidBy) }),
      },
      problems,
    };
  }

  /** What is wrong with a task's plan, or with its place in the graph, and the plan as it would be stored. */
  function problemsOf(
    sent: TaskInput,
    row: { slug: string; intentId: number; id: number | null },
    appId: string,
    options: PlanOptions,
  ): { input: TaskInput; problems: PlanProblem[] } {
    const { input, problems: references } = resolveInput(sent, row, appId);
    const others = appTasks(appId).filter((task) => task.id !== row.id);
    const problems = [
      ...references,
      ...validateTask(
        input,
        others.map((task) => ({ slug: task.slug, stored: task.status })),
        row.id === null ? undefined : row.slug,
        options,
      ),
    ];
    if (problems.length > 0) return { input, problems };
    return {
      input,
      problems: validateGraph([
        ...graphOf(others),
        { slug: row.slug, intentId: row.intentId, blockedBy: input.blockedBy, stored: 'proposed' },
      ]),
    };
  }

  /** Refuse a task whose plan or whose place in the graph is wrong; the plan as it is stored. */
  function check(sent: TaskInput, row: { slug: string; intentId: number; id: number | null }, appId: string, options: PlanOptions): TaskInput {
    const { input, problems } = problemsOf(sent, row, appId, options);
    if (problems.length > 0) invalid(problems);
    return input;
  }

  /** The slug the next task of an application would get. */
  function nextSlug(appId: string, input: TaskInput): string {
    const highest =
      db
        .query<{ n: number | null }, [string]>('SELECT MAX(CAST(substr(slug, 1, 4) AS INTEGER)) AS n FROM tasks WHERE app_id = ?')
        .get(appId)?.n ?? 0;
    return makeSlug(highest + 1, input.words ?? slugWords(input.title));
  }

  /**
   * A draft that changes is being written again. The panel says "Being
   * written" until the engineer submits it once more.
   */
  function unsubmit(intentId: number): void {
    db.query<null, [number]>("UPDATE intents SET submitted_at = NULL WHERE id = ? AND status = 'draft'").run(intentId);
  }

  function appendEvent(taskId: number, from: StoredTaskStatus | null, to: StoredTaskStatus, note: string): void {
    db.query<null, [number, number, StoredTaskStatus | null, StoredTaskStatus, string]>(
      'INSERT INTO task_events (task_id, at, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)',
    ).run(taskId, now(), from, to, note);
  }

  /**
   * Change a status, stamp what the move means, and append the event.
   *
   * The stamps are here, in the same transaction, so nothing else writes them:
   * starting counts an attempt and names its run; finishing, failing, being
   * interrupted or stopping to ask sets when it ended. An interruption and a
   * question take the attempt back, because neither was the builder's failure.
   */
  function move(taskId: number, to: StoredTaskStatus, note: string, runId?: string): void {
    const row = taskRow(taskId);
    if (row === null) throw publicError.notFound(`There is no task ${String(taskId)}.`);
    if (!isAllowedMove(row.status, to)) {
      throw publicError.conflict(`${row.slug} cannot move from ${row.status} to ${to}.`);
    }
    db.query<null, [StoredTaskStatus, number]>('UPDATE tasks SET status = ? WHERE id = ?').run(to, taskId);
    if (to === 'in-progress') {
      const runs = runId === undefined ? strings(row.run_ids) : [...strings(row.run_ids), runId];
      db.query<null, [number, string, number]>(
        'UPDATE tasks SET started_at = ?, ended_at = NULL, attempts = attempts + 1, run_ids = ? WHERE id = ?',
      ).run(now(), JSON.stringify(runs), taskId);
      // The primary key refuses a run id used twice, and the transaction this
      // runs in takes the move back with it.
      if (runId !== undefined) {
        db.query<null, [string, number, number, number]>(
          'INSERT INTO task_runs (run_id, task_id, attempt, at) VALUES (?, ?, ?, ?)',
        ).run(runId, taskId, runs.length, now());
      }
    } else if (to === 'completed' || to === 'failed') {
      db.query<null, [number, number]>('UPDATE tasks SET ended_at = ? WHERE id = ?').run(now(), taskId);
    } else if (row.status === 'in-progress' && (to === 'interrupted' || to === 'needs-answer')) {
      db.query<null, [number, number]>('UPDATE tasks SET ended_at = ?, attempts = MAX(attempts - 1, 0) WHERE id = ?').run(
        now(),
        taskId,
      );
    }
    appendEvent(taskId, row.status, to, note);
  }

  /** Live tasks of the application, outside `except`, that wait on or repay one of `slugs`. */
  function dependants(appId: string, slugs: ReadonlySet<string>, except: ReadonlySet<number>): string[] {
    return appTasks(appId)
      .filter((task) => task.status !== 'removed' && !except.has(task.id))
      .filter((task) => strings(task.blocked_by).some((slug) => slugs.has(slug)) || (task.repaid_by !== null && slugs.has(task.repaid_by)))
      .map((task) => task.slug);
  }

  function orderOf(intentId: number): TaskRecord[] {
    const intent = intentRow(intentId);
    if (intent === null) throw publicError.notFound(`There is no intent ${String(intentId)}.`);
    const statusOf = statuses(intent.app_id);
    const tasks = db
      .query<TaskRow, [number]>('SELECT * FROM tasks WHERE intent_id = ? ORDER BY seq')
      .all(intentId)
      .map((row) => toTask(row, statusOf));

    // Kahn's algorithm over the blockers inside this intent. A blocker in
    // another intent orders nothing here: it is either done or it holds the
    // task `blocked`, which the status already says.
    const bySlug = new Map(tasks.map((task) => [task.slug, task]));
    const waiting = new Map(tasks.map((task) => [task.slug, task.blockedBy.filter((slug) => bySlug.has(slug)).length]));
    const before = (a: TaskRecord, b: TaskRecord): number =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.slug.localeCompare(b.slug);
    const ready = tasks.filter((task) => waiting.get(task.slug) === 0);
    const out: TaskRecord[] = [];
    while (ready.length > 0) {
      ready.sort(before);
      const next = ready.shift();
      if (next === undefined) break;
      out.push(next);
      for (const task of tasks) {
        if (!task.blockedBy.includes(next.slug)) continue;
        const left = (waiting.get(task.slug) ?? 0) - 1;
        waiting.set(task.slug, left);
        if (left === 0) ready.push(task);
      }
    }
    // A cycle cannot be stored, but a row written by hand could make one; its
    // tasks go last rather than vanishing from the list.
    const placed = new Set(out.map((task) => task.slug));
    return [...out, ...tasks.filter((task) => !placed.has(task.slug)).sort(before)];
  }

  let closed = false;
  return {
    dataDir,
    db,

    createIntent({ appId, request, proposedByRun, hubModel }) {
      if (request.trim().length === 0) throw publicError.invalidInput('request: an intent needs the words the person typed.');
      const id = db
        .query<{ id: number }, [string, string, string | null, string | null, number]>(
          `INSERT INTO intents (app_id, request, status, proposed_by_run, hub_model, created_at)
           VALUES (?, ?, 'draft', ?, ?, ?) RETURNING id`,
        )
        .get(appId, request, proposedByRun ?? null, hubModel ?? null, now())?.id;
      if (id === undefined) throw new Error('the intent was not written');
      return readIntent(id);
    },

    replaceAnalysis(intentId, analysis) {
      return db.transaction(() => {
        const intent = readIntent(intentId);
        if (intent.status !== 'draft') {
          throw publicError.conflict(`Intent ${String(intentId)} is ${intent.status}; its analysis is changed only while it is a draft.`);
        }
        db.query<null, [string | null, string | null, string, string, string, string, number]>(
          `UPDATE intents SET restated = ?, fits = ?, conflicts = ?, out_of_reach = ?, assumptions = ?, questions = ?,
             submitted_at = NULL
           WHERE id = ?`,
        ).run(
          analysis.restated,
          analysis.fits,
          JSON.stringify(analysis.conflicts),
          JSON.stringify(analysis.outOfReach),
          JSON.stringify(analysis.assumptions),
          JSON.stringify(analysis.questions),
          intentId,
        );
        return readIntent(intentId);
      })();
    },

    planProblems(intentId, input, replaces) {
      const intent = readIntent(intentId);
      if (replaces === undefined) {
        return problemsOf(input, { slug: nextSlug(intent.appId, input), intentId, id: null }, intent.appId, { deferReferences: true }).problems;
      }
      const row = taskRow(replaces);
      if (row === null) throw publicError.notFound(`There is no task ${String(replaces)}.`);
      return problemsOf(input, { slug: row.slug, intentId: row.intent_id, id: row.id }, row.app_id, { deferReferences: true }).problems;
    },

    addTask(intentId, input, options = {}) {
      return db.transaction(() => {
        const intent = readIntent(intentId);
        if (intent.status !== 'draft' && intent.status !== 'stopped') {
          throw publicError.conflict(`Intent ${String(intentId)} is ${intent.status}; tasks are added only to a draft or a stopped one.`);
        }
        // The next free number for the application, across all its intents.
        const slug = nextSlug(intent.appId, input);
        const plan = check(input, { slug, intentId, id: null }, intent.appId, options);
        const seq =
          (db.query<{ n: number | null }, [number]>('SELECT MAX(seq) AS n FROM tasks WHERE intent_id = ?').get(intentId)?.n ?? 0) + 1;
        const columns = ['intent_id', 'app_id', 'seq', 'slug', ...PLAN_COLUMNS, 'status'];
        const id = db
          .query<{ id: number }, (string | number | null)[]>(
            `INSERT INTO tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING id`,
          )
          .get(intentId, intent.appId, seq, slug, ...planColumns(plan), 'proposed')?.id;
        if (id === undefined) throw new Error('the task was not written');
        appendEvent(id, null, 'proposed', 'planned');
        unsubmit(intentId);
        return readTask(id);
      })();
    },

    replaceTask(taskId, input, options = {}) {
      return db.transaction(() => {
        const row = taskRow(taskId);
        if (row === null) throw publicError.notFound(`There is no task ${String(taskId)}.`);
        // A task that failed in a run that stopped may be revised too: that is
        // the other way on from a stop, beside running it again. It goes back
        // to `proposed`, so the person sees a new plan before it runs.
        const revising = row.status === 'failed' && intentRow(row.intent_id)?.status === 'stopped';
        if (row.status !== 'proposed' && !revising) {
          throw publicError.conflict(
            `${row.slug} is ${row.status}; a plan is replaced only while it is proposed, or after it failed in a run that stopped.`,
          );
        }
        const plan = check(input, { slug: row.slug, intentId: row.intent_id, id: row.id }, row.app_id, options);
        db.query<null, (string | number | null)[]>(
          `UPDATE tasks SET ${PLAN_COLUMNS.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
        ).run(...planColumns(plan), taskId);
        if (revising) {
          // A new plan: the advice was about the old one.
          db.query<null, [number]>('UPDATE tasks SET advice = NULL, failure = NULL WHERE id = ?').run(taskId);
          move(taskId, 'proposed', 'the plan was revised after it failed');
        }
        unsubmit(row.intent_id);
        return readTask(taskId);
      })();
    },

    submit(intentId) {
      return db.transaction(() => {
        const intent = readIntent(intentId);
        if (intent.status !== 'draft') {
          throw publicError.conflict(`Intent ${String(intentId)} is ${intent.status}; only a draft is submitted.`);
        }
        const before = appTasks(intent.appId);
        const mine = before.filter((row) => row.intent_id === intentId && row.status !== 'removed');
        if (mine.length === 0) {
          return [{ field: 'tasks', message: `Intent ${String(intentId)} has no tasks. Add each part with intent.task first.` }];
        }
        // Every task now exists, so a reference to one by its words resolves;
        // what is stored from here on is the whole slug.
        const known = new Set(before.filter((row) => row.status !== 'removed').map((row) => row.slug));
        const ambiguous: PlanProblem[] = [];
        for (const row of mine) {
          const one = (field: string, reference: string): string => {
            const resolved = resolveReference(reference, mine, known);
            if ('slug' in resolved) return resolved.slug;
            if ('ambiguous' in resolved) {
              const problem = ambiguousReference(field, reference, resolved.ambiguous);
              ambiguous.push({ field, message: `${row.slug}: ${problem.message}` });
            }
            return reference;
          };
          const blockedBy = strings(row.blocked_by).map((reference) => one('blocked_by', reference));
          const repaidBy = row.repaid_by === null ? null : one('repaid_by', row.repaid_by);
          db.query<null, [string, string | null, number]>('UPDATE tasks SET blocked_by = ?, repaid_by = ? WHERE id = ?').run(
            JSON.stringify(blockedBy),
            repaidBy,
            row.id,
          );
        }
        const all = appTasks(intent.appId);
        const own = all.filter((row) => row.intent_id === intentId && row.status !== 'removed');
        const problems = [
          ...ambiguous,
          ...referenceProblems(
            own.map((row) => ({ slug: row.slug, blockedBy: strings(row.blocked_by), repaidBy: row.repaid_by, stored: row.status })),
            all.map((row) => ({ slug: row.slug, stored: row.status })),
          ),
          ...validateGraph(graphOf(all)),
        ];
        if (problems.length > 0) return problems;
        db.query<null, [number, number]>('UPDATE intents SET submitted_at = ? WHERE id = ?').run(now(), intentId);
        return [];
      })();
    },

    live(appId) {
      return db
        .query<IntentRow, [string]>(
          "SELECT * FROM intents WHERE app_id = ? AND status IN ('draft', 'running', 'stopped') ORDER BY created_at DESC, id DESC",
        )
        .all(appId)
        .map(toIntent);
    },

    moveTask(taskId, to, note, runId) {
      return db.transaction(() => {
        move(taskId, to, note, runId);
        return readTask(taskId);
      })();
    },

    setModel(taskId, modelId) {
      return db.transaction(() => {
        const row = taskRow(taskId);
        if (row === null) throw publicError.notFound(`There is no task ${String(taskId)}.`);
        if (!MODEL_EDITABLE.includes(row.status)) {
          throw publicError.conflict(
            `${row.slug} is ${row.status}. A task's model is chosen before it runs or after it stopped, not while it runs or once it is finished.`,
          );
        }
        db.query<null, [string | null, number]>('UPDATE tasks SET model_override = ? WHERE id = ?').run(modelId, taskId);
        return readTask(taskId);
      })();
    },

    removeTask(taskId, note = 'removed by a person') {
      return db.transaction(() => {
        const row = taskRow(taskId);
        if (row === null) throw publicError.notFound(`There is no task ${String(taskId)}.`);
        if (!REMOVABLE.includes(row.status)) {
          throw publicError.conflict(`${row.slug} is ${row.status}; only a proposed or queued task can be removed.`);
        }
        const waiting = dependants(row.app_id, new Set([row.slug]), new Set([row.id]));
        if (waiting.length > 0) {
          throw publicError.conflict(`${row.slug} cannot be removed: ${waiting.join(', ')} depend${waiting.length === 1 ? 's' : ''} on it.`);
        }
        move(taskId, 'removed', note);
        return readTask(taskId);
      })();
    },

    withdraw(intentId) {
      return db.transaction(() => {
        const intent = readIntent(intentId);
        if (intent.status !== 'draft' && intent.status !== 'stopped') {
          throw publicError.conflict(`Intent ${String(intentId)} is ${intent.status}; only a draft or a stopped intent can be withdrawn.`);
        }
        const rows = db.query<TaskRow, [number]>('SELECT * FROM tasks WHERE intent_id = ?').all(intentId);
        const going = rows.filter((row) => row.status !== 'completed' && row.status !== 'removed');
        const running = going.filter((row) => row.status === 'in-progress');
        if (running.length > 0) {
          throw publicError.conflict(`${running.map((row) => row.slug).join(', ')} is still running. Stop it before withdrawing.`);
        }
        const waiting = dependants(intent.appId, new Set(going.map((row) => row.slug)), new Set(rows.map((row) => row.id)));
        if (waiting.length > 0) {
          throw publicError.conflict(
            `Intent ${String(intentId)} cannot be withdrawn: ${waiting.join(', ')} in another intent depend${waiting.length === 1 ? 's' : ''} on its tasks.`,
          );
        }
        // Straight to `removed`, whatever the task was doing: a detour through
        // the queue would write a history row for a state it was never in.
        for (const row of going) move(row.id, 'removed', 'the intent was withdrawn');
        db.query<null, [number, number]>("UPDATE intents SET status = 'withdrawn', ended_at = ? WHERE id = ?").run(now(), intentId);
        return readIntent(intentId);
      })();
    },

    setRun(intentId, status, reason) {
      return db.transaction(() => {
        const intent = readIntent(intentId);
        const from: readonly IntentStatus[] = status === 'running' ? ['draft', 'stopped'] : ['running'];
        if (!from.includes(intent.status)) {
          throw publicError.conflict(`Intent ${String(intentId)} is ${intent.status}; it cannot become ${status}.`);
        }
        if (status === 'running') {
          db.query<null, [number, number]>(
            "UPDATE intents SET status = 'running', started_at = ?, ended_at = NULL, stop_reason = NULL WHERE id = ?",
          ).run(now(), intentId);
        } else {
          db.query<null, [IntentStatus, number, string | null, number]>(
            'UPDATE intents SET status = ?, ended_at = ?, stop_reason = ? WHERE id = ?',
          ).run(status, now(), status === 'stopped' ? (reason ?? null) : null, intentId);
        }
        return readIntent(intentId);
      })();
    },

    recordResult(taskId, result) {
      return db.transaction(() => {
        const row = taskRow(taskId);
        if (row === null) throw publicError.notFound(`There is no task ${String(taskId)}.`);
        const set = (column: string, value: string | number | null): void => {
          db.query<null, [string | number | null, number]>(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, taskId);
        };
        if (result.revBefore !== undefined) set('rev_before', result.revBefore);
        if (result.revAfter !== undefined) set('rev_after', result.revAfter);
        if (result.releaseId !== undefined) set('release_id', result.releaseId);
        if (result.actualLines !== undefined) set('actual_lines', result.actualLines);
        if (result.passed !== undefined) {
          const passed = new Set(result.passed);
          const criteria = parsed<Criterion[]>(row.criteria, []).map((criterion) => ({ ...criterion, passed: passed.has(criterion.id) }));
          set('criteria', JSON.stringify(criteria));
        }
        return readTask(taskId);
      })();
    },

    setFailure(taskId, failure) {
      readTask(taskId);
      db.query<null, [string | null, number]>('UPDATE tasks SET failure = ? WHERE id = ?').run(
        failure === null ? null : JSON.stringify(failure),
        taskId,
      );
      return readTask(taskId);
    },

    setAdvice(taskId, advice) {
      readTask(taskId);
      db.query<null, [string | null, number]>('UPDATE tasks SET advice = ? WHERE id = ?').run(
        advice === null ? null : JSON.stringify(advice),
        taskId,
      );
      return readTask(taskId);
    },

    ask(taskId, question, note) {
      return db.transaction(() => {
        move(taskId, 'needs-answer', note);
        db.query<null, [string, number]>('UPDATE tasks SET question = ? WHERE id = ?').run(question, taskId);
        return readTask(taskId);
      })();
    },

    answer(taskId, answer, by) {
      return db.transaction(() => {
        const task = readTask(taskId);
        let question = task.question;
        if (question === null && task.stored === 'failed') {
          // What a failed task's advice asked the person, when it asked anything.
          const advice = task.advice as { note?: unknown } | null;
          question = typeof advice?.note === 'string' ? advice.note : 'What should happen to this task?';
        }
        if (question === null) {
          throw publicError.conflict(`${task.slug} is not waiting for an answer.`);
        }
        if (task.stored !== 'needs-answer' && task.stored !== 'failed') {
          throw publicError.conflict(`${task.slug} is ${task.stored}; only a task that asked, or one that failed, is answered.`);
        }
        const answers = [...task.answers, { question, answer, at: now() }];
        db.query<null, [string, number]>('UPDATE tasks SET answers = ?, question = NULL WHERE id = ?').run(JSON.stringify(answers), taskId);
        if (task.stored === 'needs-answer') move(taskId, 'in-queue', `answered by ${by}`);
        return readTask(taskId);
      })();
    },

    get(intentId) {
      const row = intentRow(intentId);
      if (row === null) return null;
      const events = db
        .query<EventRow, [number]>(
          'SELECT e.* FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.intent_id = ? ORDER BY e.id',
        )
        .all(intentId);
      return {
        intent: toIntent(row),
        tasks: orderOf(intentId).map((task) => ({
          ...task,
          events: events
            .filter((event) => event.task_id === task.id)
            .map((event) => ({ id: event.id, at: event.at, from: event.from_status, to: event.to_status, note: event.note })),
        })),
      };
    },

    task(taskId) {
      const row = taskRow(taskId);
      return row === null ? null : toTask(row, statuses(row.app_id));
    },

    list(filter = {}) {
      const limit = filter.limit ?? 100;
      const rows =
        filter.appId === undefined
          ? db.query<IntentRow, [number]>('SELECT * FROM intents ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
          : db
              .query<IntentRow, [string, number]>('SELECT * FROM intents WHERE app_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
              .all(filter.appId, limit);
      return rows.map((row) => {
        const counts = Object.fromEntries([...TASK_STATUSES, 'blocked'].map((status) => [status, 0])) as Record<TaskStatus, number>;
        for (const task of orderOf(row.id)) counts[task.status] += 1;
        return {
          id: row.id,
          appId: row.app_id,
          status: row.status,
          restated: row.restated ?? row.request.slice(0, 120),
          createdAt: row.created_at,
          submittedAt: row.submitted_at,
          counts,
        };
      });
    },

    runOrder: orderOf,

    taskForRun(runId) {
      const row = db
        .query<TaskRow, [string]>('SELECT t.* FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.run_id = ?')
        .get(runId);
      return row === null ? null : toTask(row, statuses(row.app_id));
    },

    runsOf(taskId) {
      return db
        .query<{ run_id: string; attempt: number; at: number }, [number]>(
          'SELECT run_id, attempt, at FROM task_runs WHERE task_id = ? ORDER BY attempt, at',
        )
        .all(taskId)
        .map((row) => ({ runId: row.run_id, attempt: row.attempt, at: row.at }));
    },

    attemptNotes(taskId) {
      // An attempt is numbered by the moves to `in-progress` before it, which
      // is how its run id was numbered: every such move names a run.
      const out: AttemptNote[] = [];
      let attempt = 0;
      for (const event of db
        .query<EventRow, [number]>('SELECT * FROM task_events WHERE task_id = ? ORDER BY id')
        .all(taskId)) {
        if (event.to_status === 'in-progress') attempt += 1;
        if (event.from_status !== 'in-progress') continue;
        if (event.to_status !== 'failed' && event.to_status !== 'interrupted') continue;
        out.push({
          attempt,
          to: event.to_status,
          note: event.note,
          at: event.at,
          notAnAttempt: event.note.startsWith(NOT_AN_ATTEMPT),
        });
      }
      return out;
    },

    close() {
      if (closed) return;
      closed = true;
      // As the knowledge store does: fold the WAL back in and leave one file.
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.exec('PRAGMA journal_mode = DELETE');
      } catch {
        // Another connection has it open. Not a reason to keep this one.
      }
      db.close();
    },
  };
}
