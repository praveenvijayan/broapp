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
  NOT_AN_ATTEMPT,
  PRIORITIES,
  REASONING,
  RISKS,
  TASK_MOVES,
  TASK_STATUSES,
  TIERS,
} from './types.ts';
export type {
  AttemptNote,
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
  TaskRun,
  TaskStatus,
  Tier,
} from './types.ts';

export {
  ambiguousReference,
  criteriaProblems,
  exampleIdFor,
  externalRoutes,
  FAILURE_MARK,
  LAST_CRITERION,
  makeSlug,
  MAX_TASKS_PER_INTENT,
  referenceProblems,
  renderPlan,
  resolveReference,
  routesNamedIn,
  runbookProblems,
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

export { INPUT_REFUSAL, NO_MATCH, refusalError, refusalLine, refusalsOf } from './refusals.ts';
export type { RefusableStep, RefusalGroup, RefusalKind } from './refusals.ts';

export { DEFAULT_TIER_MODELS, INTENT_MODELS_FILE, modelFor, readTierModels, writeTierModels } from './models.ts';
export type { TierModels } from './models.ts';

export {
  ADVICE,
  advicePrompt,
  ASKED_NEXT,
  builderMessage,
  FAILURE_SENTENCE,
  createExecutor,
  DECIDE,
  HOST_BUILT_COMPLETED,
  HOST_CALL_ID,
  idleSentence,
  INTENT_APPROVES,
  INTENT_REFUSES,
  MAX_QUESTIONS_PER_TASK,
  MAX_SAME_REFUSALS,
  NOTHING_BUILT,
  nothingDoneStopped,
  providerStopped,
  QUESTION_EXPIRED,
  reasonsFromNote,
  refusalSentences,
  RECENT_RUN_EVENTS,
  RUN_FINISHED,
  stageOf,
  standingAnswer,
  stuckSentence,
  TASK_IDLE_TIMEOUT_MS,
  TASK_MAX_ATTEMPTS,
  TASK_MAX_TURNS,
  TASK_TURN_TIMEOUT_MS,
  verdictOf,
} from './executor.ts';
export type {
  Advice,
  AdviceRefusals,
  CreateExecutorOptions,
  Executor,
  RunEvent,
  RunEventKind,
  RunProgress,
  RunStage,
  RequiredExample,
  RunQuestion,
  StageEvent,
  StandingAnswer,
  TurnEnding,
  Verdict,
} from './executor.ts';

export { MAX_PRICED_MODELS, NO_PRICES, PRICES_FILE, readPrices, writePrices } from './prices.ts';
export type { ModelPrice, PriceEntry, Prices } from './prices.ts';

export {
  costOf,
  ESTIMATE_MIN_TASKS,
  estimateFor,
  mergeParts,
  recordUsage,
  spendOf,
  startOfToday,
  usageOfRun,
  usageOfTask,
  usageRowOf,
  usageToday,
} from './usage.ts';
export type { Estimate, SpendTotal, UsagePart, UsageRow } from './usage.ts';
