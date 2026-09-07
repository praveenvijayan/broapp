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

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { anthropic } from 'broapp-ai-anthropic';
import { customServer, ollama, openai } from 'broapp-ai-compatible';
import { ensureDataDir, openBrowser, startApp } from 'broapp/host';

import { createRunStore } from '../host/run-store.ts';

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
import { createLauncherTab } from './tab.ts';

/**
 * The launcher's own page, inlined into the binary.
 *
 * `@types/bun` declares every `*.html` import as `HTMLBundle` without looking at
 * the import attribute. With `{ type: "text" }` the value really is a string.
 */
const page = launcherPage as unknown as string;

const HELP = `broapp-autoapp

Usage:
  broapp-autoapp                        Open the launcher's own tab
  broapp-autoapp serve <appId> [--no-open]
  broapp-autoapp import <sourceDir> --as <appId> [--grant]
  broapp-autoapp build <appId>
  broapp-autoapp activate <appId> <releaseId>
  broapp-autoapp releases <appId>
  broapp-autoapp status <appId>
  broapp-autoapp mcp <appId>            Serve one application over MCP, on stdio

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

/** `serve <appId>` — recover whatever was interrupted, then run it. */
async function serve(
  root: Layout,
  journal: Journal,
  supervisor: Supervisor,
  appId: string,
  open: boolean,
): Promise<number> {
  for (const recovered of await recover({ layout: root, journal, supervisor, start: false })) {
    console.log(`recovered: ${recovered.finding}`);
  }
  const current = readCurrent(root, appId);
  if (current === null) {
    console.error(`${appId} has no current release. Run "import" or "activate" first.`);
    return 1;
  }
  // Opened here too, so `serve <appId>` — one application without the launcher
  // tab — is still reachable over MCP.
  let control: Control | null = startControl({ layout: root, supervisor });
  process.on('exit', () => control?.stop());

  console.log(`${appId} ${current}`);
  const code = await keepServing({
    layout: root,
    supervisor,
    appId,
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
): Promise<number> {
  for (const recovered of await recover({ layout: root, journal, supervisor, start: false })) {
    console.log(`recovered: ${recovered.finding}`);
  }

  // The door an MCP server comes in by. Only the launcher's own long-running
  // commands open it, and it is removed when they stop.
  const control = startControl({ layout: root, supervisor });

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
    }),
    dataDir,
    store,
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
    version: '0.1.0',
    mode: 'background',
    openBrowser: open,
    register: (bridge) => tab.mount(bridge),
    isBusy: () => tab.ai.activeStreams > 0,
    onShutdown: async () => {
      tab.ai.abortAll('the launcher is shutting down');
      control.stop();
      // Applications the launcher started do not outlive it.
      await supervisor.stopAll(STOP_DEADLINE_MS);
      store.close();
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

  // The one moment dependencies may be fetched. Everything after this — every
  // candidate build, every activation — resolves what is already on disk, which
  // is what makes editing an application offline mean anything.
  //
  // `BUN_BE_BUN=1` turns this compiled binary back into the plain `bun` CLI;
  // report 02 verified that. It is best effort: an application whose
  // `package.json` uses the `workspace:*` protocol cannot be installed outside
  // its monorepo, and the examples in this repository are exactly that. A
  // dependency that is genuinely missing is caught by the build, which names
  // the package and says to re-import.
  const installed = Bun.spawnSync({
    cmd: [process.execPath, 'install', '--production', '--frozen-lockfile'],
    cwd: app.source,
    env: { ...process.env, BUN_BE_BUN: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  console.log(
    installed.exitCode === 0
      ? 'installed the application’s dependencies'
      : `could not install dependencies here (${new TextDecoder().decode(installed.stderr).trim().split('\n').pop() ?? 'no reason given'}); the build will say if one is missing`,
  );

  // Git is optional. A candidate workspace is more useful with history, and the
  // launcher has to work on a machine without it.
  const git = Bun.spawnSync({ cmd: ['git', 'init', '--quiet'], cwd: app.source, stdout: 'ignore', stderr: 'ignore' });
  console.log(git.exitCode === 0 ? 'initialised a git repository in the workspace' : 'git is not available; the workspace has no history');

  const built = await buildCandidate({ layout: root, appId });
  if (!built.ok) {
    for (const problem of built.problems) console.error(`${problem.stage}: ${problem.message}`);
    return 1;
  }

  const wanted = built.spec.manifest.capabilities;
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
  writeGrants(root, appId, {
    appId,
    releaseId: built.releaseId,
    grantedAt: Date.now(),
    capabilities: wanted,
  });
  setCurrent(root, appId, built.releaseId);
  console.log(`${appId} ${built.releaseId}`);
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
  const supervisor = createSupervisor();
  stopChildrenOnExit(supervisor);

  try {
    switch (command) {
      case undefined:
      case 'open':
        return await openLauncher(root, journal, supervisor, !argv.includes('--no-open'));

      case 'serve': {
        const appId = positional(argv, 1);
        // `serve` with no application is the launcher's own tab, which is the
        // ordinary way in: from there a person opens whichever they want.
        if (appId === undefined) {
          return await openLauncher(root, journal, supervisor, !argv.includes('--no-open'));
        }
        return await serve(root, journal, supervisor, appId, !argv.includes('--no-open'));
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
