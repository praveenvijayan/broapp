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

export { startPreview } from './preview.ts';
export type { PreviewDeps } from './preview.ts';

export { engineerTools } from './tools.ts';
export type { EngineerKnowledge, EngineerToolsOptions, TurnRecord } from './tools.ts';
