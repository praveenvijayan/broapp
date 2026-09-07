/**
 * Moving an application from one release to another, with its data.
 *
 * A release and the data it understands are one thing, not two. The whole
 * sequence exists to keep them together: snapshot, migrate a *copy*, check the
 * candidate against the copy, and only then swap both at once. Nothing touches
 * the live directory until the candidate has been shown to work on a copy of
 * exactly the data it is about to be given.
 *
 * Every phase is journaled *before* the action it names. That ordering is what
 * makes recovery possible: a launcher that dies has recorded what it was about
 * to do, not what it finished, and "about to" is the question recovery has to
 * answer.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';

import type { HostLogger } from 'broapp/host';

import {
  diffCapabilities,
  isGranted,
  readCurrent,
  readGrants,
  readRelease,
  setCurrent,
  type AcceptanceExample,
  type Layout,
} from '../spec/index.ts';

import { connectToChild } from './client.ts';
import { snapshotDirectory } from './snapshot.ts';
import type { Journal, Phase } from './journal.ts';
import type { ChildHandle, Supervisor } from './supervisor.ts';

/** Options for {@link activate}. */
export interface ActivateParams {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly appId: string;
  readonly releaseId: string;
  readonly drainDeadlineMs?: number;
  readonly logger?: HostLogger;
}

/** What an activation did. */
export type ActivateResult =
  | { readonly ok: true; readonly child: ChildHandle; readonly previousRelease: string | null }
  | {
      readonly ok: false;
      readonly phase: string;
      readonly reason: string;
      readonly recovered: 'previous-serving' | 'stopped';
    };

const DEFAULT_DRAIN_DEADLINE_MS = 10_000;
/** How long a child gets to stop before it is killed. */
const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * A test hook for crash injection.
 *
 * Honoured only under `NODE_ENV=test`, so a stray environment variable on a
 * real machine cannot make an activation abandon somebody's data halfway
 * through. Recovery is the thing being tested and it can only be tested by
 * actually stopping partway.
 */
function crashPoint(): string | null {
  if (process.env['NODE_ENV'] !== 'test') return null;
  return process.env['AUTOAPP_TEST_CRASH_AT'] ?? null;
}

/** Thrown by the crash hook. Never caught by the recovery paths below. */
class InjectedCrash extends Error {
  constructor(phase: string) {
    super(`crash injected at ${phase}`);
    this.name = 'InjectedCrash';
  }
}

/**
 * Run every acceptance example against a running child, over one connection.
 *
 * One connection, not one per example: a launch URL carries a *single-use*
 * token, so the second `connectToChild` with the same URL is refused with 403.
 * The launcher is the one process allowed to hold that URL in memory, and this
 * is the only place that needs to speak to a candidate before anybody else can.
 */
async function runExamples(
  url: string,
  examples: readonly AcceptanceExample[],
): Promise<string | null> {
  if (examples.length === 0) return null;
  let bridge: Awaited<ReturnType<typeof connectToChild>>;
  try {
    bridge = await connectToChild(url);
  } catch (cause) {
    return `the candidate could not be reached: ${String(cause instanceof Error ? cause.message : cause)}`;
  }
  try {
    for (const example of examples) {
      for (const step of example.steps) {
        const output: unknown = await bridge.call(step.route, step.input);
        if (step.expect === undefined) continue;
        if (JSON.stringify(output) !== JSON.stringify(step.expect)) {
          return `${example.id}: ${step.route} returned ${JSON.stringify(output)}, not ${JSON.stringify(step.expect)}`;
        }
      }
    }
    return null;
  } catch (cause) {
    return String(cause instanceof Error ? cause.message : cause);
  } finally {
    await bridge.close();
  }
}

/** Activate one release. */
export async function activate(params: ActivateParams): Promise<ActivateResult> {
  const { layout: root, supervisor, journal, appId, releaseId } = params;
  const logger: HostLogger = params.logger ?? console;
  const app = root.app(appId);
  const drainDeadlineMs = params.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;

  const fromRelease = readCurrent(root, appId);
  const id = journal.begin({ appId, fromRelease, toRelease: releaseId });
  const startedAt = journal.read(id)?.startedAt ?? Date.now();
  /** The child currently serving the live data, if any. */
  let serving = supervisor.children.find((handle) => handle.appId === appId && handle.mode === 'live') ?? null;

  /** Journal a phase, then let a crash hook stop right after it. */
  const reach = (phase: Phase, details?: Parameters<Journal['advance']>[2]): void => {
    journal.advance(id, phase, details);
    if (crashPoint() === phase) throw new InjectedCrash(phase);
  };

  /** Give up before the switch: the previous release is still whole. */
  const giveUpBeforeSwitch = async (
    phase: string,
    why: string,
    options: { removeNext?: boolean; stopCandidate?: ChildHandle | null } = {},
  ): Promise<ActivateResult> => {
    if (options.stopCandidate != null) await options.stopCandidate.shutdown(SHUTDOWN_DEADLINE_MS);
    if (options.removeNext === true) rmSync(app.dataNext, { recursive: true, force: true });
    journal.advance(id, 'failed-before-switch', { error: why });

    // Put the previous release back in front of the person, if it is not
    // already. An update that failed should cost them nothing but the time.
    let recovered: 'previous-serving' | 'stopped' = 'stopped';
    if (serving !== null && (await Promise.race([serving.exited, Promise.resolve('alive')])) === 'alive') {
      recovered = 'previous-serving';
    } else if (fromRelease !== null) {
      try {
        serving = await supervisor.start({
          appId,
          releaseDir: app.release(fromRelease),
          releaseId: fromRelease,
          dataDir: app.data,
          mode: 'live',
        });
        recovered = 'previous-serving';
      } catch (cause) {
        logger.error(`[autoapp] ${appId} could not be restarted after a failed update: ${String(cause)}`);
      }
    }
    return { ok: false, phase, reason: why, recovered };
  };

  try {
    // 1. requested — is this release even allowed to run here?
    reach('requested');
    const spec = readRelease(root, appId, releaseId);
    const grants = readGrants(root, appId);
    const diff = diffCapabilities(spec.manifest.capabilities, grants?.capabilities ?? []);
    if (!isGranted(diff)) {
      journal.advance(id, 'failed-before-switch', {
        error: 'release asks for capabilities that have not been granted',
      });
      return {
        ok: false,
        phase: 'requested',
        reason: `release asks for capabilities that have not been granted: ${diff.added
          .map((capability) => capability.kind)
          .join(', ')}`,
        recovered: serving === null ? 'stopped' : 'previous-serving',
      };
    }
    if (serving !== null && spec.manifest.schemaVersion < serving.schemaVersion) {
      journal.advance(id, 'failed-before-switch', { error: 'the release is behind the running schema' });
      return {
        ok: false,
        phase: 'requested',
        reason: `release ${releaseId} is at schema ${String(spec.manifest.schemaVersion)}, behind the running ${String(serving.schemaVersion)}; migrations are forward only`,
        recovered: 'previous-serving',
      };
    }

    // 2. drained — stop admitting writes and let what is running finish.
    reach('drained');
    if (serving !== null) {
      const drained = await serving.drain(drainDeadlineMs);
      if (!drained) {
        // The child is left running and its gate is still paused from the
        // drain; a caller that wants it serving again resumes it. Nothing has
        // been copied or renamed, so there is nothing to undo.
        return await giveUpBeforeSwitch(
          'drained',
          'the application was still busy when the drain deadline passed',
        );
      }
    }

    // 3. snapshotted — a keepsake, and the copy the candidate will be checked on.
    const snapshotDir = `${app.snapshots}/${String(startedAt)}-${fromRelease ?? 'none'}`;
    reach('snapshotted', { snapshotDir });
    if (serving !== null) {
      await serving.shutdown(SHUTDOWN_DEADLINE_MS);
      serving = null;
    }
    rmSync(app.dataNext, { recursive: true, force: true });
    if (existsSync(app.data)) {
      snapshotDirectory(app.data, snapshotDir);
      snapshotDirectory(app.data, app.dataNext);
    } else {
      // A first activation has nothing to copy. The copy still has to exist, so
      // the migration has somewhere to run.
      mkdirSync(app.dataNext, { recursive: true, mode: 0o700 });
    }

    // 4. migrated — forward only, and against the copy.
    reach('migrated');
    try {
      const moved = await supervisor.migrate({
        appId,
        releaseDir: app.release(releaseId),
        releaseId,
        dataDir: app.dataNext,
      });
      logger.warn(`[autoapp] ${appId} migrated ${String(moved.from)} → ${String(moved.to)} on a copy`);
    } catch (cause) {
      return await giveUpBeforeSwitch('migrated', `the data could not be migrated: ${String(cause)}`, {
        removeNext: true,
      });
    }

    // 5. checked — start the candidate on the copy, paused, and try it.
    reach('checked');
    let candidate: ChildHandle | null = null;
    try {
      candidate = await supervisor.start({
        appId,
        releaseDir: app.release(releaseId),
        releaseId,
        dataDir: app.dataNext,
        mode: 'live',
        paused: true,
      });
      const health = await candidate.health();
      if (health.state !== 'serving') {
        return await giveUpBeforeSwitch('checked', `the candidate reported state ${health.state}`, {
          removeNext: true,
          stopCandidate: candidate,
        });
      }
      const problem = await runExamples(candidate.url, spec.acceptance);
      if (problem !== null) {
        return await giveUpBeforeSwitch('checked', `an acceptance example failed: ${problem}`, {
          removeNext: true,
          stopCandidate: candidate,
        });
      }
    } catch (cause) {
      if (cause instanceof InjectedCrash) throw cause;
      return await giveUpBeforeSwitch('checked', `the candidate would not run: ${String(cause)}`, {
        removeNext: true,
        stopCandidate: candidate,
      });
    }

    // 6. switched — the point of no return for the pair.
    //
    // After the second rename, the live data directory *is* the migrated copy.
    // Going back is no longer a rename: the new release may accept a write at
    // any moment from here, and undoing that is a decision for a person rather
    // than a step in a function.
    const dataPrev = app.dataPrev(startedAt);
    reach('switched', { dataPrev });
    await candidate.shutdown(SHUTDOWN_DEADLINE_MS);
    if (existsSync(app.data)) renameSync(app.data, dataPrev);
    if (crashPoint() === 'switched-half') throw new InjectedCrash('switched-half');
    renameSync(app.dataNext, app.data);
    setCurrent(root, appId, releaseId);
    if (crashPoint() === 'switched-both') throw new InjectedCrash('switched-both');

    // 7. serving — the new release, on the data it was checked against.
    reach('serving');
    let child: ChildHandle;
    try {
      child = await supervisor.start({
        appId,
        releaseDir: app.release(releaseId),
        releaseId,
        dataDir: app.data,
        mode: 'live',
      });
    } catch (cause) {
      // The new release never reported itself ready, so it cannot have accepted
      // a write. The pair can go back exactly as it was.
      const why = `the new release would not start: ${String(cause)}`;
      try {
        rmSync(app.dataNext, { recursive: true, force: true });
        renameSync(app.data, app.dataNext);
        renameSync(dataPrev, app.data);
        if (fromRelease !== null) setCurrent(root, appId, fromRelease);
        journal.advance(id, 'rolled-back', { error: why });
        if (fromRelease !== null) {
          serving = await supervisor.start({
            appId,
            releaseDir: app.release(fromRelease),
            releaseId: fromRelease,
            dataDir: app.data,
            mode: 'live',
          });
          return { ok: false, phase: 'serving', reason: why, recovered: 'previous-serving' };
        }
      } catch (undoing) {
        logger.error(`[autoapp] ${appId} could not be rolled back: ${String(undoing)}`);
        journal.advance(id, 'failed-after-switch', { error: why });
      }
      return { ok: false, phase: 'serving', reason: why, recovered: 'stopped' };
    }

    // 8. done.
    reach('done');
    return { ok: true, child, previousRelease: fromRelease };
  } catch (cause) {
    if (cause instanceof InjectedCrash) throw cause;
    const why = String(cause instanceof Error ? cause.message : cause);
    const phase = journal.read(id)?.phase ?? 'requested';
    if (phase === 'switched' || phase === 'serving') {
      journal.advance(id, 'failed-after-switch', { error: why });
      return { ok: false, phase, reason: why, recovered: 'stopped' };
    }
    return await giveUpBeforeSwitch(phase, why, { removeNext: true });
  }
}
