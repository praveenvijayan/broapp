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
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { openBrowser } from 'broapp/host';

import { runChild, runMigrate } from '../child/run-child.ts';
import {
  defaultRoot,
  layout,
  listReleases,
  readCurrent,
  readGrants,
  readRelease,
  setCurrent,
  writeGrants,
  type Layout,
} from '../spec/index.ts';

import { activate } from './activate.ts';
import { buildCandidate } from './candidate.ts';
import { openJournal, type Journal } from './journal.ts';
import { recover } from './recover.ts';
import { createSupervisor, type Supervisor } from './supervisor.ts';

const HELP = `broapp-autoapp

Usage:
  broapp-autoapp serve <appId> [--no-open]
  broapp-autoapp import <sourceDir> --as <appId> [--grant]
  broapp-autoapp build <appId>
  broapp-autoapp activate <appId> <releaseId>
  broapp-autoapp releases <appId>
  broapp-autoapp status <appId>

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
  const app = root.app(appId);
  const child = await supervisor.start({
    appId,
    releaseDir: app.release(current),
    releaseId: current,
    dataDir: app.data,
    mode: 'live',
  });

  // The launch URL carries a one-time token and is a credential until it is
  // redeemed. Written to the terminal on purpose, because somebody whose
  // browser did not open needs it — and to the terminal only.
  console.log(`${appId} ${current}`);
  console.log(`Open this address if your browser does not: ${child.url}`);
  if (open) {
    void openBrowser(child.url).then((opened) => {
      if (!opened) console.log('Could not open a browser automatically. Use the address above.');
    });
  }
  return (await child.exited) ?? 0;
}

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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // The two child roles come first: they are how the launcher starts an
  // application, and they must not fall through to argument parsing.
  if (command === '--child') return await runChild(argv.slice(1));
  if (command === '--migrate') return await runMigrate(argv.slice(1));

  if (command === undefined || command === '-h' || command === '--help') {
    console.log(HELP);
    return command === undefined ? 1 : 0;
  }

  const root = layout(defaultRoot());
  mkdirSync(root.root, { recursive: true, mode: 0o700 });
  const journal = openJournal(root.journal);
  const supervisor = createSupervisor();
  stopChildrenOnExit(supervisor);

  try {
    switch (command) {
      case 'serve': {
        const appId = argv[1];
        if (appId === undefined) return usage('serve <appId>');
        return await serve(root, journal, supervisor, appId, !argv.includes('--no-open'));
      }

      case 'import': {
        const sourceDir = argv[1];
        const appId = flagValue(argv, '--as');
        if (sourceDir === undefined || appId === undefined) return usage('import <sourceDir> --as <appId>');
        return await importApp(root, sourceDir, appId, argv.includes('--grant'));
      }

      case 'build': {
        const appId = argv[1];
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
        const appId = argv[1];
        const releaseId = argv[2];
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
        const appId = argv[1];
        if (appId === undefined) return usage('releases <appId>');
        const current = readCurrent(root, appId);
        for (const release of listReleases(root, appId)) {
          const spec = readRelease(root, appId, release.releaseId);
          console.log(
            `${release.releaseId === current ? '*' : ' '} ${release.releaseId}  schema ${String(spec.manifest.schemaVersion)}  ${new Date(release.createdAt).toISOString()}`,
          );
        }
        return 0;
      }

      case 'status': {
        const appId = argv[1];
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
    if (command !== 'serve') await supervisor.stopAll(STOP_DEADLINE_MS);
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
