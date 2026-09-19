/**
 * `broapp-autoapp/knowledge` — what the engineer did, written down.
 *
 * Host code only. It opens a SQLite file and spawns `git`; a browser bundle
 * that reached it would be a bug.
 */
export {
  BLOB_RETENTION_MS,
  EVENT_RETENTION_MS,
  KNOWLEDGE_FILE,
  MAX_EVENTS,
  ftsQuery,
  openKnowledge,
  sha256,
  signature,
  tokens,
} from './store.ts';
export type { Knowledge, OpenKnowledgeOptions } from './store.ts';

export { createEventLog, eventData, sanitise, sanitisedLogger } from './log.ts';
export type { EventKind, EventLog, EventLogOptions, Origin } from './log.ts';

export { origin, sourceRevision } from './ids.ts';
export type { FullOrigin } from './ids.ts';

export { createEvidence, exampleHash, recordContext, stepsHash } from './evidence.ts';
export type { ContextInput, EpisodeRow, Evidence, OpenEpisode } from './evidence.ts';

export { EVIDENCE_MAX_CHARS, ORIENTATION_MAX_CHARS, indexWorkspace, orientation, taskEvidence } from './path.ts';
export type { EvidenceEntry, IndexedSymbol, Orientation, SymbolIndex, TaskEvidence } from './path.ts';

export { BACKLOG_DOCUMENT_CHARS, backlogDocument, createServe } from './serve.ts';
export type { WhyReason } from './serve.ts';

export { ATTEMPTS_DOCUMENT_CHARS, attemptsDocument, attemptsInput, editedPaths, runRecord, sourceReads } from './attempts.ts';
export type { AttemptCheck, AttemptProblem, AttemptRecord, AttemptsInput } from './attempts.ts';

export {
  fileKey,
  LINK_RELATIONS,
  linksReport,
  plannedFiles,
  rebuildLinks,
  runLinksCommand,
  skippedLocks,
  STAGES_FOR_LABEL,
  stagesFor,
} from './links.ts';
export type { LinkKind, LinksCommandOptions, RebuildLinksInput, RebuildLinksResult, SkippedLock } from './links.ts';
export type { Corpus, CreateServeInput, Hint, Serve, ServedDocuments, ServedTurn } from './serve.ts';

export { problemSignature, scoreBuild, scoreCheck, scoreRunEnd, unrelatedHintCredit } from './scoring.ts';
export type { Outcome, UnrelatedCredit } from './scoring.ts';

export { RUN_APPROVES, git, identityOf, openRun, prepareRun, providersFor } from './harness.ts';
export type { OpenRunOptions, ProvidersFor, RunHandle, RunLabel, RunSource, ToolCall, TurnOutcome } from './harness.ts';

export {
  DEFAULT_REPLAY_RUNS,
  DEFAULT_TURN_TIMEOUT_MS,
  MAX_RUNS_KEPT,
  copyLessons,
  manifestFor,
  regression,
  replay,
  rowOf,
  runReplayCommand,
} from './replay.ts';
export type { ReplayCommandOptions, ReplayManifest, ReplayOptions, ReplayResult } from './replay.ts';

export {
  CONDITIONS,
  CONTINUE_MESSAGE,
  EVALUATION_TASKS,
  evaluate,
  evaluationTable,
  HISTORY_MODES,
  RESTART_CONDITION,
  runEvaluateCommand,
  TOUCHED_FILE,
  twoTurnColumns,
} from './evaluate.ts';
export type {
  Condition,
  EvaluateCommandOptions,
  EvaluateOptions,
  EvaluationRow,
  EvaluationTask,
  HistoryMode,
  TwoTurnColumns,
} from './evaluate.ts';

export { duration, replayTable, verdictOf } from './verdict.ts';
export type { ReplayRow, Verdict } from './verdict.ts';

export { SEED_LESSONS, seedLessons } from './seed.ts';
export type { LessonApplies, SeedLesson } from './seed.ts';

export { DIAGNOSES, DIAGNOSIS, DISTILLER_SYSTEM, createDistiller, distillerPrompt, pendingCases } from './distil.ts';
export type { CreateDistillerInput, Diagnosis, Distiller } from './distil.ts';

export { REVIEW_REASONS, instructionsHash, reviewFlags } from './freshness.ts';

export { blockedCount, replayEvidence, runKnowledgeCommand, showLesson } from './cli.ts';
export type { KnowledgeCommandOptions, LessonProvenance, LessonRecord, LessonServing } from './cli.ts';

export {
  LESSON_STAGES,
  WRITTEN_DETAIL_MAX,
  WRITTEN_SUMMARY_MAX,
  WRITTEN_TRIGGER_MAX,
  confirmLesson,
  insertLesson,
  retireLesson,
  writeLesson,
} from './review.ts';
export type { LessonColumns, LessonInput } from './review.ts';

export { SESSION_FILE, openSession } from './session.ts';
export type { Session } from './session.ts';

export { AUTOAPP_VERSION } from './version.ts';

export { DEFAULT_TASK_CONTEXT, readTaskContext, TASK_CONTEXT_FILE } from './task-context.ts';
export type { TaskContextSwitches } from './task-context.ts';
