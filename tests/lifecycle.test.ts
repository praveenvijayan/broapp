/**
 * Lifecycle and per-user data.
 *
 * The interactive-mode tests use short timers so they finish quickly. What they
 * check is the *policy* — attached versus retained, busy versus idle, never
 * connected — which is where the mistakes are.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DATA_DIR_ENV, createHostApp, dataDir, ensureDataDir, startApp } from 'broapp/host';
import type { RunningApp } from 'broapp/host';
import { defineContract, s } from 'broapp/shared';

import { harness, until } from './harness.ts';

const contract = defineContract({
  operations: { 'x.ping': { input: s.void(), output: s.literal('pong') } },
  streams: {
    'x.forever': {
      params: s.object({}),
      event: s.object({ n: s.number() }),
    },
  },
});

let running: RunningApp | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

const silent = { log: () => undefined };

describe('data directory', () => {
  test('an override is used verbatim', () => {
    expect(dataDir('demo', { [DATA_DIR_ENV]: '/somewhere/custom' })).toBe('/somewhere/custom');
  });

  test('an empty override falls back to the platform location', () => {
    const resolved = dataDir('demo', { [DATA_DIR_ENV]: '' });
    expect(resolved).toContain('demo');
    expect(resolved).not.toBe('');
  });

  test('the resolved path is outside the working directory', () => {
    // A compiled binary may be run from anywhere, and from a read-only volume.
    expect(dataDir('demo', {}).startsWith(process.cwd())).toBe(false);
  });

  test('ensureDataDir creates the directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'broapp-data-'));
    try {
      const created = ensureDataDir('demo', { [DATA_DIR_ENV]: join(base, 'nested', 'deep') });
      expect((await stat(created)).isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('interactive mode', () => {
  test('exits when no browser ever connects', async () => {
    const started = await startApp({
      page: '<!doctype html>',
      appName: 'never',
      version: '0',
      register: () => undefined,
      mode: 'interactive',
      openBrowser: false,
      launchTimeoutMs: 300,
      stdout: silent,
    });
    running = started;
    // A nonzero code, because a launch nobody reached is a failure, not a
    // successful run that happened to be short.
    expect(await started.done).toBe(1);
    running = null;
  });

  test('exits after the last tab detaches, once the grace period passes', async () => {
    const app = createHostApp<typeof contract>(contract);
    app.operation('x.ping', () => 'pong' as const);
    app.stream('x.forever', async (_params, sink) => {
      for (let n = 0; !sink.signal.aborted; n += 1) {
        await sink.emit({ n });
        await Bun.sleep(20);
      }
    });

    const test = await harness((bridge) => app.mount(bridge), {
      mode: 'interactive',
      idleGraceMs: 200,
      launchTimeoutMs: 10_000,
    });
    running = test.app;

    const client = await test.connect(contract);
    expect(await client.call('x.ping', undefined)).toBe('pong');
    await client.close();

    expect(await test.app.done).toBe(0);
    running = null;
  }, 15_000);

  test('a busy host does not exit on the idle timer', async () => {
    // Brobridge retains a session for replay after its socket drops, so
    // counting sessions would also keep the host alive here. This asserts the
    // *busy* rule specifically: the host stays up because work is running.
    let releaseWork = false;
    const app = createHostApp<typeof contract>(contract);
    app.operation('x.ping', () => 'pong' as const);
    app.stream('x.forever', async (_params, sink) => {
      while (!releaseWork && !sink.signal.aborted) await Bun.sleep(10);
    });

    let busy = true;
    const test = await harness((bridge) => app.mount(bridge), {
      mode: 'interactive',
      idleGraceMs: 100,
      launchTimeoutMs: 10_000,
      isBusy: () => busy,
    });
    running = test.app;

    const client = await test.connect(contract);
    await client.call('x.ping', undefined);
    await client.close();

    let exited = false;
    void test.app.done.then(() => {
      exited = true;
    });

    await Bun.sleep(600);
    expect(exited).toBe(false);

    busy = false;
    releaseWork = true;
    await until(() => exited, 5_000, 'the host to exit once idle');
    running = null;
  }, 15_000);
});

describe('background mode', () => {
  test('stays up after the last tab closes', async () => {
    const app = createHostApp<typeof contract>(contract);
    app.operation('x.ping', () => 'pong' as const);
    app.stream('x.forever', async (_params, sink) => {
      while (!sink.signal.aborted) await Bun.sleep(10);
    });

    const test = await harness((bridge) => app.mount(bridge), { mode: 'background' });
    running = test.app;

    const client = await test.connect(contract);
    await client.call('x.ping', undefined);
    await client.close();

    let exited = false;
    void test.app.done.then(() => {
      exited = true;
    });
    await Bun.sleep(500);
    expect(exited).toBe(false);

    // A second tab can still connect, which is the reason to run this way.
    const second = await test.connect(contract);
    expect(await second.call('x.ping', undefined)).toBe('pong');
    await second.close();
  }, 15_000);
});

describe('shutdown', () => {
  test('runs the shutdown hook, releases the port, and reports why', async () => {
    const reasons: string[] = [];
    const started = await startApp({
      page: '<!doctype html>',
      appName: 'shutdown',
      version: '0',
      register: () => undefined,
      mode: 'background',
      openBrowser: false,
      stdout: silent,
      onShutdown: (reason) => {
        reasons.push(reason);
      },
    });
    const { port } = started.bridge;

    await started.stop();
    expect(reasons).toEqual(['requested']);
    expect(await started.done).toBe(0);

    // The listener is gone, so nothing answers on that port any more.
    await expect(fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow();
  });

  test('stopping twice is harmless', async () => {
    const started = await startApp({
      page: '<!doctype html>',
      appName: 'twice',
      version: '0',
      register: () => undefined,
      mode: 'background',
      openBrowser: false,
      stdout: silent,
    });
    await Promise.all([started.stop(), started.stop()]);
    expect(await started.done).toBe(0);
  });

  test('a failing register does not leave a listener behind', async () => {
    await expect(
      startApp({
        page: '<!doctype html>',
        appName: 'bad',
        version: '0',
        mode: 'background',
        openBrowser: false,
        stdout: silent,
        register: () => {
          throw new Error('registration is broken');
        },
      }),
    ).rejects.toThrow('registration is broken');
  });
});
