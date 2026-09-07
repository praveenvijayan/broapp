/**
 * Finishing what a previous launcher started.
 *
 * The journal says what an activation was *about to do* when the process
 * stopped. Recovery reads that, looks at the filesystem to see how far the
 * action actually got, and either completes it or abandons it — and then, in
 * every case, gets the application serving again. A person who force-quit
 * during an update should find their application working when they come back,
 * not a directory of half-renamed data.
 *
 * Recovery never deletes a `data-prev-*` directory or a snapshot. Those are the
 * only copies of what the data used to be, and the moment to throw them away is
 * a decision somebody makes on purpose, not a side effect of starting up.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';

import type { HostLogger } from 'broapp/host';

import { readCurrent, setCurrent, type Layout } from '../spec/index.ts';

import type { Activation, Journal } from './journal.ts';
import type { ChildHandle, Supervisor } from './supervisor.ts';

/** What recovery did about one interrupted activation. */
export interface Recovered {
  readonly activationId: number;
  readonly appId: string;
  /** What was found on disk, in a sentence. */
  readonly finding: string;
  /** The release now pointed at. */
  readonly serving: string | null;
  readonly outcome: 'completed' | 'abandoned';
}

/** Options for {@link recover}. */
export interface RecoverParams {
  readonly layout: Layout;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly logger?: HostLogger;
  /**
   * Start the recovered application. Off for a `status`-style caller that only
   * wants the filesystem left consistent.
   */
  readonly start?: boolean;
}

/** Resolve every activation the journal left unfinished. */
export async function recover(params: RecoverParams): Promise<readonly Recovered[]> {
  const logger: HostLogger = params.logger ?? console;
  const results: Recovered[] = [];

  for (const activation of params.journal.unfinished()) {
    const outcome = resolveOne(params.layout, params.journal, activation, logger);
    results.push(outcome);
    if (params.start === false) continue;
    const release = outcome.serving;
    if (release === null) continue;
    try {
      await startServing(params, activation.appId, release);
    } catch (cause) {
      logger.error(`[autoapp] ${activation.appId} could not be started after recovery: ${String(cause)}`);
    }
  }
  return results;
}

/** Put the filesystem and the journal back into a state somebody can use. */
function resolveOne(
  root: Layout,
  journal: Journal,
  activation: Activation,
  logger: HostLogger,
): Recovered {
  const app = root.app(activation.appId);
  const base = { activationId: activation.id, appId: activation.appId } as const;

  switch (activation.phase) {
    // Nothing was copied and nothing was renamed. The live directory is exactly
    // as it was, so the only thing to do is stop pretending an update is in
    // progress.
    case 'requested':
    case 'drained': {
      journal.advance(activation.id, 'failed-before-switch', {
        error: `interrupted at ${activation.phase}`,
      });
      return {
        ...base,
        finding: `interrupted at ${activation.phase}, before anything was copied`,
        serving: activation.fromRelease ?? readCurrent(root, activation.appId),
        outcome: 'abandoned',
      };
    }

    // A copy may exist, and may be half-migrated. It is only ever a copy — the
    // live directory has not been touched — so it goes.
    case 'snapshotted':
    case 'migrated':
    case 'checked': {
      const had = existsSync(app.dataNext);
      rmSync(app.dataNext, { recursive: true, force: true });
      journal.advance(activation.id, 'failed-before-switch', {
        error: `interrupted at ${activation.phase}`,
      });
      return {
        ...base,
        finding: `interrupted at ${activation.phase}${had ? '; the unfinished copy was discarded' : ''}`,
        serving: activation.fromRelease ?? readCurrent(root, activation.appId),
        outcome: 'abandoned',
      };
    }

    // The interesting one. Two renames make the switch, and the crash may have
    // landed between them.
    case 'switched': {
      const prev = activation.dataPrev;
      const movedAway = prev !== null && existsSync(prev);
      const dataThere = existsSync(app.data);
      const nextThere = existsSync(app.dataNext);

      if (!dataThere && nextThere) {
        // Only the first rename happened: the old data is safely aside and the
        // migrated copy is still waiting under its own name. Finishing is the
        // right answer — it has already been checked against this data.
        renameSync(app.dataNext, app.data);
        setCurrent(root, activation.appId, activation.toRelease);
        journal.advance(activation.id, 'serving');
        journal.advance(activation.id, 'done');
        return {
          ...base,
          finding: 'interrupted between the two renames; the second was completed',
          serving: activation.toRelease,
          outcome: 'completed',
        };
      }

      if (dataThere && movedAway) {
        // Both renames happened. `current` may or may not have been written, so
        // it is written now.
        setCurrent(root, activation.appId, activation.toRelease);
        journal.advance(activation.id, 'serving');
        journal.advance(activation.id, 'done');
        return {
          ...base,
          finding: 'interrupted after both renames; the switch was already complete',
          serving: activation.toRelease,
          outcome: 'completed',
        };
      }

      // Neither rename happened, so the candidate was checked but never
      // switched to. The live data is untouched.
      rmSync(app.dataNext, { recursive: true, force: true });
      journal.advance(activation.id, 'failed-before-switch', {
        error: 'interrupted at switched, before either rename',
      });
      return {
        ...base,
        finding: 'interrupted at switched, before either rename',
        serving: activation.fromRelease ?? readCurrent(root, activation.appId),
        outcome: 'abandoned',
      };
    }

    // The switch is done and `current` names the new release. All that was left
    // was starting it.
    case 'serving': {
      const current = readCurrent(root, activation.appId) ?? activation.toRelease;
      journal.advance(activation.id, 'done');
      return {
        ...base,
        finding: 'interrupted while starting the new release; the switch was complete',
        serving: current,
        outcome: 'completed',
      };
    }

    default: {
      // A terminal phase should never reach here, because `unfinished()`
      // excludes them. Saying so is cheaper than assuming it.
      logger.warn(`[autoapp] activation ${String(activation.id)} is already finished`);
      return {
        ...base,
        finding: `already ${activation.phase}`,
        serving: readCurrent(root, activation.appId),
        outcome: 'abandoned',
      };
    }
  }
}

/** Start one application's current release, unless it is already running. */
async function startServing(
  params: RecoverParams,
  appId: string,
  releaseId: string,
): Promise<ChildHandle | null> {
  const already = params.supervisor.children.find(
    (handle) => handle.appId === appId && handle.mode === 'live',
  );
  if (already !== undefined) return already;
  const app = params.layout.app(appId);
  return await params.supervisor.start({
    appId,
    releaseDir: app.release(releaseId),
    releaseId,
    dataDir: app.data,
    mode: 'live',
  });
}
