#!/usr/bin/env bun
/**
 * End-to-end smoke test for the compiled Autoapp launcher.
 *
 * The unit tests drive the launcher's modules from a `bun test` process. This
 * drives the *binary*, the way a person does: import an application, serve it,
 * reach it over the loopback control connection, build and activate a second
 * release, kill the launcher mid-activation, and start it again to watch
 * recovery finish the job. It is the check that catches a packaging fault the
 * module tests cannot see, because they never load the compiled artifact.
 *
 *   bun run scripts/autoapp-smoke.ts
 *
 * Exits 0 when every step passed, and non-zero with one line saying which did
 * not. Nothing here is skipped on any platform; a step that cannot work
 * somewhere must say so out loud rather than quietly passing.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const launcher = join(repo, 'packages', 'broapp-autoapp', 'dist', 'broapp-autoapp');
const fixture = join(repo, 'tests', 'fixtures', 'autoapp-app');

/**
 * The run root, inside the repository on purpose.
 *
 * A workspace copied to a temporary directory cannot resolve `broapp` — its
 * dependencies use the `workspace:*` protocol and are satisfied by this
 * repository's own `node_modules`. Report 05 found this the hard way; the
 * launcher's own tests keep their roots here for the same reason.
 */
const root = join(repo, 'tests', '.autoapp-run', 'smoke');

const failures: string[] = [];
let serving: ReturnType<typeof Bun.spawn> | null = null;

function fail(step: string, detail: string): void {
  failures.push(`${step}: ${detail}`);
  console.error(`✗ ${step}: ${detail}`);
}

function ok(step: string, detail = ''): void {
  console.log(`✓ ${step}${detail === '' ? '' : ` — ${detail}`}`);
}

/** Run the launcher once and wait for it. */
function run(
  args: readonly string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const done = Bun.spawnSync({
    cmd: [launcher, ...args],
    env: { ...process.env, BROAPP_DATA_DIR: root, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: done.exitCode ?? -1,
    stdout: new TextDecoder().decode(done.stdout),
    stderr: new TextDecoder().decode(done.stderr),
  };
}

/** A deadline that does not hold the process open. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((settle) => {
    const timer = setTimeout(() => settle(value), ms);
    timer.unref?.();
  });
}

/** Wait for `check` to be true, or give up. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await after(100, null);
  }
  return check();
}

/** The launcher's control file, once it exists. */
function controlFile(): { port: number; secret: string } | null {
  const path = join(root, 'autoapp', 'launcher.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { port: number; secret: string };
  } catch {
    return null;
  }
}

/** One `describe` over the control connection, the way an MCP server does it. */
async function describeOverControl(appId: string): Promise<unknown> {
  const file = controlFile();
  if (file === null) throw new Error('no launcher.json');
  const lines: Record<string, unknown>[] = [];
  const socket = await Bun.connect<undefined>({
    hostname: '127.0.0.1',
    port: file.port,
    socket: {
      data(_s, chunk) {
        for (const line of new TextDecoder().decode(chunk).split('\n')) {
          if (line.trim() !== '') lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      },
    },
  });
  socket.write(`${JSON.stringify({ v: 1, type: 'auth', secret: file.secret })}\n`);
  socket.write(`${JSON.stringify({ v: 1, id: 'm1', type: 'describe', appId })}\n`);
  const arrived = await until(() => lines.some((one) => one['re'] === 'm1'), 10_000);
  socket.end();
  if (!arrived) throw new Error('the control connection did not answer describe');
  return lines.find((one) => one['re'] === 'm1');
}

/** Start `serve` in the background and wait for its control file. */
async function startServing(env: Record<string, string> = {}): Promise<boolean> {
  serving = Bun.spawn({
    cmd: [launcher, 'serve', 'items', '--no-open'],
    env: { ...process.env, BROAPP_DATA_DIR: root, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Both pipes are drained. A full pipe would wedge the launcher, and report 02
  // spent fifteen minutes learning that.
  void new Response(serving.stdout as ReadableStream<Uint8Array>).text();
  void new Response(serving.stderr as ReadableStream<Uint8Array>).text();
  return await until(() => controlFile() !== null, 30_000);
}

/**
 * Stop whatever is serving, however it has to be stopped.
 *
 * On Windows a `SIGTERM` is not delivered to a console process the way it is on
 * POSIX — Bun terminates the process outright, so the launcher's handlers never
 * run and the application children it started would be left behind. `taskkill
 * /F /T` takes the whole tree instead. This is the same asymmetry the launcher
 * answers with a `process.on('exit')` kill; here there is no handler to reach.
 */
async function stopServing(): Promise<void> {
  if (serving === null) return;
  if (process.platform === 'win32') {
    Bun.spawnSync({
      cmd: ['taskkill', '/F', '/T', '/PID', String(serving.pid)],
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } else {
    serving.kill('SIGTERM');
    await Promise.race([serving.exited, after(5_000, null)]);
    if (serving.exitCode === null) serving.kill('SIGKILL');
  }
  await Promise.race([serving.exited, after(5_000, null)]);
  serving = null;
}

async function main(): Promise<number> {
  if (!existsSync(launcher)) {
    console.error(`the launcher is not built: ${launcher}`);
    console.error('run: bun run --cwd packages/broapp-autoapp build:launcher');
    return 2;
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  // 1. Import.
  const imported = run(['import', fixture, '--as', 'items', '--grant']);
  if (imported.code !== 0) fail('import', imported.stderr.trim() || imported.stdout.trim());
  else ok('import', imported.stdout.trim().split('\n').pop() ?? '');

  const app = join(root, 'autoapp', 'apps', 'items');
  const first = existsSync(join(app, 'current'))
    ? readFileSync(join(app, 'current'), 'utf8').trim()
    : '';
  if (!/^[0-9a-f]{32}$/.test(first)) fail('import', `current is ${JSON.stringify(first)}`);

  // 2. Serve, and reach it over the control connection.
  if (!(await startServing())) {
    fail('serve', 'no launcher.json appeared within 30s');
  } else {
    ok('serve', `control on port ${String(controlFile()?.port ?? 0)}`);
    try {
      const described = (await describeOverControl('items')) as {
        ok?: boolean;
        output?: { releaseId?: string; contract?: { operations?: Record<string, unknown> } };
      };
      if (described.ok !== true) fail('describe', JSON.stringify(described));
      else if (described.output?.releaseId !== first) {
        fail('describe', `named ${String(described.output?.releaseId)}, expected ${first}`);
      } else {
        const routes = Object.keys(described.output.contract?.operations ?? {});
        ok('describe', `${String(routes.length)} operations`);
      }
    } catch (cause) {
      fail('describe', String(cause instanceof Error ? cause.message : cause));
    }
  }
  await stopServing();

  // 3. A second release, from a changed workspace.
  const views = join(app, 'source', 'src', 'shared', 'views.ts');
  writeFileSync(views, readFileSync(views, 'utf8').replace("header: 'Label'", "header: 'What'"));
  const built = run(['build', 'items']);
  const second = built.stdout.trim().split(/\s+/)[0] ?? '';
  if (built.code !== 0 || !/^[0-9a-f]{32}$/.test(second)) {
    fail('build', built.stderr.trim() || built.stdout.trim());
  } else if (second === first) {
    // The whole point of prompt 08b: a views-only change is a new release.
    fail('build', 'a views-only change produced the same release identity');
  } else {
    ok('build', second);
  }

  // 4. Activate it.
  if (second !== '' && second !== first) {
    const activated = run(['activate', 'items', second]);
    if (activated.code !== 0) fail('activate', activated.stderr.trim() || activated.stdout.trim());
    else if (readFileSync(join(app, 'current'), 'utf8').trim() !== second) {
      fail('activate', 'current did not move');
    } else ok('activate', activated.stdout.trim());
  }

  // 5. Crash during an activation, past the switch, then recover.
  const third = (() => {
    writeFileSync(views, readFileSync(views, 'utf8').replace("header: 'What'", "header: 'Third'"));
    const again = run(['build', 'items']);
    return again.stdout.trim().split(/\s+/)[0] ?? '';
  })();
  if (!/^[0-9a-f]{32}$/.test(third)) {
    fail('build (third)', 'no release id');
  } else {
    // `switched-half` is the genuinely torn state: the live data has been moved
    // aside and its replacement not yet renamed into place, and `current` still
    // names the old release. Recovery has to finish the switch rather than find
    // there was nothing to do.
    //
    // `NODE_ENV=test` is required by the hook itself, so that a stray variable
    // on a real machine cannot make an activation abandon somebody's data
    // halfway through. Setting it here is the whole reason the guard exists.
    const crashed = run(['activate', 'items', third], {
      NODE_ENV: 'test',
      AUTOAPP_TEST_CRASH_AT: 'switched-half',
    });
    if (crashed.code === 0) fail('crash', 'the injected crash did not stop the activation');
    else if (readFileSync(join(app, 'current'), 'utf8').trim() === third) {
      fail('crash', 'current moved before the crash; the state was not torn');
    } else ok('crash', `activate exited ${String(crashed.code)} with the pair half-switched`);

    // The launcher that crashed left its children behind; a fresh one stops
    // them as it recovers. This is `serve` doing exactly what it does on a
    // machine that was rebooted mid-update.
    if (!(await startServing())) {
      fail('recover', 'the launcher would not start again after the crash');
    } else {
      const current = readFileSync(join(app, 'current'), 'utf8').trim();
      if (current !== third) fail('recover', `current is ${current}, expected ${third}`);
      else if (existsSync(join(app, 'data-next'))) {
        fail('recover', 'data-next survived the recovery');
      } else ok('recover', `finished the interrupted switch to ${third}`);
      await stopServing();
    }
  }

  // 6. The control file is gone once nothing is serving.
  if (controlFile() !== null) fail('cleanup', 'launcher.json outlived the launcher');
  else ok('cleanup', 'launcher.json removed on exit');

  return failures.length === 0 ? 0 : 1;
}

main().then(
  async (code) => {
    await stopServing();
    rmSync(root, { recursive: true, force: true });
    if (code === 0) console.log('\nautoapp smoke: every step passed');
    else console.error(`\nautoapp smoke: ${String(failures.length)} step(s) failed`);
    process.exit(code);
  },
  async (cause: unknown) => {
    await stopServing();
    rmSync(root, { recursive: true, force: true });
    console.error(`autoapp smoke: ${String(cause instanceof Error ? cause.stack ?? cause.message : cause)}`);
    process.exit(1);
  },
);
