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
import { createGate, createHostApp, openBrowser as openSystemBrowser, publicError } from 'broapp/host';
import type { Gate, HostApp, HostLogger } from 'broapp/host';
import type { Bridge } from 'brobridge';

import { startPreview } from '../engineer/preview.ts';
import type { CandidateStates } from '../engineer/state.ts';
import type { EventLog } from '../knowledge/log.ts';
import type { Session } from '../knowledge/session.ts';
import {
  listReleases,
  readCurrent,
  readGrants,
  readRelease,
  releasePageBytes,
  writeGrants,
  type Layout,
} from '../spec/index.ts';

import { activate } from './activate.ts';
import { appIds, listApps, serving as servingChild } from './apps.ts';
import { launcherContract, type LauncherContract } from './contract.ts';
import { createApplication } from './create.ts';
import type { Journal } from './journal.ts';
import type { StarterTemplate } from './starter.ts';
import type { ChildHandle, Supervisor } from './supervisor.ts';
import type { PrepareOptions } from './workspace.ts';

/** What the launcher's host app needs. */
export interface CreateLauncherAppOptions {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly states: CandidateStates;
  /** The launcher's own gate. `user` for the tab's clicks; the engineer shares it. */
  readonly gate: Gate;
  readonly logger?: HostLogger;
  /** Where a person's own preview starts and activations are written down. */
  readonly log?: EventLog;
  /** Where the application the person selected is remembered. */
  readonly session?: Session;
  /**
   * Open a URL in the person's browser. Defaults to the operating system's
   * opener; tests pass a stub so a suite does not open tabs.
   */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  /** The starter workspace this launcher carries, for `launcher.appCreate`. */
  readonly template: StarterTemplate;
  /** The dependency ranges a created workspace is written with. */
  readonly versions: { readonly broapp: string; readonly autoapp: string };
  /** Creation's two spawns, injectable so a test reaches no registry and no git. */
  readonly install?: PrepareOptions['install'];
  readonly initGit?: PrepareOptions['initGit'];
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
  const serving = (appId: string): ChildHandle | null => servingChild(supervisor, appId);

  const openBrowser = options.openBrowser ?? openSystemBrowser;
  /**
   * Children whose launch URL has been presented once. A launch token burns
   * on its first valid presentation, so a second visit goes to the bare origin
   * instead and rides on the session cookie that presentation minted.
   */
  const presented = new WeakSet<ChildHandle>();

  /**
   * Open a child's tab from the host, never from the launcher's page. A
   * `window.open` from the launcher's origin to the child's arrives with
   * `Sec-Fetch-Site: same-site`, which Brobridge's fence refuses; a tab the
   * operating system opens arrives with `none`. When no browser can be
   * opened, the address goes to the launcher's terminal — the same place
   * `serve` prints it — and the tab is told so.
   */
  async function openTab(child: ChildHandle): Promise<{ opened: boolean }> {
    const url = presented.has(child) ? `${new URL(child.url).origin}/` : child.url;
    presented.add(child);
    const opened = await openBrowser(url);
    if (!opened) logger.warn(`could not open a browser; open this address yourself: ${url}`);
    return { opened };
  }

  // The same rows the engineer's `apps.list` gets, from the same helper.
  host.operation('launcher.appsList', () => ({
    apps: listApps(root, supervisor, journal).map((row) => ({ ...row })),
  }));

  /**
   * Start an application if it is not running, and open its tab.
   *
   * One function rather than two: `appOpen` is a person clicking Open, and
   * `appCreate` ends by doing exactly the same thing to the application it has
   * just made. A copy of this that drifted would be a copy that started a child
   * the other one would not.
   */
  async function openApplication(appId: string): Promise<{ opened: boolean }> {
    const existing = serving(appId);
    if (existing !== null) return await openTab(existing);
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
    // Opened from here. The address is never returned to the tab, never
    // written down, never given to a model.
    return await openTab(child);
  }

  host.operation('launcher.appCreate', async ({ appId, name, description }) => {
    const created = await createApplication({
      layout: root,
      template: options.template,
      versions: options.versions,
      appId,
      name,
      ...(description === undefined ? {} : { description }),
      logger,
      ...(options.install === undefined ? {} : { install: options.install }),
      ...(options.initGit === undefined ? {} : { initGit: options.initGit }),
    });
    if (!created.ok) {
      return {
        ok: false,
        releaseId: null,
        installed: created.installed,
        problems: created.problems.map((problem) => ({ ...problem })),
        notes: [...created.notes],
        opened: false,
      };
    }
    const { opened } = await openApplication(appId);
    return {
      ok: true,
      releaseId: created.releaseId,
      installed: created.installed,
      problems: [],
      notes: [...created.notes],
      opened,
    };
  });

  host.operation('launcher.appOpen', async ({ appId }) => await openApplication(appId));

  host.operation('launcher.appSelect', ({ appId }) => {
    if (!appIds(root).includes(appId)) throw publicError.notFound(`There is no application called ${appId}.`);
    options.session?.select(appId);
    return { ok: true };
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
    const current = readCurrent(root, appId);
    return {
      pageBytes: status.releaseId === null ? null : releasePageBytes(root, appId, status.releaseId),
      pageBytesBefore: current === null ? null : releasePageBytes(root, appId, current),
      appId: status.appId,
      releaseId: status.releaseId,
      problems: [...status.problems],
      changed: [...status.changed],
      previewRunning: status.previewRunning,
      checks: status.checks.map((check) => ({ ...check })),
      addedCapabilities: [...status.addedCapabilities],
      removedCapabilities: [...status.removedCapabilities],
      editsSinceBuild: status.editsSinceBuild,
      previewLost: status.previewLost,
      checksVerified: status.checksVerified,
      stagesRun: [...status.stagesRun],
    };
  });

  host.operation('launcher.previewStart', async ({ appId }, context) => {
    const releaseId = states.get(appId).releaseId;
    if (releaseId === null) {
      throw publicError.unavailable('Nothing has been built for this application, so there is no preview to start.');
    }
    // Exactly what the engineer's `candidate.preview` runs. A click is its own
    // run, so its request identifier is both the run and the call.
    await startPreview(
      { layout: root, supervisor, states, ...(options.log === undefined ? {} : { log: options.log }) },
      appId,
      releaseId,
      { runId: context.requestId, callId: context.requestId },
    );
    return { previewRunning: states.get(appId).preview !== null };
  });

  host.operation('launcher.previewOpen', async ({ appId }) => {
    const preview = states.get(appId).preview;
    if (preview === null) {
      throw publicError.unavailable('There is no preview running for this application.');
    }
    return await openTab(preview);
  });

  host.operation('launcher.activate', async ({ appId, releaseId }, context) => {
    // The same function the engineer's tool reaches. What differs is the channel
    // the request arrived on, which the journal's run record already carries.
    const preview = states.get(appId).preview;
    if (preview !== null) await preview.shutdown(STOP_DEADLINE_MS);
    states.update(appId, { preview: null, previewWasRunning: false });
    const result = await activate({ layout: root, supervisor, journal, appId, releaseId, logger });
    options.log?.event(
      'activate',
      result.ok ? 'the release was activated' : 'the activation did not complete',
      result.ok
        ? { ok: true, releaseId }
        : { ok: false, phase: result.phase, reason: result.reason, recovered: result.recovered, releaseId },
      { runId: context.requestId, callId: context.requestId, appId, releaseId },
    );
    if (!result.ok) return { ok: false, phase: result.phase, reason: result.reason };
    // The new release is a new child on a new port with a new credential, so
    // the tab that showed the old one cannot be reloaded into it. Open the new
    // one, the way a click on Open would.
    const child = serving(appId);
    const opened = child === null ? false : (await openTab(child)).opened;
    return { ok: true, previousRelease: result.previousRelease, opened };
  });

  return {
    mount: (bridge: Bridge) => host.mount(bridge),
    get children() {
      return supervisor.children;
    },
  };
}

/**
 * How long one of the launcher's questions waits: ten minutes.
 *
 * Not the gate's own two minutes, which is right for an application: a
 * question there comes from a person's own workflow run or an MCP call they
 * are watching. The engineer's questions do not. Report 08b measured a local
 * model spending seven to fourteen minutes composing a single `source.edit`
 * and then handing the person two minutes to answer it; two of six attempts
 * were lost to that arithmetic rather than to anything either of them did.
 */
export const LAUNCHER_CONFIRM_TIMEOUT_MS = 600_000;

/**
 * How many model steps one engineer turn may take: forty.
 *
 * Not the AI layer's eight, which is right for an assistant answering a
 * question about its application. The engineer's loop is read, edit, build,
 * preview, check and explain, and eight steps do not hold it. Report 12b's
 * rerun of the 08c request ended after sixteen tool calls in exactly eight
 * model steps, with two edits landed, no closing text and no build — the cap,
 * not the model, ended the turn. 08c's turn (eighteen calls, ending right after
 * an edit) fits the same cap.
 */
export const LAUNCHER_MAX_STEPS = 40;

/** The launcher's own gate: its tab's clicks and its engineer's tools. */
export function createLauncherGate(options: {
  releaseId: string;
  recorder?: Parameters<typeof createGate>[0]['recorder'];
  confirmTimeoutMs?: number;
  logger?: HostLogger;
}): Gate {
  return createGate({
    appId: 'launcher',
    releaseId: options.releaseId,
    confirmTimeoutMs: options.confirmTimeoutMs ?? LAUNCHER_CONFIRM_TIMEOUT_MS,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
