/**
 * `broapp-autoapp/intent` — the backlog: intents, tasks as plans, tiers.
 *
 * Host code: the store reaches `bun:sqlite` and the disk. `types.ts`,
 * `plan.ts` and `tier.ts` are pure and could be read anywhere.
 */
export {
  INTENT_STATUSES,
  isAllowedMove,
  LABELS,
  PRIORITIES,
  REASONING,
  RISKS,
  TASK_MOVES,
  TASK_STATUSES,
  TIERS,
} from './types.ts';
export type {
  Criterion,
  CriterionInput,
  IntentAnalysis,
  IntentRecord,
  IntentStatus,
  Label,
  PlanProblem,
  Priority,
  Reasoning,
  Risk,
  StoredTaskStatus,
  TaskEvent,
  TaskInput,
  TaskRecord,
  TaskStatus,
  Tier,
} from './types.ts';

export {
  ambiguousReference,
  exampleIdFor,
  LAST_CRITERION,
  makeSlug,
  MAX_TASKS_PER_INTENT,
  referenceProblems,
  renderPlan,
  resolveReference,
  SLUG_PATTERN,
  slugWords,
  validateGraph,
  validateTask,
} from './plan.ts';
export type { GraphTask, ReferencingTask, RenderableTask, ResolvedReference, SiblingTask, ValidateTaskOptions } from './plan.ts';

export { tierOf } from './tier.ts';
export type { TierInput } from './tier.ts';

export { INTENTS_FILE, LAUNCHER_STOPPED, openIntents } from './store.ts';
export type { IntentDetail, IntentStore, IntentSummary, NewIntent, OpenIntentsOptions, TaskResult, TaskWithEvents } from './store.ts';

export { DEFAULT_TIER_MODELS, INTENT_MODELS_FILE, modelFor, readTierModels, writeTierModels } from './models.ts';
export type { TierModels } from './models.ts';

export {
  ADVICE,
  advicePrompt,
  ASKED_NEXT,
  builderMessage,
  createExecutor,
  DECIDE,
  INTENT_APPROVES,
  INTENT_REFUSES,
  MAX_QUESTIONS_PER_TASK,
  QUESTION_EXPIRED,
  RUN_FINISHED,
  standingAnswer,
  TASK_MAX_ATTEMPTS,
  TASK_TURN_TIMEOUT_MS,
  verdictOf,
} from './executor.ts';
export type {
  Advice,
  CreateExecutorOptions,
  Executor,
  RunProgress,
  RunQuestion,
  StandingAnswer,
  TurnEnding,
  Verdict,
} from './executor.ts';
