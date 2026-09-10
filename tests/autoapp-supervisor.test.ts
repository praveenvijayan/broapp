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

import { buildCandidate, createSupervisor, isCompiled, selfCommand, type Supervisor } from 'broapp-autoapp/launcher';
import { layout, setCurrent } from 'broapp-autoapp/spec';

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
