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
  exampleIdFor,
  LAST_CRITERION,
  makeSlug,
  MAX_TASKS_PER_INTENT,
  referenceProblems,
  renderPlan,
  SLUG_PATTERN,
  slugWords,
  validateGraph,
  validateTask,
} from './plan.ts';
export type { GraphTask, ReferencingTask, RenderableTask, SiblingTask, ValidateTaskOptions } from './plan.ts';

export { tierOf } from './tier.ts';
export type { TierInput } from './tier.ts';

export { INTENTS_FILE, openIntents } from './store.ts';
export type { IntentDetail, IntentStore, IntentSummary, NewIntent, OpenIntentsOptions, TaskWithEvents } from './store.ts';

export { DEFAULT_TIER_MODELS, INTENT_MODELS_FILE, modelFor, readTierModels, writeTierModels } from './models.ts';
export type { TierModels } from './models.ts';
