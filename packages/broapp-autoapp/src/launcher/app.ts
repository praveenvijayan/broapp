/**
 * The launcher, as an application.
 *
 * One tab, one bridge, and the engineer in a side column. It is the only
 * process holding every application's launch URL, which is why opening an
 * application is a route here rather than something a person does with a
 * terminal — and why that route is the person's own click and never a tool.
 *
 * The launcher runs application code in exactly one place: nowhere. Building,
 * migrating, previewing and serving all happen in child processes. What this
 * file does is decide, record, and hand out addresses.
 */
import { readdirSync } from 'node:fs';

import { createGate, createHostApp, publicError } from 'broapp/host';
import type { Gate, HostApp, HostLogger } from 'broapp/host';
import type { Bridge } from 'brobridge';

import type { CandidateStates } from '../engineer/state.ts';
import {
  listReleases,
  readCurrent,
  readGrants,
  readRelease,
  writeGrants,
  type Layout,
} from '../spec/index.ts';

import { activate } from './activate.ts';
import { launcherContract, type LauncherContract } from './contract.ts';
import type { Journal } from './journal.ts';
import type { ChildHandle, Supervisor } from './supervisor.ts';

/** What the launcher's host app needs. */
export interface CreateLauncherAppOptions {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly states: CandidateStates;
  /** The launcher's own gate. `user` for the tab's clicks; the engineer shares it. */
  readonly gate: Gate;
  readonly logger?: HostLogger;
}

/** The launcher's routes, ready to mount. */
export interface LauncherApp {
  mount(bridge: Bridge): void;
  /** Applications this launcher has started. */
  readonly children: readonly ChildHandle[];
}

/** How long a child gets to drain, and then to stop. */
const DRAIN_DEADLINE_MS = 10_000;
const STOP_DEADLINE_MS = 10_000;

/** Every application that has a directory under the root. */
function appIds(root: Layout): readonly string[] {
  try {
    return readdirSync(`${root.root}/apps`).sort();
  } catch {
    return [];
  }
}

/** Build the launcher's host app. */
export function createLauncherApp(options: CreateLauncherAppOptions): LauncherApp {
  const { layout: root, supervisor, journal, states, gate } = options;
  const logger: HostLogger = options.logger ?? console;

  // An ordinary host app: `launcher` is not a reserved group, because nothing
  // else is ever mounted on this bridge but the AI layer, which owns `ai`.
  const host: HostApp<LauncherContract> = createHostApp<LauncherContract>(launcherContract, {
    gate,
    logger,
  });

  /** The live child serving one application, if any. */
  const serving = (appId: string): ChildHandle | null =>
    supervisor.children.find((child) => child.appId === appId && child.mode === 'live') ?? null;

  host.operation('launcher.appsList', () => ({
    apps: appIds(root).map((appId) => {
      const child = serving(appId);
      const currentRelease = readCurrent(root, appId);
      let name = appId;
      if (currentRelease !== null) {
        try {
          name = readRelease(root, appId, currentRelease).manifest.name;
        } catch {
          // A release directory that will not parse is still an application
          // somebody can look at; it just has no better name than its id.
        }
      }
      return {
        appId,
        name,
        currentRelease,
        serving: child !== null,
        pid: child?.pid ?? null,
        schemaVersion: child?.schemaVersion ?? null,
        activationPending: journal.unfinished().some((row) => row.appId === appId),
      };
    }),
  }));

  host.operation('launcher.appOpen', async ({ appId }) => {
    const existing = serving(appId);
    if (existing !== null) return { url: existing.url };
    const releaseId = readCurrent(root, appId);
    if (releaseId === null) throw publicError.notFound(`${appId} has no current release yet.`);
    const app = root.app(appId);
    const child = await supervisor.start({
      appId,
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    // Returned to the tab, which opens it and forgets it. Never logged, never
    // written down, never given to a model.
    return { url: child.url };
  });

  host.operation('launcher.appStop', async ({ appId }) => {
    const child = serving(appId);
    if (child === null) return { stopped: false };
    await child.drain(DRAIN_DEADLINE_MS);
    await child.shutdown(STOP_DEADLINE_MS);
    return { stopped: true };
  });

  host.operation('launcher.releasesList', ({ appId }) => {
    const current = readCurrent(root, appId);
    return {
      releases: listReleases(root, appId).map((release) => ({
        releaseId: release.releaseId,
        createdAt: release.createdAt,
        schemaVersion: readRelease(root, appId, release.releaseId).manifest.schemaVersion,
        current: release.releaseId === current,
      })),
    };
  });

  host.operation('launcher.journalList', ({ appId }) => ({
    activations: journal.history(appId, 100).map((row) => ({
      id: row.id,
      fromRelease: row.fromRelease,
      toRelease: row.toRelease,
      phase: row.phase,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      error: row.error,
    })),
  }));

  host.operation('launcher.grantsGet', ({ appId }) => {
    const releaseId = readCurrent(root, appId);
    const grants = readGrants(root, appId);
    // What the *candidate* asks for when there is one, because that is what a
    // person is being asked to decide about.
    const candidateId = states.get(appId).releaseId ?? releaseId;
    const requested =
      candidateId === null ? [] : readRelease(root, appId, candidateId).manifest.capabilities;
    return {
      releaseId: candidateId,
      granted: [...(grants?.capabilities ?? [])],
      requested: [...requested],
    };
  });

  host.operation('launcher.grantsSet', ({ appId, releaseId, capabilities }) => {
    // The release the person was shown has to still be the one being asked
    // about. If a new candidate has been built since, the list they read is not
    // the list they would be granting.
    const shown = states.get(appId).releaseId ?? readCurrent(root, appId);
    if (shown !== releaseId) {
      throw publicError.conflict(
        'What this application asks for has changed since you were shown it. Look again before granting.',
      );
    }
    writeGrants(root, appId, {
      appId,
      releaseId,
      grantedAt: Date.now(),
      capabilities,
    });
    return { ok: true };
  });

  host.operation('launcher.candidateStatus', ({ appId }) => {
    const status = states.status(appId);
    return {
      appId: status.appId,
      releaseId: status.releaseId,
      problems: [...status.problems],
      changed: [...status.changed],
      previewRunning: status.previewRunning,
      checks: status.checks.map((check) => ({ ...check })),
      addedCapabilities: [...status.addedCapabilities],
      removedCapabilities: [...status.removedCapabilities],
    };
  });

  host.operation('launcher.previewOpen', ({ appId }) => {
    const preview = states.get(appId).preview;
    if (preview === null) {
      throw publicError.unavailable('There is no preview running for this application.');
    }
    return { url: preview.url };
  });

  host.operation('launcher.activate', async ({ appId, releaseId }) => {
    // The same function the engineer's tool reaches. What differs is the channel
    // the request arrived on, which the journal's run record already carries.
    const preview = states.get(appId).preview;
    if (preview !== null) {
      await preview.shutdown(STOP_DEADLINE_MS);
      states.update(appId, { preview: null });
    }
    const result = await activate({ layout: root, supervisor, journal, appId, releaseId, logger });
    return result.ok
      ? { ok: true, previousRelease: result.previousRelease }
      : { ok: false, phase: result.phase, reason: result.reason };
  });

  return {
    mount: (bridge: Bridge) => host.mount(bridge),
    get children() {
      return supervisor.children;
    },
  };
}

/** The launcher's own gate: its tab's clicks and its engineer's tools. */
export function createLauncherGate(options: {
  releaseId: string;
  recorder?: Parameters<typeof createGate>[0]['recorder'];
  logger?: HostLogger;
}): Gate {
  return createGate({
    appId: 'launcher',
    releaseId: options.releaseId,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
