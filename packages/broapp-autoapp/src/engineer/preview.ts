/**
 * Starting a preview, wherever it is asked for.
 *
 * Two callers and one function. The engineer's `candidate.preview` starts one
 * after a build; the person's Start preview starts one again after the launcher
 * restarted and the old child went with it. A copy of this that drifted would
 * be a preview that ran on the live data, or on the leftovers of the last one.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import type { EventLog, Origin } from '../knowledge/log.ts';
import { snapshotDirectory } from '../launcher/snapshot.ts';
import type { ChildHandle, Supervisor } from '../launcher/supervisor.ts';
import type { Layout } from '../spec/index.ts';

import type { CandidateStates } from './state.ts';

/** What starting a preview needs. */
export interface PreviewDeps {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly states: CandidateStates;
  /** Where the start is written down, when anywhere. */
  readonly log?: EventLog;
}

/** How long the previous preview gets to stop. */
const STOP_DEADLINE_MS = 10_000;

/**
 * Start `releaseId` on a fresh copy of the application's data, replacing any
 * preview already running for it.
 */
export async function startPreview(
  deps: PreviewDeps,
  appId: string,
  releaseId: string,
  origin: Origin = {},
): Promise<ChildHandle> {
  const app = deps.layout.app(appId);
  const previous = deps.states.get(appId).preview;
  if (previous !== null) await previous.shutdown(STOP_DEADLINE_MS);

  const directory = app.preview(releaseId);
  // A fresh copy every time. A preview that reused the last one would show
  // the person the effects of the previous preview as if they were theirs.
  rmSync(directory, { recursive: true, force: true });
  if (existsSync(app.data)) snapshotDirectory(app.data, directory);
  else mkdirSync(directory, { recursive: true, mode: 0o700 });

  const child = await deps.supervisor.start({
    appId,
    releaseDir: app.release(releaseId),
    releaseId,
    dataDir: directory,
    mode: 'preview',
  });
  // A new child: whatever the checks said was about another one.
  deps.states.update(appId, { preview: child, releaseId, checks: null, previewWasRunning: true });
  // The release goes in its column, not the message: the sanitiser would take
  // 32 hex characters for a secret.
  deps.log?.event('log', 'a preview started', undefined, { ...origin, appId, releaseId });
  return child;
}
