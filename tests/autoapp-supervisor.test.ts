/**
 * The supervisor spawning the launcher it is part of.
 *
 * Every other file that starts a child does so from the compiled binary. This
 * one starts it from source, the way `bun src/launcher/main.ts` and the
 * `broapp-autoapp` bin that `bun install` links to it do — where
 * `process.execPath` is Bun, not the launcher, and a child spawned as
 * `bun --child <releaseDir> …` died with "Script not found" before anything
 * else could go right.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { INTERNAL_ERROR_MESSAGE, isPublicError, PublicError } from 'broapp/shared';
import {
  buildCandidate,
  createSupervisor,
  isCompiled,
  selfCommand,
  START_FAILED,
  startFailed,
  startFailure,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout, setCurrent } from 'broapp-autoapp/spec';

import { NOT_STARTED } from '../packages/broapp-autoapp/src/ipc/messages.ts';

const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
const runRoot = join(import.meta.dir, '.autoapp-run');
const quiet = { warn: () => undefined, error: () => undefined };

let cleanup: { supervisor: Supervisor; directory: string } | null = null;

afterEach(async () => {
  const current = cleanup;
  cleanup = null;
  if (current === null) return;
  await current.supervisor.stopAll(5_000).catch(() => undefined);
  rmSync(current.directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

describe('isCompiled', () => {
  // The question is asked of the runtime rather than of a path's spelling.
  // Reading it out of `Bun.main` was right on POSIX and wrong on Windows, and
  // a launcher that thinks it is running from source spawns itself with
  // `main.ts` as a command, which a binary rejects. `import.meta.path` is no
  // help either: since Bun 1.4 it is the original source path inside a binary.
  test('this test process is not a compiled binary', () => {
    expect(isCompiled()).toBe(false);
    expect(Bun.isStandaloneExecutable).toBe(false);
  });

  test('a binary compiled here says it is one', async () => {
    mkdirSync(runRoot, { recursive: true });
    const directory = mkdtempSync(join(runRoot, 'compiled-'));
    const entry = join(directory, 'probe.ts');
    writeFileSync(entry, 'console.log(String(Bun.isStandaloneExecutable));\n');
    const outfile = join(directory, `probe${process.platform === 'win32' ? '.exe' : ''}`);
    const built = Bun.spawn({
      cmd: ['bun', 'build', '--compile', entry, '--outfile', outfile],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await built.exited).toBe(0);
    const ran = Bun.spawn({ cmd: [outfile], stdout: 'pipe', stderr: 'pipe' });
    const [code, out] = await Promise.all([ran.exited, new Response(ran.stdout).text()]);
    expect(code).toBe(0);
    expect(out.trim()).toBe('true');
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('selfCommand', () => {
  test('from source, it is Bun running the launcher entry module', () => {
    expect(isCompiled()).toBe(false);
    const command = selfCommand();
    expect(command[0]).toBe(process.execPath);
    expect(command).toHaveLength(2);
    expect(command[1]?.endsWith(join('launcher', 'main.ts'))).toBe(true);
    expect(existsSync(command[1] ?? '')).toBe(true);
  });

  test('the command it names is the launcher', async () => {
    const child = Bun.spawn({ cmd: [...selfCommand(), '--help'], stdout: 'pipe', stderr: 'pipe' });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(out).toContain('broapp-autoapp');
  });
});

describe('createSupervisor without execPath', () => {
  test('starts a child from source', async () => {
    mkdirSync(runRoot, { recursive: true });
    const directory = mkdtempSync(join(runRoot, 'supervisor-'));
    const root = layout(directory);
    const app = root.app('items');
    mkdirSync(app.dir, { recursive: true });
    Bun.spawnSync({ cmd: ['cp', '-R', fixture, app.source] });

    const built = await buildCandidate({ layout: root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(root, 'items', built.releaseId);
    mkdirSync(app.data, { recursive: true });

    const supervisor = createSupervisor({ logger: quiet });
    cleanup = { supervisor, directory };

    // Relative, as `BROAPP_DATA_DIR=./run` at a shell once produced: the child
    // must not hand a bare `run/...` to `import()`, where it is a package name.
    const handle = await supervisor.start({
      appId: 'items',
      releaseDir: relative(process.cwd(), app.release(built.releaseId)),
      releaseId: built.releaseId,
      dataDir: relative(process.cwd(), app.data),
      mode: 'live',
    });
    const health = await handle.health();
    expect(health.state).toBe('serving');
  }, 60_000);
});

describe('a child that does not start', () => {
  /** A root with the fixture built after `change` has had its way with the host module. */
  async function brokenRelease(change: (host: string) => string): Promise<{
    root: ReturnType<typeof layout>;
    releaseId: string;
    directory: string;
  }> {
    mkdirSync(runRoot, { recursive: true });
    const directory = mkdtempSync(join(runRoot, 'broken-'));
    const root = layout(directory);
    const app = root.app('items');
    mkdirSync(app.dir, { recursive: true });
    Bun.spawnSync({ cmd: ['cp', '-R', fixture, app.source] });
    const host = join(app.source, 'src', 'host', 'app.ts');
    writeFileSync(host, change(await Bun.file(host).text()));
    const built = await buildCandidate({ layout: root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    mkdirSync(app.data, { recursive: true });
    return { root, releaseId: built.releaseId, directory };
  }

  /** The error `start` throws for a release of `root`, with `options` for the supervisor. */
  async function startError(
    where: { root: ReturnType<typeof layout>; releaseId: string; directory: string },
    options: Parameters<typeof createSupervisor>[0] = {},
  ): Promise<unknown> {
    const supervisor = createSupervisor({ logger: quiet, ...options });
    cleanup = { supervisor, directory: where.directory };
    const app = where.root.app('items');
    try {
      await supervisor.start({
        appId: 'items',
        releaseDir: app.release(where.releaseId),
        releaseId: where.releaseId,
        dataDir: app.data,
        mode: 'preview',
      });
    } catch (cause) {
      return cause;
    }
    throw new Error('the child started');
  }

  // The fault of 2026-09-18: the bundle names something that is not there, so
  // the child's `import` of it throws before `start` is ever called.
  test('a bundle that throws on load fails with a public error naming the reason', async () => {
    const where = await brokenRelease((host) =>
      host.replace(
        "import { latestSchemaVersion, openStore, readSchemaVersion } from './db.ts';",
        "import { latestSchemaVersion, openStore, readSchemaVersion } from './db.ts';\n\n// @ts-expect-error: the fault under test\nconsole.debug([neverDeclared].length);",
      ),
    );
    const cause = await startError(where);
    expect(isPublicError(cause)).toBe(true);
    const error = cause as PublicError;
    expect(error.code).toBe('unavailable');
    expect(error.message).toStartWith(START_FAILED);
    expect(error.message).toContain('neverDeclared is not defined');
    // The child's own prefix is not said a second time.
    expect(error.message.toLowerCase().split('the release could not be started')).toHaveLength(2);
    expect(error.message).not.toContain(INTERNAL_ERROR_MESSAGE);
    expect(startFailure(cause)).toBe(error.message);
  }, 60_000);

  test('a child that exits before hello fails with its exit code', async () => {
    const where = await brokenRelease((host) => host);
    // Bun itself, handed `--child <releaseDir> …`, takes the release directory
    // for a script, finds none, and exits before it could say anything.
    const cause = await startError(where, { execPath: process.execPath });
    expect(isPublicError(cause)).toBe(true);
    expect((cause as PublicError).message).toMatch(/^The release could not be started: the child exited with code [1-9]\d* before it was ready$/);
  }, 60_000);

  test('a child that never says ready fails with the deadline', async () => {
    const where = await brokenRelease((host) =>
      host.replace(
        'export function start(context: AppStartContext): Promise<AppInstance> {',
        'export function start(context: AppStartContext): Promise<AppInstance> {\n  if (context.dataDir !== \'\') return new Promise(() => undefined);',
      ),
    );
    const cause = await startError(where, { readyTimeoutMs: 1_500 });
    expect(isPublicError(cause)).toBe(true);
    expect((cause as PublicError).message).toBe(`${START_FAILED}timed out waiting for ready`);
  }, 60_000);
});

describe('startFailed', () => {
  test('a reason over 400 characters is cut, and a reason with newlines stays one line', () => {
    const long = startFailed(`${NOT_STARTED}${'x'.repeat(600)}`);
    expect(long.message).toHaveLength(400);
    expect(long.message).toStartWith(START_FAILED);
    expect(long.message.endsWith('…')).toBe(true);

    const lines = startFailed('ReferenceError: x is not defined\n    at /release/host.js:3:1\n');
    expect(lines.message).toBe(`${START_FAILED}ReferenceError: x is not defined at /release/host.js:3:1`);
    expect(lines.message).not.toContain('\n');
  });

  test('only a start failure reads as one', () => {
    expect(startFailure(startFailed('the child exited with code 1 before it was ready'))).toContain('code 1');
    expect(startFailure(new PublicError('unavailable', 'the application stopped'))).toBeNull();
    expect(startFailure(new Error(`${START_FAILED}something`))).toBeNull();
  });
});
