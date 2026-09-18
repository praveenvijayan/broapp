/**
 * The words of the backlog, as types.
 *
 * An intent is one request from a person, analysed. A task is one
 * independently verifiable change inside it, written as a plan. The rail calls
 * the whole thing a backlog; the code says `intent`, because
 * `docs/autoapp/backlog.md` already owns that word for deferred framework work.
 *
 * Nothing in this file reaches a database or a disk, so the plan format, its
 * validator and the tier rule can be read and tested on their own.
 */

/** What an intent is doing. */
export const INTENT_STATUSES = ['draft', 'running', 'stopped', 'done', 'withdrawn'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/**
 * What a task is doing, as the store keeps it.
 *
 * `in-queue`, `in-progress` and `completed` are the three words the person
 * asked for, spelled exactly so. `needs-answer` is a task whose builder asked
 * the person something.
 */
export const TASK_STATUSES = [
  'proposed',
  'in-queue',
  'in-progress',
  'needs-answer',
  'completed',
  'failed',
  'interrupted',
  'removed',
] as const;
export type StoredTaskStatus = (typeof TASK_STATUSES)[number];

/**
 * What a task is doing, as a reader sees it.
 *
 * `blocked` is derived when a task is read and never stored: an `in-queue`
 * task one of whose blockers is not `completed`. Storing it would mean
 * remembering to un-store it every time a blocker finished, and a status that
 * can be stale is worse than one that is computed.
 */
export type TaskStatus = StoredTaskStatus | 'blocked';

/**
 * Every move a task may make. Nothing leaves `completed` or `removed`.
 *
 * The one function that changes a status, `IntentStore.moveTask`, refuses any
 * pair not listed here.
 */
export const TASK_MOVES: readonly (readonly [StoredTaskStatus, StoredTaskStatus])[] = [
  ['proposed', 'in-queue'],
  ['proposed', 'removed'],
  ['in-queue', 'in-progress'],
  ['in-queue', 'failed'],
  ['in-queue', 'removed'],
  ['in-progress', 'completed'],
  ['in-progress', 'failed'],
  ['in-progress', 'interrupted'],
  ['in-progress', 'needs-answer'],
  ['needs-answer', 'in-queue'],
  ['needs-answer', 'removed'],
  ['failed', 'in-queue'],
  ['failed', 'proposed'],
  ['failed', 'removed'],
  ['interrupted', 'in-queue'],
  ['interrupted', 'removed'],
];

/** Whether a move is in {@link TASK_MOVES}. */
export function isAllowedMove(from: StoredTaskStatus, to: StoredTaskStatus): boolean {
  return TASK_MOVES.some(([a, b]) => a === from && b === to);
}

/** What a task may say it touches. A fixed vocabulary, one to four per task. */
export const LABELS = ['contract', 'host', 'migration', 'views', 'theme', 'acceptance', 'copy'] as const;
export type Label = (typeof LABELS)[number];

/** How soon a task should run, among tasks nothing orders otherwise. */
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const RISKS = ['high', 'normal'] as const;
export type Risk = (typeof RISKS)[number];

/** How much thought a task needs: an input to the tier rule, not its answer. */
export const REASONING = ['low', 'medium', 'high'] as const;
export type Reasoning = (typeof REASONING)[number];

export const TIERS = ['light', 'standard', 'deep'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * One acceptance criterion.
 *
 * `failure` marks what the person sees when the change goes wrong. `passed` is
 * written by the executor once the acceptance example named after the
 * criterion — `<slug>-<id>` — has passed; nothing in this prompt sets it.
 */
export interface Criterion {
  readonly id: string;
  readonly text: string;
  readonly failure: boolean;
  readonly passed?: boolean;
}

/** A criterion as a caller writes it. The host numbers them `c1`, `c2`… */
export interface CriterionInput {
  readonly text: string;
  readonly failure: boolean;
}

/**
 * What the engineer's planning tool will send for one task: every plan field
 * except the slug's number, the tier and the status, which the host decides.
 */
export interface TaskInput {
  readonly title: string;
  /**
   * The words of the slug, lowercase, hyphenated, at most six. Absent, they
   * are taken from the title. The number in front is the host's.
   */
  readonly words?: string;
  readonly priority: Priority;
  readonly labels: readonly Label[];
  readonly blockedBy: readonly string[];
  readonly estimatedLines: number;
  readonly locks: readonly string[];
  readonly risk: Risk;
  readonly stub: boolean;
  readonly repaidBy?: string;
  readonly summary: string;
  readonly criteria: readonly CriterionInput[];
  /** Why this task has no failure path, 20 to 200 characters. */
  readonly noFailurePath?: string;
  readonly nonFunctional?: readonly string[];
  readonly testNotes?: readonly string[];
  readonly runbook?: readonly string[];
  readonly reasoning: Reasoning;
}

/** One change of a task's status, as `task_events` keeps it. */
export interface TaskEvent {
  readonly id: number;
  readonly at: number;
  readonly from: StoredTaskStatus | null;
  readonly to: StoredTaskStatus;
  readonly note: string;
}

/** One task, every column, as the store reads it back. */
export interface TaskRecord {
  readonly id: number;
  readonly intentId: number;
  readonly appId: string;
  readonly seq: number;
  readonly slug: string;
  readonly title: string;
  readonly priority: Priority;
  readonly labels: readonly Label[];
  readonly blockedBy: readonly string[];
  readonly estimatedLines: number;
  readonly locks: readonly string[];
  readonly risk: Risk;
  readonly stub: boolean;
  readonly repaidBy: string | null;
  readonly summary: string;
  readonly criteria: readonly Criterion[];
  readonly noFailurePath: string | null;
  readonly nonFunctional: readonly string[];
  readonly testNotes: readonly string[];
  readonly runbook: readonly string[];
  readonly reasoning: Reasoning;
  readonly tier: Tier;
  readonly tierReasons: readonly string[];
  readonly modelOverride: string | null;
  /** The stored status. */
  readonly stored: StoredTaskStatus;
  /** The status a reader sees: {@link stored}, or `blocked`. */
  readonly status: TaskStatus;
  /** The blockers that are not `completed`, when {@link status} is `blocked`. */
  readonly waitingOn: readonly string[];
  readonly attempts: number;
  readonly revBefore: string | null;
  readonly revAfter: string | null;
  readonly releaseId: string | null;
  readonly actualLines: number | null;
  readonly runIds: readonly string[];
  readonly failure: unknown;
  readonly advice: unknown;
  readonly question: string | null;
  readonly answers: readonly { readonly question: string; readonly answer: string; readonly at: number }[];
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/** An intent's analysis: what the engineer understood the request to be. */
export interface IntentAnalysis {
  readonly restated: string | null;
  /** What it builds on in the application as it stands. */
  readonly fits: string | null;
  readonly conflicts: readonly string[];
  readonly outOfReach: readonly string[];
  readonly assumptions: readonly string[];
  readonly questions: readonly string[];
}

/** One intent, every column. */
export interface IntentRecord extends IntentAnalysis {
  readonly id: number;
  readonly appId: string;
  readonly request: string;
  readonly status: IntentStatus;
  readonly proposedByRun: string | null;
  readonly hubModel: string | null;
  readonly createdAt: number;
  readonly submittedAt: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly stopReason: string | null;
}

/** One problem with a plan: the field it is about, and a sentence. */
export interface PlanProblem {
  readonly field: string;
  readonly message: string;
}
