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
  snapshot,
} from './workspace.ts';
export type { EditResult, FileChange, Hunk, MatchedBy, Snapshot, TreeEntry } from './workspace.ts';

export { ENGINEER_INSTRUCTIONS, INSTRUCTION_SECTIONS } from './instructions.ts';

export { createCandidateStates } from './state.ts';
export type { CandidateState, CandidateStates, CandidateStatus, CheckResult } from './state.ts';

export { engineerTools } from './tools.ts';
export type { EngineerToolsOptions } from './tools.ts';
