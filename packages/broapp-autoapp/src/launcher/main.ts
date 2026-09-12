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
import starterTemplate from '../../dist/starter-template.json' with { type: 'json' };
import selfManifest from '../../package.json' with { type: 'json' };

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { anthropic } from 'broapp-ai-anthropic';
import { customServer, ollama, openai } from 'broapp-ai-compatible';
import { ensureDataDir, openBrowser, startApp } from 'broapp/host';

import { createRunStore } from '../host/run-store.ts';
import {
  createEventLog,
  createEvidence,
  openKnowledge,
  runEvaluateCommand,
  runKnowledgeCommand,
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
import { buildCandidate } from './candidate.ts';
import { startControl, type Control } from './control.ts';
import { openJournal, type Journal } from './journal.ts';
import { keepServing } from './keepalive.ts';
import { recover } from './recover.ts';
import { createSupervisor, type Supervisor } from './supervisor.ts';
import { createLauncherGate } from './app.ts';
import { createApplication } from './create.ts';
import type { StarterTemplate } from './starter.ts';
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
 * The starter workspace, inlined into the binary the same way.
 *
 * A person who downloaded a launcher has no source workspace to import, so the
 * launcher carries one. `scripts/build-template.ts` packs
 * `templates/autoapp-starter` into this file; it is a build artefact, not in
 * git, and `files` ships it.
 */
const starter = starterTemplate as StarterTemplate;

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
  broapp-autoapp                        Open the launcher's own tab
  broapp-autoapp serve <appId> [--no-open]
  broapp-autoapp create <appId> [--name <name>] [--description <text>]
  broapp-autoapp import <sourceDir> --as <appId> [--grant]
  broapp-autoapp build <appId>
  broapp-autoapp activate <appId> <releaseId>
  broapp-autoapp releases <appId>
  broapp-autoapp status <appId>
  broapp-autoapp mcp <appId>            Serve one application over MCP, on stdio
  broapp-autoapp knowledge list [--provisional|--confirmed|--review|--method]
  broapp-autoapp knowledge show <id>
  broapp-autoapp knowledge confirm <id> [--by <name>] [--yes]
  broapp-autoapp knowledge retire <id>
  broapp-autoapp knowledge export [--json]
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
isolated from the launcher, not permission isolated from you.`;

/** How long a child gets to stop before it is killed. */
const STOP_DEADLINE_MS = 10_000;

/** Register the handlers that make sure no child outlives the launcher. */
function stopChildrenOnExit(supervisor: Supervisor): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void supervisor.stopAll(STOP_DEADLINE_MS).then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
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
    if (supervisor.children.length > 0) stop();
  });
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
  let control: Control | null = startControl({ layout: root, supervisor, ...loggerOf(recording) });
  process.on('exit', () => control?.stop());

  console.log(`${appId} ${current}`);
  const code = await keepServing({
    layout: root,
    supervisor,
    appId,
    ...loggerOf(recording),
    onStart: (child, restart) => {
      if (restart > 0) console.log(`${appId} stopped and was started again; its address has changed.`);
      // The launch URL carries a one-time token and is a credential until it is
      // redeemed. Written to the terminal on purpose, because somebody whose
      // browser did not open needs it — and to the terminal only.
      console.log(`Open this address if your browser does not: ${child.url}`);
      if (!open) return;
      void openBrowser(child.url).then((opened) => {
        if (!opened) console.log('Could not open a browser automatically. Use the address above.');
      });
    },
  });
  control.stop();
  control = null;
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

  // The door an MCP server comes in by. Only the launcher's own long-running
  // commands open it, and it is removed when they stop.
  const control = startControl({ layout: root, supervisor, ...loggerOf(recording) });

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
        }),
    template: starter,
    versions: VERSIONS,
    providers: [anthropic(), ollama(), openai(), customServer()],
    // The offline tier tests need a launcher whose AI layer cannot reach the
    // network, and severing an interface in CI is not something a test may do.
    // Honoured only under `NODE_ENV=test`, read through `Bun.env` because
    // `--minify` folds `process.env.NODE_ENV` into the binary at build time.
    ...(Bun.env['NODE_ENV'] === 'test' && Bun.env['AUTOAPP_TEST_NO_NETWORK'] === '1'
      ? { fetch: noNetwork }
      : {}),
  });

  const running = await startApp({
    page,
    appName: 'Autoapp',
    version: selfManifest.version,
    mode: 'background',
    openBrowser: open,
    register: (bridge) => tab.mount(bridge),
    isBusy: () => tab.ai.activeStreams > 0,
    onShutdown: async () => {
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
      recording?.knowledge.close();
    },
  });

  return await running.done;
}

/**
 * A `fetch` that refuses, for the offline tier tests.
 *
 * The AI layer takes its `fetch` as an option precisely so a test can decide
 * what the network is. Nothing else in the launcher makes a request.
 */
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
): Promise<number> {
  const created = await createApplication({
    layout: root,
    template: starter,
    versions: VERSIONS,
    appId,
    name,
    description,
  });
  for (const note of created.notes) console.log(note);
  if (!created.ok) {
    for (const problem of created.problems) console.error(`${problem.stage}: ${problem.message}`);
    return 1;
  }
  console.log(`${appId} ${created.releaseId}`);
  return 0;
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
  const journal = openJournal(root.journal);
  // The long-running commands write down what happens. Opened before the
  // supervisor, so a child's stderr is recorded from its first line; one-shot
  // commands keep printing to the terminal and write nothing.
  const longRunning = command === undefined || command === 'open' || command === 'serve';
  const knowledge = longRunning ? openKnowledge(join(root.root, 'launcher')) : null;
  const recording: Recording | null =
    knowledge === null
      ? null
      : { knowledge, log: createEventLog(knowledge, { source: 'launcher', tee: console }) };
  const supervisor = createSupervisor(loggerOf(recording));
  stopChildrenOnExit(supervisor);

  try {
    switch (command) {
      case undefined:
      case 'open':
        return await openLauncher(root, journal, supervisor, !argv.includes('--no-open'), recording);

      case 'serve': {
        const appId = positional(argv, 1);
        // `serve` with no application is the launcher's own tab, which is the
        // ordinary way in: from there a person opens whichever they want.
        if (appId === undefined) {
          return await openLauncher(root, journal, supervisor, !argv.includes('--no-open'), recording);
        }
        return await serve(root, journal, supervisor, appId, !argv.includes('--no-open'), recording);
      }

      case 'create': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('create <appId> [--name <name>] [--description <text>]');
        return await createApp(
          root,
          appId,
          flagValue(argv, '--name') ?? appId,
          flagValue(argv, '--description') ?? '',
        );
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
        const providers = [anthropic(), ollama(), openai(), customServer()];
        const aiDataDir = join(root.root, 'launcher');
        if (argv[1] === 'replay') return await runReplayCommand({ root, argv: argv.slice(2), providers, aiDataDir });
        if (argv[1] === 'evaluate') {
          return await runEvaluateCommand({
            root,
            argv: argv.slice(2),
            providers,
            aiDataDir,
            // Notes is not in the binary; the evaluation is a developer's
            // measurement, run from a checkout.
            notesDir: resolve(flagValue(argv, '--notes') ?? join('examples', 'notes')),
            template: starter,
            versions: VERSIONS,
          });
        }
        // Reads the database directly, like `status`, and refuses to change it
        // while a launcher is serving.
        return runKnowledgeCommand({ root, argv: argv.slice(1) });
      }

      case 'status': {
        const appId = positional(argv, 1);
        if (appId === undefined) return usage('status <appId>');
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
  },
  (cause: unknown) => {
    console.error(String(cause instanceof Error ? cause.message : cause));
    process.exitCode = 1;
  },
);
