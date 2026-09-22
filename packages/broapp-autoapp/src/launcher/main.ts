#!/usr/bin/env bun
/**
 * The launcher, as a command.
 *
 * One binary, several roles. Run with `--child` or `--migrate` it *is* the
 * child, which is how a compiled launcher can start an application on a machine
 * with no Bun installation: it spawns itself. Run with anything else it is the
 * supervisor.
 *
 * The launcher's own browser tab — the list of applications and the engineer
 * that proposes changes to them — is prompt 07. What is here is the part
 * underneath: a CLI over the supervisor, the builder and the activation
 * sequence.
 */
import launcherPage from '../../dist/launcher-page.html' with { type: 'text' };
import packedTemplates from '../../dist/templates.json' with { type: 'json' };
import selfManifest from '../../package.json' with { type: 'json' };

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { anthropic } from 'broapp-ai-anthropic';
import { customServer, ollama, openai, openrouter } from 'broapp-ai-compatible';
import { ensureDataDir, openBrowser, startApp } from 'broapp/host';
import type { RunningApp } from 'broapp/host';

import { createCandidateStates } from '../engineer/state.ts';
import { createRunStore } from '../host/run-store.ts';
import { processAlive } from '../child/watch.ts';
import { openIntents, type Executor, type IntentStore } from '../intent/index.ts';
import { connectControl, readControlFile, type ControlClient } from '../mcp/client.ts';
import {
  createEventLog,
  createEvidence,
  openKnowledge,
  openSession,
  rebuildLinks,
  runEvaluateCommand,
  runKnowledgeCommand,
  runLinksCommand,
  runReplayCommand,
  type EventLog,
  type Knowledge,
} from '../knowledge/index.ts';

import { runChild, runMigrate } from '../child/run-child.ts';
import {
  defaultRoot,
  layout,
  listReleases,
  readCurrent,
  readGrants,
  setCurrent,
  writeGrants,
  type Layout,
} from '../spec/index.ts';

import { activate } from './activate.ts';
import { appIds } from './apps.ts';
import { buildCandidate } from './candidate.ts';
import { startControl, type Control, type ControlFile, type LauncherStatus } from './control.ts';
import { openJournal, type Journal } from './journal.ts';
import { keepServing } from './keepalive.ts';
import { recover, restoreServing } from './recover.ts';
import { addServing, removeServing } from './serving.ts';
import { clearStanding, readStanding, writeStanding } from './standing.ts';
import { STANDING_WORDS } from './standing-words.ts';
import { createSupervisor, type Supervisor } from './supervisor.ts';
import { createLauncherGate } from './app.ts';
import { createApplication } from './create.ts';
import { locateApplication, requireSource } from './location.ts';
import { describeReceipt, describeRemoval, leftSentence, removeApplication, type RemovalDescription } from './remove.ts';
import { isTemplateName, type TemplateName, type Templates } from './starter.ts';
import { createLauncherTab } from './tab.ts';
import { adopt, prepareWorkspace } from './workspace.ts';

/**
 * The launcher's own page, inlined into the binary.
 *
 * `@types/bun` declares every `*.html` import as `HTMLBundle` without looking at
 * the import attribute. With `{ type: "text" }` the value really is a string.
 */
const page = launcherPage as unknown as string;

/**
 * The starter workspaces, inlined into the binary the same way.
 *
 * A person who downloaded a launcher has no source workspace to import, so the
 * launcher carries two: an items list to take apart, and a blank page to
 * describe. `scripts/build-template.ts` packs `templates/autoapp-starter` and
 * `templates/autoapp-blank` into this file; it is a build artefact, not in git,
 * and `files` ships it.
 */
const templates = packedTemplates as unknown as Templates;

/**
 * What a created workspace depends on.
 *
 * Read from this package's own manifest rather than typed in, so an
 * application is always built against the packages the launcher that created it
 * was built against.
 */
const VERSIONS = {
  broapp: selfManifest.dependencies.broapp,
  autoapp: `^${selfManifest.version}`,
};

const HELP = `broapp-autoapp

Usage:
  broapp-autoapp [open] [--no-open] [--no-restore]
                                        Open the launcher's own tab. Against a
                                        launcher already running, open a fresh
                                        address for its panel instead. On start,
                                        applications that were serving are
                                        started again unless --no-restore.
  broapp-autoapp serve <appId> [--no-open]
  broapp-autoapp create <appId> [--name <name>] [--description <text>]
                                [--template starter|blank] [--at <dir>]
                                        starter (the default) is a list of items;
                                        blank is one empty page to describe.
                                        --at makes the workspace in <dir>/<appId>
                                        instead of the launcher's own folder.
  broapp-autoapp locate <appId> <dir>   Say where a chosen workspace went, after it
                                        was moved or renamed.
  broapp-autoapp remove <appId> [--yes] Move an application to the launcher's trash.
  broapp-autoapp import <sourceDir> --as <appId> [--grant]
  broapp-autoapp build <appId>
  broapp-autoapp activate <appId> <releaseId>
  broapp-autoapp releases <appId>
  broapp-autoapp status [<appId>]       With an application: its release, grants and
                                        activations. Without: whether a launcher is
                                        running over this root, and what it serves.
  broapp-autoapp standing [on|off]      Whether the engineer works without asking for
                                        edits, builds and previews of any application.
                                        Activation, creation and anything external
                                        still ask. Settings has the same switch.
  broapp-autoapp stop                   Stop the launcher running over this root, and
                                        every application it serves. Its panel's Quit
                                        and Ctrl+C in its terminal do the same.
  broapp-autoapp mcp <appId>            Serve one application over MCP, on stdio
  broapp-autoapp knowledge list [--provisional|--confirmed|--review|--method]
  broapp-autoapp knowledge show <id>
  broapp-autoapp knowledge confirm <id> [--by <name>] [--yes]
  broapp-autoapp knowledge retire <id>
  broapp-autoapp knowledge export [--json]
  broapp-autoapp knowledge links [--app <id>] [--rebuild]
                                        Review what the engineer learnt. A lesson
                                        stays provisional until a person confirms it.
  broapp-autoapp knowledge replay <caseId> [--with <lessonId>] [--runs n]
                                        Run the engineer again on a resolved case,
                                        with the lesson and without it.
  broapp-autoapp knowledge evaluate [--runs n] [--out <path>] [--notes <dir>]
                                        Three tasks under four conditions, as a table.

Environment:
  BROAPP_DATA_DIR  Override where the launcher keeps everything.

An application runs as its own child process, as trusted local code: crash
isolated from the launcher, not permission isolated from you. Closing the
panel's tab stops nothing; an application stays up until the launcher stops.`;

/**
 * The operating system's browser opener, or one that opens nothing.
 *
 * A test or the smoke run drives the compiled launcher through every path that
 * opens a tab, and a machine running them should not grow a browser window per
 * case. Honoured only under `NODE_ENV=test`, like `AUTOAPP_TEST_NO_NETWORK`:
 * the opener then reports failure, and every address goes to the terminal as
 * it would on a machine with no browser.
 */
const browser: (url: string) => Promise<boolean> =
  Bun.env['NODE_ENV'] === 'test' && Bun.env['AUTOAPP_TEST_NO_BROWSER'] === '1'
    ? () => Promise.resolve(false)
    : openBrowser;

/** How long a child gets to stop before it is killed. */
const STOP_DEADLINE_MS = 10_000;

/**
 * The launcher's one stop path.
 *
 * `SIGINT`, `SIGTERM`, the control connection's `stop` and the panel's Quit
 * all come here, so there is one way the launcher stops however it is asked.
 * With the panel running, `graceful` is its own shutdown — the backlog run
 * stopped and given its deadline, the AI layer closed, every child stopped,
 * the stores closed, the control file removed — and the process then ends as
 * the command returns. Without it (`serve <appId>`), the children are stopped
 * and the process exits.
 */
interface StopPath {
  /** Stop. Safe to call more than once; every caller gets the same stop. */
  stop(): Promise<void>;
  /** Set what stopping runs first. */
  graceful(shutdown: () => Promise<void>): void;
}

/** How long a stop waits for the command to return before exiting anyway. */
const EXIT_GRACE_MS = 5_000;

/** Register the handlers that make sure no child outlives the launcher. */
function stopChildrenOnExit(supervisor: Supervisor): StopPath {
  let stopping: Promise<void> | null = null;
  let graceful: (() => Promise<void>) | null = null;
  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping;
    const shutdown = graceful;
    stopping =
      shutdown === null
        ? supervisor.stopAll(STOP_DEADLINE_MS).then(() => process.exit(0))
        : shutdown()
            .catch((cause: unknown) => console.error(`the launcher did not stop cleanly: ${String(cause instanceof Error ? cause.message : cause)}`))
            .then(() => supervisor.stopAll(STOP_DEADLINE_MS))
            .then(() => {
              // The command returns now and `main` ends the process; this is
              // only for a return that never comes, and holds nothing open.
              setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref?.();
            });
    return stopping;
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  // The synchronous last resort. `exit` cannot await anything, so this kills
  // rather than drains — and it is the only handler that runs on Windows, where
  // a console process is not delivered `SIGTERM` the way a POSIX one is. A
  // child that outlives its launcher holds a port and a data directory nobody
  // is supervising, which is worse than an ungraceful stop.
  process.on('exit', () => supervisor.killAll());
  // `beforeExit` fires when the loop empties, which is the case a signal
  // handler does not cover: the launcher finished its work while a child it
  // started is still alive.
  process.on('beforeExit', () => {
    if (supervisor.children.length > 0) void stop();
  });
  return {
    stop,
    graceful(shutdown) {
      graceful = shutdown;
    },
  };
}

/** Read one line from stdin, for the grant prompt. */
async function readLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value, done } = await reader.read();
    return done || value === undefined ? '' : new TextDecoder().decode(value).trim();
  } finally {
    reader.releaseLock();
  }
}

/** The knowledge store and its log, for the commands that keep one. */
interface Recording {
  readonly knowledge: Knowledge;
  readonly log: EventLog;
  /** The backlog, opened beside knowledge by the same long-running commands. */
  readonly intents: IntentStore;
}

/** The logger to hand everything: the event log when there is one. */
function loggerOf(recording: Recording | null): { logger?: EventLog } {
  return recording === null ? {} : { logger: recording.log };
}

/** `serve <appId>` — recover whatever was interrupted, then run it. */
async function serve(
  root: Layout,
  journal: Journal,
  supervisor: Supervisor,
  appId: string,
  open: boolean,
  recording: Recording | null,
  exit: StopPath,
): Promise<number> {
  for (const recovered of await recover({
    layout: root,
    journal,
    supervisor,
    start: false,
    ...loggerOf(recording),
  })) {
    console.log(`recovered: ${recovered.finding}`);
  }
  const current = readCurrent(root, appId);
  if (current === null) {
    console.error(`${appId} has no current release. Run "import" or "activate" first.`);
    return 1;
  }
  // Opened here too, so `serve <appId>` — one application without the launcher
  // tab — is still reachable over MCP.
  // Said before the child exists: a remove that asks in the seconds a child
  // takes to start must hear "yes", not "not yet".
  let control: Control | null = startControl({
    layout: root,
    supervisor,
    serves: (id) => id === appId,
    // No panel runs here, so there is no address to give; the request is
    // answered with the sentence that says how to get one.
    panel: () => null,
    stop: () => void exit.stop(),
    ...loggerOf(recording),
  });
  process.on('exit', () => control?.stop());

  console.log(`${appId} ${current}`);
  const code = await keepServing({
    layout: root,
    supervisor,
    appId,
    ...loggerOf(recording),
    onStart: (child, restart) => {
      if (restart === 0) addServing(root, appId);
      if (restart > 0) console.log(`${appId} stopped and was started again; its address has changed.`);
      // The launch URL carries a one-time token and is a credential until it is
      // redeemed. Written to the terminal on purpose, because somebody whose
      // browser did not open needs it — and to the terminal only.
      console.log(`Open this address if your browser does not: ${child.url}`);
      if (!open) return;
      void browser(child.url).then((opened) => {
        if (!opened) console.log('Could not open a browser automatically. Use the address above.');
      });
    },
  });
  control.stop();
  control = null;
  // Stopped cleanly: a launcher started later should not serve it again.
  if (code === 0) removeServing(root, appId);
  return code;
}

/**
 * The launcher's own tab.
 *
 * A Broapp application like any other, serving its own page on its own
 * loopback bridge. Its data directory is the launcher's, which is where its AI
 * settings and its own run history live — separate from every application's.
 */
async function openLauncher(
  root: Layout,
  journal: Journal,
  supervisor: Supervisor,
  open: boolean,
  recording: Recording | null,
  restore: boolean,
  exit: StopPath,
): Promise<number> {
  const startedAt = Date.now();
  for (const recovered of await recover({
    layout: root,
    journal,
    supervisor,
    start: false,
    ...loggerOf(recording),
  })) {
    console.log(`recovered: ${recovered.finding}`);
  }

  // Applications that were serving when the last launcher stopped. Awaited
  // before the tab exists, so a person's first click cannot race a restore
  // into starting a second child over the same data directory.
  if (restore) {
    for (const appId of await restoreServing({ layout: root, supervisor, ...loggerOf(recording) })) {
      console.log(`restored: ${appId}`);
    }
  }

  // Set once the tab's bridge is serving; the panel's addresses come from it.
  let running: RunningApp | null = null;
  // Set once the tab exists; `status` reads the backlog run from it.
  let executor: Executor | null = null;

  /** What this launcher is doing, for `status` and the reply to `stop`. */
  const status = (): LauncherStatus => {
    const active = executor?.active() ?? null;
    const taskId = active === null ? null : (executor?.progress(active.intentId).run?.taskId ?? null);
    return {
      pid: process.pid,
      startedAt,
      serving: servingIds(supervisor),
      panel: true,
      run:
        active === null
          ? null
          : { ...active, task: taskId === null ? null : (recording?.intents.task(taskId)?.slug ?? null) },
    };
  };

  // The door an MCP server comes in by. Only the launcher's own long-running
  // commands open it, and it is removed when they stop.
  const control = startControl({
    layout: root,
    supervisor,
    panel: () => running?.launchUrl() ?? null,
    status,
    stop: () => void exit.stop(),
    ...loggerOf(recording),
  });

  // Knowledge was opened before this, in `main`, beside where the run store is
  // opened now: both live in the launcher's own data directory.
  const dataDir = join(root.root, 'launcher');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = createRunStore(dataDir);
  store.markUnknownOnStart();

  const tab = createLauncherTab({
    layout: root,
    supervisor,
    journal,
    // The launcher's own gate. Its tab's clicks are channel `user`; the
    // engineer's tools arrive on channel `ai` through the same door.
    gate: createLauncherGate({
      releaseId: 'launcher',
      recorder: store.recorder(),
      ...loggerOf(recording),
    }),
    dataDir,
    store,
    ...loggerOf(recording),
    ...(recording === null
      ? {}
      : {
          knowledge: {
            store: recording.knowledge,
            log: recording.log,
            evidence: createEvidence(recording.knowledge, recording.log),
          },
          intents: recording.intents,
        }),
    templates,
    versions: VERSIONS,
    openBrowser: browser,
    // The panel's Quit: the same stop as Ctrl+C.
    quit: () => void exit.stop(),
    providers: [anthropic(), ollama(), openai(), openrouter(), customServer()],
    // The offline tier tests need a launcher whose AI layer cannot reach the
    // network, and severing an interface in CI is not something a test may do.
    // Honoured only under `NODE_ENV=test`, read through `Bun.env` because
    // `--minify` folds `process.env.NODE_ENV` into the binary at build time.
    ...(Bun.env['NODE_ENV'] === 'test' && Bun.env['AUTOAPP_TEST_NO_NETWORK'] === '1'
      ? { fetch: noNetwork }
      : {}),
  });

  executor = tab.executor;
  // Whether a panel was open a moment ago, for the line a closed one earns.
  let panelWatch: ReturnType<typeof setInterval> | null = null;

  running = await startApp({
    page,
    appName: 'Autoapp',
    version: selfManifest.version,
    mode: 'background',
    openBrowser: open,
    register: (bridge) => tab.mount(bridge),
    isBusy: () => tab.ai.activeStreams > 0,
    onShutdown: async () => {
      if (panelWatch !== null) clearInterval(panelWatch);
      supervisor.setPanel(null);
      // A backlog run is stopped first and given the deadline a child gets:
      // its turn writes its transcript and its task's move before the stores
      // below close. What it leaves is interrupted, and nothing resumes it.
      tab.executor?.stopAll('the launcher');
      if (tab.executor !== null) {
        await Promise.race([tab.executor.idle(), Bun.sleep(STOP_DEADLINE_MS)]);
      }
      // A folder window nobody answered does not outlive the launcher that opened it.
      tab.app.shutdown();
      tab.ai.abortAll('the launcher is shutting down');
      // The conversations live in a SQLite file of the AI layer's own, and a
      // database that is never closed misses its last WAL checkpoint.
      tab.ai.close();
      control.stop();
      // Applications the launcher started do not outlive it.
      await supervisor.stopAll(STOP_DEADLINE_MS);
      // A question in flight is stopped and its case stays pending; this
      // waits at most five seconds, and must finish before knowledge closes.
      await tab.distiller?.close();
      // The run store, then knowledge: the last things a stopping child says
      // are written to the log before it closes.
      store.close();
      recording?.intents.close();
      recording?.knowledge.close();
    },
  });

  // The way back from an application. Its mark asks its child, the child asks
  // here, and the address goes to the operating system's opener — never to
  // the application's page, which could not navigate to it anyway.
  const tabRunning = running;
  supervisor.setPanel(() => ({
    available: true,
    open: async () => {
      const url = tabRunning.launchUrl();
      const opened = await browser(url);
      // A credential, so the terminal only, as `serve` prints an address.
      if (!opened) console.log(`Could not open a browser. Open the panel at this address: ${url}`);
      return { opened };
    },
  }));

  // Ctrl+C, `stop` and Quit all run this tab's own shutdown first.
  const stoppable = running;
  exit.graceful(() => stoppable.stop('requested'));
  panelWatch = watchPanel(stoppable, () => {
    const ids = servingIds(supervisor);
    const line = `Still running, serving ${ids.length === 0 ? 'no application' : ids.join(', ')}. \`broapp-autoapp stop\` ends it.`;
    if (recording === null) console.log(line);
    else recording.log.warn(line);
  });

  return await running.done;
}

/** The applications a supervisor serves live, each once. */
function servingIds(supervisor: Supervisor): string[] {
  return [...new Set(supervisor.children.filter((child) => child.mode === 'live').map((child) => child.appId))];
}

/** How long the panel must stay closed before it counts as closed: a reload is not a closure. */
const PANEL_CLOSED_MS = 3_000;

/**
 * Say, once per closure, that the launcher outlives its panel.
 *
 * A person who closes the tab has stopped nothing: the launcher and every
 * application it serves go on, which is meant — an application is used with
 * the panel closed — and was invisible. There is no idle exit; this is the
 * line that says how to stop it.
 */
function watchPanel(running: RunningApp, closed: () => void): ReturnType<typeof setInterval> {
  let seen = false;
  let since: number | null = null;
  const timer = setInterval(() => {
    if (running.attached) {
      seen = true;
      since = null;
      return;
    }
    if (!seen) return;
    since ??= Date.now();
    if (Date.now() - since < PANEL_CLOSED_MS) return;
    seen = false;
    since = null;
    closed();
  }, 1_000);
  timer.unref?.();
  return timer;
}

/** A duration as a person says it. */
function lasted(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${String(Math.max(1, Math.round(ms / 1_000)))} seconds`;
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours)} hour${hours === 1 ? '' : 's'}${rest === 0 ? '' : ` ${String(rest)} minute${rest === 1 ? '' : 's'}`}`;
}

/** How long `stop` waits for a launcher to be gone. */
const STOP_WAIT_MS = 15_000;

/**
 * `stop` — ask the launcher running over this root to stop.
 *
 * Never a signal of its own: the launcher is asked over its control
 * connection, which works on Windows too, and stops by the path Ctrl+C takes.
 * A control file naming a pid that is not alive is a launcher that died
 * without removing it, and is removed.
 */
async function stopLauncher(root: Layout): Promise<number> {
  let file: ControlFile;
  try {
    file = readControlFile(root.control);
  } catch {
    console.log('No launcher is running over this root.');
    return 0;
  }
  if (!processAlive(file.pid)) {
    rmSync(root.control, { force: true });
    console.log(`The control file named pid ${String(file.pid)}, which is not running; it was stale and is removed.`);
    console.log('No launcher is running over this root.');
    return 0;
  }
  let answer: { readonly serving: readonly string[] };
  let client: ControlClient | null = null;
  try {
    client = await withTimeout(connectControl(root.control), JOIN_TIMEOUT_MS);
    answer = await withTimeout(client.stop(), JOIN_TIMEOUT_MS);
  } catch (cause) {
    console.error(
      `The launcher, pid ${String(file.pid)}, did not answer: ${String(cause instanceof Error ? cause.message : cause)}. Nothing was stopped.`,
    );
    return 1;
  } finally {
    client?.close();
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (processAlive(file.pid)) {
    if (Date.now() >= deadline) {
      console.error(`It did not stop within 15 seconds; its pid is ${String(file.pid)}.`);
      return 1;
    }
    await Bun.sleep(200);
  }
  console.log(`Stopped. It was serving: ${answer.serving.length === 0 ? 'nothing' : answer.serving.join(', ')}.`);
  return 0;
}

/** `status` with no application — whether a launcher runs over this root, and what it does. */
/**
 * `standing [on|off]`: the person's standing approval, read or set.
 *
 * The same file Settings and the card's third button write, through the same
 * functions. A launcher running over this root answers its next question by
 * it; there is nothing to tell it.
 */
function standingCommand(root: Layout, value: string | undefined): number {
  if (value !== undefined && value !== 'on' && value !== 'off') return usage('standing [on|off]');
  const now = value === 'on' ? writeStanding(root) : value === 'off' ? clearStanding(root) : readStanding(root, console);
  console.log(STANDING_WORDS.state(now.standing, now.since));
  return 0;
}

async function launcherStatus(root: Layout): Promise<number> {
  let client: ControlClient | null = null;
  let status: LauncherStatus;
  // Whether a launcher is running or not, the switch is a file under this root.
  // Said only while it is on: a person who never touched it reads exactly what
  // `status` said before the switch existed, and `standing` says `off`.
  const standing = readStanding(root, console);
  const standingLine = standing.standing ? `standing: ${STANDING_WORDS.state(standing.standing, standing.since)}` : null;
  try {
    client = await withTimeout(connectControl(root.control), JOIN_TIMEOUT_MS);
    status = await withTimeout(client.status(), JOIN_TIMEOUT_MS);
  } catch {
    console.log('No launcher is running over this root.');
    if (standingLine !== null) console.log(standingLine);
    return 0;
  } finally {
    client?.close();
  }
  console.log(`A launcher is running over this root: pid ${String(status.pid)}, for ${lasted(Date.now() - status.startedAt)}.`);
  console.log(`${status.panel ? 'With its panel' : 'Serving one application, without a panel'}.`);
  console.log(`Serving: ${status.serving.length === 0 ? 'nothing' : status.serving.join(', ')}.`);
  console.log(
    status.run === null
      ? 'Backlog: no run.'
      : `Backlog: intent ${String(status.run.intentId)} on ${status.run.appId} is running${status.run.task === null ? '' : `, on ${status.run.task}`}.`,
  );
  if (standingLine !== null) console.log(standingLine);
  return 0;
}

/**
 * Join a launcher that is already running over this root, if there is one.
 *
 * Returns the exit code when one answered, or `null` to go on and start a
 * launcher. A `launcher.json` nobody answers names a launcher that has gone —
 * one killed without running its exit handler — and is removed.
 */
async function joinRunning(root: Layout, open: boolean): Promise<number | null> {
  if (!existsSync(root.control)) return null;
  let control: ControlClient;
  try {
    control = await withTimeout(connectControl(root.control), JOIN_TIMEOUT_MS);
  } catch {
    rmSync(root.control, { force: true });
    return null;
  }
  try {
    const answer = await withTimeout(control.panel(), JOIN_TIMEOUT_MS);
    if (!answer.ok) {
      console.error(`refused: unavailable — ${answer.reason}`);
      return 1;
    }
    console.log('A launcher is already running over this root.');
    if (!open) {
      console.log(`Open the panel at this address: ${answer.url}`);
      return 0;
    }
    if (!(await browser(answer.url))) {
      console.log(`Could not open a browser. Open the panel at this address: ${answer.url}`);
    }
    return 0;
  } catch (cause) {
    console.error(`refused: unavailable — the running launcher did not answer: ${String(cause instanceof Error ? cause.message : cause)}`);
    return 1;
  } finally {
    control.close();
  }
}

/** How long a running launcher gets to answer `open`. It answers from memory. */
const JOIN_TIMEOUT_MS = 5_000;

/** Reject after `ms` without holding the process open. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/**
 * A `fetch` that refuses, for the offline tier tests.
 *
 * The AI layer takes its `fetch` as an option precisely so a test can decide
 * what the network is. Nothing else in the launcher makes a request.
 */
/**
 * The install `create` runs, when a test says there is no network.
 *
 * A command-line test of `create --at` must not reach the registry, and the
 * compiled launcher's install is itself spawned as `bun install`. Under
 * `NODE_ENV=test` with `AUTOAPP_TEST_NO_NETWORK=1` — the same switch the AI
 * layer honours — the install reports what an offline machine reports, and the
 * build resolves what is already on disk, as it does after a failed install.
 */
const testInstall: ((sourceDir: string) => Promise<{ ok: boolean; detail: string }>) | null =
  Bun.env['NODE_ENV'] === 'test' && Bun.env['AUTOAPP_TEST_NO_NETWORK'] === '1'
    ? () => Promise.resolve({ ok: false, detail: 'the network is unavailable' })
    : null;

const noNetwork = Object.assign(
  () => Promise.reject(new Error('the network is unavailable')),
  { preconnect: () => undefined },
) as unknown as typeof fetch;

/** `import <sourceDir> --as <appId>` — the developer's way in. */
async function importApp(
  root: Layout,
  sourceDir: string,
  appId: string,
  autoGrant: boolean,
): Promise<number> {
  const app = root.app(appId);
  // `import` copies into the launcher's own folder only. An application that
  // already has a pointer has a workspace somewhere a person chose, and
  // copying into that path — which may be missing because its drive is not
  // connected — would recreate a chosen folder, which nothing may do.
  if (app.sourceLocation.kind !== 'default') {
    console.error(`${appId} already has a source workspace in a folder that was chosen for it; import copies into the launcher's own folder only`);
    return 1;
  }
  mkdirSync(app.dir, { recursive: true, mode: 0o700 });
  if (existsSync(app.source)) {
    console.error(`${appId} already has a source workspace at ${app.source}`);
    return 1;
  }
  cpSync(resolve(sourceDir), app.source, {
    recursive: true,
    // A source workspace is text. Copying a `node_modules`, a `dist` or a
    // `release` across would be slow and would import somebody else's build.
    filter: (from) => !/(^|[\\/])(node_modules|dist|release|\.git)([\\/]|$)/.test(from),
  });

  // Install, `git init` and build — the steps `create` also takes, in the one
  // place both of them reach them from. The sentences this used to print are
  // returned as `notes`, because a route and a tool have to show the same facts
  // somewhere that is not a terminal.
  const prepared = await prepareWorkspace({ layout: root, appId });
  for (const note of prepared.notes) console.log(note);
  if (!prepared.ok) {
    for (const problem of prepared.problems) console.error(`${problem.stage}: ${problem.message}`);
    return 1;
  }

  const wanted = prepared.spec.manifest.capabilities;
  if (wanted.length > 0) {
    console.log(`${appId} asks for:`);
    for (const capability of wanted) {
      const detail = capability.paths?.join(', ') ?? capability.hosts?.join(', ') ?? '';
      console.log(`  ${capability.kind}${detail === '' ? '' : ` ${detail}`} — ${capability.reason}`);
    }
    if (!autoGrant) {
      console.log('Allow these? [y/N] ');
      if ((await readLine()).toLowerCase() !== 'y') {
        console.error('not granted; nothing was activated');
        return 1;
      }
    }
  }
  adopt(root, appId, prepared.releaseId, wanted);
  console.log(`${appId} ${prepared.releaseId}`);
  return 0;
}

/**
 * `create <appId>` — the other way in, for somebody with no workspace at all.
 *
 * The same lines `import` prints, for the same reason: whatever a person did
 * to get an application, what they have afterwards is a source workspace and a
 * release. It does not open a browser, and neither does `import`.
 */
async function createApp(
  root: Layout,
  appId: string,
  name: string,
  description: string,
  template: TemplateName,
  location: string | undefined,
): Promise<number> {
  let created;
  try {
    created = await createApplication({
      layout: root,
      templates,
      template,
      versions: VERSIONS,
      appId,
      name,
      description,
      ...(location === undefined ? {} : { location }),
      ...(testInstall === null ? {} : { install: testInstall }),
    });
  } catch (cause) {
    // A refusal is a sentence for a person, not a stack.
    console.error(String(cause instanceof Error ? cause.message : cause));
    return 1;
  }
  for (const note of created.notes) console.log(note);
  if (!created.ok) {
    for (const problem of created.problems) console.error(`${problem.stage}: ${problem.message}`);
    return 1;
  }
  console.log(`${appId} ${created.releaseId}`);
  return 0;
}

/**
 * `remove <appId> [--yes]` — the other way to remove one.
 *
 * Two refusals before anything moves. A launcher that is serving the
 * application is asked over its control connection, because this process has a
 * supervisor of its own with no children in it and would otherwise believe
 * nothing was running; and without `--yes` the command prints what would move
 * and stops, which is the whole of its confirmation. The panel asks for the id
 * to be typed instead — a terminal already made somebody type it once.
 */
async function removeApp(
  root: Layout,
  journal: Journal,
  supervisor: Supervisor,
  appId: string,
  confirmed: boolean,
): Promise<number> {
  let described: RemovalDescription;
  try {
    described = describeRemoval(root, appId);
  } catch (cause) {
    console.error(String(cause instanceof Error ? cause.message : cause));
    return 1;
  }
  console.log(`${appId} — ${describeReceipt(described)}`);

  // Asked before `--yes` is looked at, so somebody who has not passed it is
  // told the real reason they cannot remove this rather than told to come back
  // with a flag that will not help.
  if (await servedElsewhere(root, appId)) {
    console.error(`refused: ${appId} is being served by a running launcher. Stop it first.`);
    return 1;
  }
  if (!confirmed) {
    console.error('refused: pass --yes to move it to trash');
    return 1;
  }

  const receipt = await removeApplication(
    {
      layout: root,
      supervisor,
      states: createCandidateStates(root),
      journal,
      // The same file the tab writes: a selection naming an application that is
      // in the trash would send the engineer's next turn at nothing.
      session: openSession(join(root.root, 'launcher')),
    },
    appId,
  );
  console.log(`moved to ${receipt.trashPath}`);
  const left = leftSentence(receipt);
  if (left !== null) console.log(left);
  return 0;
}

/**
 * Whether a launcher other than this process is serving the application.
 *
 * `launcher.json` may name a launcher that has gone — it is removed on a clean
 * exit and is not on Windows, where a terminated console process runs no
 * handler — so an unreachable one is treated as no launcher at all. The child
 * is what would be harmed by a rename, and there is no child behind a socket
 * that does not answer.
 */
async function servedElsewhere(root: Layout, appId: string): Promise<boolean> {
  let control: ControlClient;
  try {
    control = await connectControl(root.control);
  } catch {
    // No control file, or nothing answering on its port: no launcher.
    return false;
  }
  try {
    return await control.serving(appId);
  } catch {
    // A launcher answered the connection and then did not answer the question.
    // Treated as serving: the cost of a wrong "yes" is a person stopping a
    // launcher and trying again; the cost of a wrong "no" is a rename under a
    // running child, which on Windows fails halfway into the question.
    return true;
  } finally {
    control.close();
  }
}

/** Everything after the subcommand, and the flags mixed into it. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

/**
 * The nth positional argument, skipping flags.
 *
 * `serve --no-open` has no application in it, and reading `argv[1]` would make
 * `--no-open` the application's name.
 */
function positional(argv: readonly string[], index: number): string | undefined {
  return argv.filter((argument) => !argument.startsWith('-'))[index];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // The two child roles come first: they are how the launcher starts an
  // application, and they must not fall through to argument parsing.
  if (command === '--child') return await runChild(argv.slice(1));
  if (command === '--migrate') return await runMigrate(argv.slice(1));

  if (command === '-h' || command === '--help') {
    console.log(HELP);
    return 0;
  }

  const root = layout(defaultRoot());
  mkdirSync(root.root, { recursive: true, mode: 0o700 });

  // `open`, the bare command, and `serve` with no application all mean the
  // panel. Over a root that already has a launcher, that launcher is asked for
  // a panel address before this process opens the journal or knowledge, so a
  // second launcher is never started beside the first.
  // Asked of a running launcher over its control connection, before this
  // process opens anything a running launcher has open.
  if (command === 'stop') return await stopLauncher(root);
  if (command === 'status' && positional(argv, 1) === undefined) return await launcherStatus(root);
  // A file, read at every question: neither needs the stores, and a launcher
  // that is running answers its next question by what this writes.
  if (command === 'standing') return standingCommand(root, positional(argv, 1));

  const wantsPanel = command === undefined || command === 'open' || (command === 'serve' && positional(argv, 1) === undefined);
  if (wantsPanel) {
    const joined = await joinRunning(root, !argv.includes('--no-open'));
    if (joined !== null) return joined;
  }

  const journal = openJournal(root.journal);
  // The long-running commands write down what happens. Opened before the
  // supervisor, so a child's stderr is recorded from its first line; one-shot
  // commands keep printing to the terminal and write nothing.
  const longRunning = command === undefined || command === 'open' || command === 'serve';
  const knowledge = longRunning ? openKnowledge(join(root.root, 'launcher')) : null;
  // The backlog lives beside knowledge and opens with it; nothing but the
  // launcher's tab reads it, and a one-shot command never needs it.
  // Only the launcher tab runs backlogs, so only it recovers one: `serve
  // <appId>` may open this store beside a launcher that is running a backlog.
  const intents = knowledge === null ? null : openIntents(join(root.root, 'launcher'), { recover: wantsPanel });
  const recording: Recording | null =
    knowledge === null || intents === null
      ? null
      : { knowledge, log: createEventLog(knowledge, { source: 'launcher', tee: console }), intents };
  if (recording !== null) {
    // Derived, so rebuilt whenever the stores open: it can never be further
    // behind than the last task that ended while nothing was listening.
    try {
      rebuildLinks({ knowledge: recording.knowledge, intents: recording.intents, layout: root, apps: appIds(root) });
    } catch (cause) {
      recording.log.error(`[autoapp] the relationship index could not be rebuilt: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  }
  const supervisor = createSupervisor(loggerOf(recording));
  const exit = stopChildrenOnExit(supervisor);

  try {
    switch (command) {
      case undefined:
      case 'open':
        return await openLauncher(root, journal, supervisor, !argv.includes('--no-open'), recording, !argv.includes('--no-restore'), exit);

      case 'serve': {
        const appId = positional(argv, 1);
        // `serve` with no application is the launcher's own tab, which is the
        // ordinary way in: from there a person opens whichever they want.
        if (appId === undefined) {
          return await openLauncher(root, journal, supervisor, !argv.includes('--no-open'), recording, !argv.includes('--no-restore'), exit);
        }
        return await serve(root, journal, supervisor, appId, !argv.includes('--no-open'), recording, exit);
      }

      case 'create': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('create <appId> [--name <name>] [--description <text>]');
        const template = flagValue(argv, '--template') ?? 'starter';
        if (!isTemplateName(template)) {
          return usage('create <appId> [--template starter|blank]');
        }
        return await createApp(
          root,
          appId,
          flagValue(argv, '--name') ?? appId,
          flagValue(argv, '--description') ?? '',
          template,
          flagValue(argv, '--at'),
        );
      }

      case 'locate': {
        // Positional, not flag-skipping: a folder may legitimately start with
        // a hyphen, and this command takes exactly two arguments.
        const appId = argv[1];
        const dir = argv[2];
        if (appId === undefined || dir === undefined) return usage('locate <appId> <dir>');
        try {
          const located = locateApplication(root, appId, dir);
          console.log(`${appId}'s workspace is at ${located.dir}`);
          return 0;
        } catch (cause) {
          console.error(String(cause instanceof Error ? cause.message : cause));
          return 1;
        }
      }

      case 'remove': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('remove <appId> [--yes]');
        return await removeApp(root, journal, supervisor, appId, argv.includes('--yes'));
      }

      case 'import': {
        const sourceDir = positional(argv, 1);
        const appId = flagValue(argv, '--as');
        if (sourceDir === undefined || appId === undefined) return usage('import <sourceDir> --as <appId>');
        return await importApp(root, sourceDir, appId, argv.includes('--grant'));
      }

      case 'build': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('build <appId>');
        try {
          requireSource(root, appId);
        } catch (cause) {
          console.error(String(cause instanceof Error ? cause.message : cause));
          return 1;
        }
        const built = await buildCandidate({ layout: root, appId });
        if (!built.ok) {
          for (const problem of built.problems) console.error(`${problem.stage}: ${problem.message}`);
          return 1;
        }
        console.log(built.releaseId + (built.rebuilt ? '' : ' (already built)'));
        return 0;
      }

      case 'activate': {
        const appId = positional(argv, 1);
        const releaseId = positional(argv, 2);
        if (appId === undefined || releaseId === undefined) return usage('activate <appId> <releaseId>');
        const result = await activate({ layout: root, supervisor, journal, appId, releaseId });
        if (!result.ok) {
          console.error(`failed at ${result.phase}: ${result.reason} (${result.recovered})`);
          return 1;
        }
        console.log(`${appId} is now on ${releaseId}${result.previousRelease === null ? '' : `, was ${result.previousRelease}`}`);
        await result.child.shutdown(STOP_DEADLINE_MS);
        return 0;
      }

      case 'releases': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('releases <appId>');
        const current = readCurrent(root, appId);
        for (const release of listReleases(root, appId)) {
          console.log(
            `${release.releaseId === current ? '*' : ' '} ${release.releaseId}  schema ${String(release.schemaVersion)}  ${new Date(release.createdAt).toISOString()}${release.stale ? '  stale' : ''}`,
          );
        }
        return 0;
      }

      case 'mcp': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('mcp <appId>');
        // Imported lazily: the MCP SDK is a large dependency that `serve` has
        // no use for, and this is the only command that needs it.
        const { runMcp } = await import('../mcp/server.ts');
        return await runMcp({ appId, controlPath: root.control });
      }

      case 'knowledge': {
        // Replay and evaluation run the engineer, so they need the providers
        // and the launcher's AI settings; they write only `replays` rows and
        // blobs to the launcher's store, and are allowed while it serves.
        const providers = [anthropic(), ollama(), openai(), openrouter(), customServer()];
        const aiDataDir = join(root.root, 'launcher');
        if (argv[1] === 'replay') return await runReplayCommand({ root, argv: argv.slice(2), providers, aiDataDir });
        if (argv[1] === 'links') {
          // Both stores, each through its own handle; the backlog without
          // recovery, because a launcher may be running one.
          const store = openKnowledge(aiDataDir);
          const backlog = openIntents(aiDataDir);
          try {
            return runLinksCommand({ argv: argv.slice(2), knowledge: store, intents: backlog, layout: root, apps: appIds(root) });
          } finally {
            backlog.close();
            store.close();
          }
        }
        if (argv[1] === 'evaluate') {
          return await runEvaluateCommand({
            root,
            argv: argv.slice(2),
            providers,
            aiDataDir,
            // Notes is not in the binary; the evaluation is a developer's
            // measurement, run from a checkout.
            notesDir: resolve(flagValue(argv, '--notes') ?? join('examples', 'notes')),
            templates,
            versions: VERSIONS,
          });
        }
        // Reads the database directly, like `status`, and refuses to change it
        // while a launcher is serving.
        return runKnowledgeCommand({ root, argv: argv.slice(1) });
      }

      case 'status': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('status [<appId>]');
        const current = readCurrent(root, appId);
        console.log(`current: ${current ?? 'none'}`);
        const grants = readGrants(root, appId);
        console.log(`granted: ${grants === null ? 'nothing' : grants.capabilities.map((c) => c.kind).join(', ') || 'nothing'}`);
        for (const activation of journal.history(appId, 10)) {
          console.log(
            `  ${new Date(activation.startedAt).toISOString()}  ${activation.fromRelease ?? 'none'} → ${activation.toRelease}  ${activation.phase}${activation.error === null ? '' : `  ${activation.error}`}`,
          );
        }
        return 0;
      }

      default:
        console.error(`unknown command ${JSON.stringify(command)}`);
        console.log(HELP);
        return 1;
    }
  } finally {
    journal.close();
    // Already closed by the launcher tab's shutdown when that is what ran;
    // closing twice is harmless, and `serve <appId>` has no shutdown of its own.
    intents?.close();
    knowledge?.close();
    // Every command but `serve` is one-shot, and a live child's IPC channel is
    // a handle that keeps this process's event loop open. Leaving one behind
    // would make the command appear to hang after it had finished.
    if (command !== 'serve' && command !== 'open' && command !== undefined) {
      await supervisor.stopAll(STOP_DEADLINE_MS);
    }
  }
}

function usage(line: string): number {
  console.error(`usage: broapp-autoapp ${line}`);
  return 1;
}

// `bun build --compile --bytecode` rejects top-level await, so every await
// stays inside a function and the entry point ends with a plain `.then`.
main().then(
  (code) => {
    process.exitCode = code;
    // The launcher's own commands end here once their shutdown has run and
    // the stores are closed: nothing a provider or a socket left behind may
    // keep a stopped launcher alive.
    const command = process.argv[2];
    if (command === undefined || command === 'open' || command === 'serve') process.exit(code);
  },
  (cause: unknown) => {
    console.error(String(cause instanceof Error ? cause.message : cause));
    process.exitCode = 1;
  },
);
