/**
 * The spike: compiled supervision.
 *
 * Everything here runs a *compiled binary*. That is the point — `bun run`
 * would prove nothing about a launcher that has to spawn children on a machine
 * with no Bun installation, and the failures this spike is looking for (a
 * hidden `bun` on the path, an artifact the bundler quietly inlined, a child
 * that cannot be made to stop) are invisible under the interpreter.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isMessage, parseMessage } from '../packages/broapp-autoapp/src/ipc/codec.ts';
import { MAX_MESSAGE_BYTES } from '../packages/broapp-autoapp/src/ipc/messages.ts';

const root = join(import.meta.dir, '..');
const packageDir = join(root, 'packages', 'broapp-autoapp');
const launcher = join(packageDir, 'spike', 'dist', 'launcher');
const artifact = join(packageDir, 'spike', 'app-v1', 'index.ts');

/**
 * Compile the launcher once, at module load.
 *
 * Not in `beforeAll`: whether the binary exists decides whether the tests are
 * registered at all, and `skipIf` is evaluated when they are. A compiler that
 * is not there has to skip loudly rather than fail every case with the same
 * unhelpful error.
 */
async function compile(): Promise<string | null> {
  const built = Bun.spawn({
    cmd: [
      'bun',
      'build',
      '--compile',
      '--bytecode',
      '--minify',
      'spike/launcher.ts',
      '--outfile',
      'spike/dist/launcher',
    ],
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Both pipes are drained. An undrained pipe is a subprocess that may never
  // be considered finished, which is exactly the kind of hang this file exists
  // to catch in the launcher and must not introduce in itself.
  const [code, , stderr] = await Promise.all([
    built.exited,
    new Response(built.stdout).text(),
    new Response(built.stderr).text(),
  ]);
  return code === 0 ? null : stderr.trim();
}

const failure = await compile();
if (failure !== null) {
  console.warn(`[autoapp-spike] skipped: bun build --compile is unavailable\n${failure}`);
}
const available = failure === null;

/** Every child this file started, so `afterEach` can be sure none is left. */
const started: { kill(): void }[] = [];
let directory = '';

afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      child.kill();
    } catch {
      // Already gone, which is the outcome the test wanted anyway.
    }
  }
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

/** What one launcher run printed and exited with. */
interface Run {
  readonly line: Record<string, unknown>;
  readonly exitCode: number;
  readonly dataDir: string;
}

/** Run the compiled launcher once, against a fresh data directory. */
async function run(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Run> {
  directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  const child = Bun.spawn({
    cmd: [launcher, ...args],
    env: { ...process.env, BROAPP_DATA_DIR: directory, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  started.push(child);
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const last = stdout.trim().split('\n').at(-1) ?? '';
  return { line: JSON.parse(last) as Record<string, unknown>, exitCode, dataDir: directory };
}

/**
 * True when a process with this id is still on the process table.
 *
 * Signal 0 is the standard existence probe: it delivers nothing and only
 * reports whether the process is there. `EPERM` means it is there and belongs
 * to somebody else, which still counts as alive.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as { code?: string }).code === 'EPERM';
  }
}

describe.skipIf(!available)('compiled supervision', () => {
  test('the six messages round-trip and the child exits cleanly', async () => {
    const { line, exitCode, dataDir } = await run([artifact, 'app-1', 'rel-1']);
    expect(line).toMatchObject({
      hello: true,
      ready: true,
      schemaVersion: 1,
      health: 'serving',
      drained: true,
      exitCode: 0,
      killed: false,
    });
    expect(exitCode).toBe(0);
    // Written by the artifact, from inside the child. The launcher never
    // imported it, so this is the proof that the dynamic import happened in
    // the process that was supposed to do it.
    expect(readFileSync(join(dataDir, 'spike.log'), 'utf8')).toContain('started');
  });

  test('a child that ignores shutdown is killed, and the launcher still reports', async () => {
    const startedAt = Date.now();
    const { line, exitCode } = await run([artifact, 'app-1', 'rel-1'], {
      AUTOAPP_SPIKE_MISBEHAVE: 'ignore-shutdown',
    });
    expect(line).toMatchObject({ killed: true, ready: true, drained: true });
    expect(exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // The shutdown deadline is two seconds, so this case cannot finish inside
    // bun:test's default five.
  }, 15_000);

  test('a missing hello is caught by the deadline, and no child is left behind', async () => {
    const { line, exitCode } = await run([artifact, 'app-1', 'rel-1'], {
      AUTOAPP_SPIKE_MISBEHAVE: 'no-hello',
    });
    expect(String(line['error'])).toContain('hello');
    expect(exitCode).toBe(1);
    const pid = line['pid'];
    expect(typeof pid).toBe('number');
    expect(alive(pid as number)).toBe(false);
    // The hello deadline alone is five seconds, and the child is then given
    // three more to exit before it is killed.
  }, 20_000);

  test('a version this build cannot read ends the child with the protocol code', async () => {
    const { line, exitCode } = await run([artifact, 'app-1', 'rel-1'], {
      AUTOAPP_SPIKE_MISBEHAVE: 'bad-version',
    });
    expect(String(line['error'])).toContain('version');
    expect(line['childExit']).toBe(3);
    expect(exitCode).toBe(1);
  });

  test('an artifact that is not there is reported as the child said it', async () => {
    const { line, exitCode } = await run([join(tmpdir(), 'no-such-artifact.ts'), 'app-1', 'rel-1']);
    expect(String(line['error'])).toContain('could not be started');
    expect(exitCode).toBe(1);
  });
});

describe('parseMessage', () => {
  /** A well-formed message, for a test to spoil one field at a time. */
  const hello = { v: 1, id: 'c1', type: 'hello', appId: 'a', releaseId: 'r', pid: 42 };

  test('accepts each of the seven message types', () => {
    expect(parseMessage(hello).type).toBe('hello');
    expect(parseMessage({ v: 1, id: 'c2', type: 'ready', url: 'x://y', schemaVersion: 1 }).type).toBe('ready');
    expect(parseMessage({ v: 1, id: 'c3', type: 'health', state: 'serving', activeWork: 0 }).type).toBe('health');
    expect(parseMessage({ v: 1, id: 'c4', type: 'drain', deadlineMs: 10, drained: true }).type).toBe('drain');
    expect(parseMessage({ v: 1, id: 'c5', type: 'shutdown', deadlineMs: 10 }).type).toBe('shutdown');
    expect(parseMessage({ v: 1, id: 'c6', type: 'fatal', reason: 'gone' }).type).toBe('fatal');
    expect(parseMessage({ v: 1, id: 'c7', type: 'migrate', dataDir: '/tmp/x' }).type).toBe('migrate');
  });

  test('a reply keeps the identifier it answers', () => {
    const reply = parseMessage({ v: 1, id: 'c7', re: 'l3', type: 'health', state: 'draining' });
    expect(reply.re).toBe('l3');
  });

  test('refuses anything that is not an object', () => {
    for (const raw of [null, 'hello', 7, true, ['hello'], undefined]) {
      expect(() => parseMessage(raw)).toThrow(TypeError);
    }
  });

  test('refuses a version this build does not understand', () => {
    expect(() => parseMessage({ ...hello, v: 2 })).toThrow(/version/);
    expect(() => parseMessage({ ...hello, v: undefined })).toThrow(/version/);
  });

  test('refuses an unknown type', () => {
    expect(() => parseMessage({ ...hello, type: 'reticulate' })).toThrow(/type/);
    // A known type is still refused when what it needs is missing.
    expect(() => parseMessage({ v: 1, id: 'c8', type: 'migrate' })).toThrow(/"dataDir"/);
  });

  test('refuses a missing or empty id', () => {
    expect(() => parseMessage({ ...hello, id: undefined })).toThrow(/"id"/);
    expect(() => parseMessage({ ...hello, id: '' })).toThrow(/"id"/);
  });

  test('refuses a field of the wrong type', () => {
    expect(() => parseMessage({ ...hello, pid: 'forty-two' })).toThrow(/"pid"/);
    expect(() => parseMessage({ ...hello, appId: 3 })).toThrow(/"appId"/);
    expect(() => parseMessage({ v: 1, id: 'c8', type: 'health', state: 'napping' })).toThrow(/"state"/);
    expect(() => parseMessage({ v: 1, id: 'c9', type: 'drain', deadlineMs: 1, drained: 'yes' })).toThrow(
      /"drained"/,
    );
    expect(() => parseMessage({ v: 1, id: 'ca', type: 'ready', url: 'x', schemaVersion: 'one' })).toThrow(
      /"schemaVersion"/,
    );
  });

  test('refuses a message larger than the bound', () => {
    const huge = { ...hello, reason: 'x'.repeat(MAX_MESSAGE_BYTES) };
    expect(() => parseMessage(huge)).toThrow(/bytes/);
  });

  test('isMessage answers without throwing', () => {
    expect(isMessage(hello)).toBe(true);
    expect(isMessage({ ...hello, v: 2 })).toBe(false);
  });
});
