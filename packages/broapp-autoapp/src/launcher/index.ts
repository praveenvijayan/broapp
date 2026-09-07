/**
 * `broapp-autoapp/launcher` — supervision, building, activation, recovery.
 *
 * Never import this from browser code, and never from an application: it
 * reaches `node:fs`, `bun:sqlite` and `Bun.spawn`, and it is the thing that
 * runs applications rather than something an application runs.
 */
export { createLauncherApp, createLauncherGate, LAUNCHER_CONFIRM_TIMEOUT_MS } from './app.ts';
export type { CreateLauncherAppOptions, LauncherApp } from './app.ts';

export { appIds, listApps, serving } from './apps.ts';
export type { AppRow } from './apps.ts';

export { launcherContract } from './contract.ts';
export type { LauncherContract } from './contract.ts';

export { createLauncherTab } from './tab.ts';
export type { CreateLauncherTabOptions, LauncherTab } from './tab.ts';

export { createSupervisor } from './supervisor.ts';
export type {
  ChildHandle,
  HealthReport,
  MigrateParams,
  StartParams,
  Supervisor,
  SupervisorOptions,
} from './supervisor.ts';

export { connectToChild } from './client.ts';

export { keepServing } from './keepalive.ts';
export type { KeepServingOptions } from './keepalive.ts';
export { startControl } from './control.ts';
export type { Control, ControlFile, StartControlOptions } from './control.ts';

export { buildCandidate } from './candidate.ts';
export type {
  BuildCandidateParams,
  BuildCandidateResult,
  BuildProblem,
  SourceManifest,
} from './candidate.ts';

export { snapshotDirectory, snapshotToFile } from './snapshot.ts';
export type { SnapshotEntry } from './snapshot.ts';

export { openJournal, TERMINAL_PHASES } from './journal.ts';
export type { Activation, Journal, Phase, PhaseDetails } from './journal.ts';

export { activate } from './activate.ts';
export type { ActivateParams, ActivateResult } from './activate.ts';

export { recover } from './recover.ts';
export type { Recovered, RecoverParams } from './recover.ts';
