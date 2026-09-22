/**
 * `broapp-autoapp/engineer` — the AI engineer's workspace, tools and state.
 *
 * Host code. Never import it from a browser bundle: it reaches `node:fs` and
 * spawns child processes, which is the whole of what it is for.
 */
export {
  applyChange,
  applyEdits,
  diffSummary,
  readTree,
  readWorkspaceFile,
  searchWorkspace,
  snapshot,
} from './workspace.ts';
export type { EditResult, FileChange, Hunk, MatchedBy, SearchHit, Snapshot, TreeEntry } from './workspace.ts';

export { ENGINEER_INSTRUCTIONS, INSTRUCTION_SECTIONS } from './instructions.ts';

export { createCandidateStates, previewIdOf } from './state.ts';
export type {
  CandidatePatch,
  CandidateState,
  CandidateStates,
  CandidateStatus,
  CheckResult,
  StoredCandidate,
  StoredChecks,
} from './state.ts';

export { caughtFailure, CHECK_STEP_TIMEOUT_MS, contains, coverage, divergence, findComponent, runAcceptance, stepFailure, UNVERIFIED_BY_CHECKS, viewStepFailure } from './check.ts';

export { CYCLE_STEPS, MAX_REPAIR_ATTEMPTS } from './state.ts';
export type { CycleProgress } from './state.ts';

export { locateProblem } from './tools.ts';
export type { ProblemLocation } from './tools.ts';

export { DOES_NOT_LOAD, forTheBuilder, startPreview } from './preview.ts';
export type { PreviewDeps } from './preview.ts';

export {
  BUSY_LOCKED,
  createInputMemory,
  engineerTools,
  INPUT_EXAMPLES,
  INPUT_SCHEMAS,
  PLANNING_LOCKED,
  PLANNING_REFUSAL,
  READ_AGAIN,
  withExample,
} from './tools.ts';
export {
  BUILDER_MAY_NOT_PLAN,
  BUILDER_RUN_PREFIX,
  groundedIn,
  INTENT_TASK_INPUT,
  intentTools,
  isBlank,
  isBuilderRun,
  QUESTIONS_REFUSAL,
  RUN_AGREEMENT,
  UNGROUNDED,
} from './intent-tools.ts';
export type { IntentTools, IntentToolsOptions } from './intent-tools.ts';
export type { EngineerKnowledge, EngineerToolsOptions, InputMemory, TurnRecord } from './tools.ts';
export {
  allowedWebUrl,
  DEFAULT_PAGE_CHARS,
  DEFAULT_RESULTS,
  MAX_LINKS,
  MAX_PAGE_CHARS,
  MAX_RESULTS,
  NO_BROWSER,
  PAGE_TEXT_SCRIPT,
  SEARCH_ENGINE,
  SEARCH_RESULTS_SCRIPT,
  searchUrl,
  tidyText,
  unwrapResultUrl,
  WEB_DATA_NOTE,
  WEB_TIMEOUT_MS,
  WEB_TOOLS,
  webTools,
  webViewBrowser,
} from './web.ts';
export type { ViewFactory, ViewLike, WebBrowser, WebLink, WebPage, WebSearchResult, WebToolsOptions, WebViewBrowserOptions } from './web.ts';
export { EXTERNAL_IN_PREVIEW, REFERENCE_TOPICS, specReference, SPLIT_RULES } from './reference.ts';
export type { ReferenceTopic } from './reference.ts';
export { DESIGN_CHECK, DESIGN_RULES, designTopic } from './design.ts';
export type { DesignRule, DesignSection, DesignSubject } from './design.ts';
