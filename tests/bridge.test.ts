/**
 * End-to-end behaviour over a real bridge.
 *
 * Everything here goes through a real socket, a real trust fence and a real
 * session cookie. Where a test asserts that something is refused, it is
 * Brobridge doing the refusing — these tests exist to prove Broapp did not
 * weaken it, not to re-test Brobridge.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { createHostApp, publicError } from 'broapp/host';
import { BroappError } from 'broapp/client';
import { defineContract, s } from 'broapp/shared';

import { harness, until, type Harness } from './harness.ts';

const contract = defineContract({
  operations: {
    'demo.echo': {
      input: s.object({ text: s.string({ min: 1, max: 20 }) }),
      output: s.object({ text: s.string() }),
    },
    'demo.boom': { input: s.void(), output: s.void() },
    'demo.refuse': { input: s.void(), output: s.void() },
    'demo.badOutput': { input: s.void(), output: s.object({ n: s.number() }) },
  },
  streams: {
    'demo.ticks': {
      params: s.object({ count: s.number({ int: true, min: 1, max: 10_000 }) }),
      event: s.object({ n: s.number() }),
    },
  },
});

/** Set by the stream handler so a test can see how far it actually got. */
let emitted = 0;
let handlerFinished = false;

function buildApp() {
  const app = createHostApp<typeof contract>(contract);
  app.operation('demo.echo', ({ text }) => ({ text: text.toUpperCase() }));
  app.operation('demo.boom', () => {
    // A secret in the message, to prove it does not cross to the browser.
    throw new Error('/Users/someone/.config/secret-token-abc123');
  });
  app.operation('demo.refuse', () => {
    throw publicError.rejected('That file is outside the folder this app may read.');
  });
  // Deliberately returns something the output schema forbids.
  app.operation('demo.badOutput', () => ({ n: 'not a number' }) as unknown as { n: number });
  app.stream('demo.ticks', async ({ count }, sink) => {
    for (let n = 1; n <= count; n += 1) {
      if (sink.signal.aborted) return;
      await sink.emit({ n });
      emitted = n;
      await Bun.sleep(5);
    }
    handlerFinished = true;
  });
  return app;
}

let live: Harness | null = null;

async function start(): Promise<Harness> {
  emitted = 0;
  handlerFinished = false;
  const app = buildApp();
  live = await harness((bridge) => app.mount(bridge));
  return live;
}

afterEach(async () => {
  await live?.stop();
  live = null;
});

describe('typed operations', () => {
  test('round-trips a validated call', async () => {
    const test = await start();
    const client = await test.connect(contract);
    expect(await client.call('demo.echo', { text: 'hello' })).toEqual({ text: 'HELLO' });
  });

  test('rejects invalid input on the host, and says which field', async () => {
    const test = await start();
    const client = await test.connect(contract);
    // The browser is where this call was typed, so TypeScript would normally
    // stop it. A different tab, an older build, or curl would not be.
    const bad = client.call('demo.echo', { text: '' } as never);
    await expect(bad).rejects.toThrow(/text/);
    await expect(bad).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('an unexpected failure does not leak its message', async () => {
    const test = await start();
    const client = await test.connect(contract);
    try {
      await client.call('demo.boom', undefined);
      throw new Error('should have rejected');
    } catch (cause) {
      expect(cause).toBeInstanceOf(BroappError);
      const error = cause as BroappError;
      expect(error.code).toBe('internal');
      expect(error.message).not.toContain('secret-token');
      expect(error.message).not.toContain('/Users/');
    }
  });

  test('a deliberate PublicError keeps its message', async () => {
    const test = await start();
    const client = await test.connect(contract);
    try {
      await client.call('demo.refuse', undefined);
      throw new Error('should have rejected');
    } catch (cause) {
      const error = cause as BroappError;
      expect(error.code).toBe('rejected');
      expect(error.message).toBe('That file is outside the folder this app may read.');
    }
  });

  test('a host that breaks its own contract is caught, not rendered', async () => {
    const test = await start();
    const client = await test.connect(contract);
    await expect(client.call('demo.badOutput', undefined)).rejects.toMatchObject({
      code: 'internal',
    });
  });

  test('the host refuses to start with an unimplemented route', async () => {
    const incomplete = createHostApp<typeof contract>(contract);
    incomplete.operation('demo.echo', ({ text }) => ({ text }));
    await expect(harness((bridge) => incomplete.mount(bridge))).rejects.toThrow(
      /no implementation/,
    );
  });

  test('registering a route the contract does not declare is a TypeError', () => {
    const app = createHostApp<typeof contract>(contract);
    expect(() => app.operation('demo.nope' as never, () => undefined as never)).toThrow(
      /not declared/,
    );
  });
});

describe('streams', () => {
  test('delivers every event in order and completes', async () => {
    const test = await start();
    const client = await test.connect(contract);
    const seen: number[] = [];
    let done = false;

    await client.subscribe('demo.ticks', { count: 5 }, {
      onEvent: (event) => seen.push(event.n),
      onDone: () => {
        done = true;
      },
    });

    await until(() => done, 5_000, 'the stream to finish');
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test('cancel() stops the host, not just the browser', async () => {
    const test = await start();
    const client = await test.connect(contract);
    let received = 0;

    const subscription = await client.subscribe('demo.ticks', { count: 10_000 }, {
      onEvent: () => {
        received += 1;
      },
    });

    await until(() => received >= 3, 5_000, 'a few events');
    subscription.cancel();

    // The value the host had reached when cancel was sent. If cancellation did
    // nothing, the handler would run to 10 000 and this would keep climbing.
    const atCancel = emitted;
    await Bun.sleep(300);

    expect(emitted).toBeLessThan(atCancel + 20);
    expect(emitted).toBeLessThan(500);
    expect(handlerFinished).toBe(false);
  });

  test('invalid stream parameters are refused', async () => {
    const test = await start();
    const client = await test.connect(contract);
    await expect(
      client.subscribe('demo.ticks', { count: 0 } as never, { onEvent: () => undefined }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('the host validates params even when the client check is bypassed', async () => {
    // The client-side check is a convenience. This goes around it, the way a
    // stale tab or a hand-written client would, and proves the host still
    // refuses.
    const test = await start();
    const raw = await test.connectRaw();
    const stream = await raw.openStream('demo.ticks', { count: 0 }, { mode: 'read' });
    await expect(
      (async () => {
        for await (const chunk of stream) void chunk;
      })(),
    ).rejects.toThrow();
    expect(emitted).toBe(0);
    await raw.close();
  });

  test('shutdown aborts a running stream', async () => {
    const test = await start();
    const client = await test.connect(contract);
    let received = 0;
    await client.subscribe('demo.ticks', { count: 10_000 }, {
      onEvent: () => {
        received += 1;
      },
      onError: () => undefined,
    });
    await until(() => received >= 2, 5_000, 'the stream to start');

    await test.stop();
    live = null;

    const atStop = emitted;
    await Bun.sleep(200);
    expect(emitted).toBeLessThan(atStop + 20);
    expect(handlerFinished).toBe(false);
  });
});

describe('transport protections', () => {
  test('an unauthenticated request is refused', async () => {
    const test = await start();
    const response = await fetch(`${test.bridge.origin}/`, { redirect: 'manual' });
    expect(response.status).toBe(403);
  });

  test('a foreign Origin is refused even with a valid token', async () => {
    const test = await start();
    const response = await fetch(test.url, {
      headers: { origin: 'http://evil.example' },
      redirect: 'manual',
    });
    expect(response.status).toBe(403);
  });

  test('the launch token is single use', async () => {
    const test = await start();
    const first = await fetch(test.url, { redirect: 'manual' });
    expect(first.status).toBe(303);
    const second = await fetch(test.url, { redirect: 'manual' });
    expect(second.status).toBe(403);
  });

  test('an unrouted path is a 404 even when authenticated', async () => {
    const test = await start();
    const bootstrap = await fetch(test.url, { redirect: 'manual' });
    const cookie = bootstrap.headers.getSetCookie()[0]?.split(';', 1)[0] ?? '';
    // There is no static file route at all, so this cannot be a traversal.
    const response = await fetch(`${test.bridge.origin}/../../etc/passwd`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect([403, 404]).toContain(response.status);
  });

  test('an unregistered route is not callable', async () => {
    const test = await start();
    const raw = await test.connectRaw();
    await expect(raw.call('demo.notARoute')).rejects.toThrow();
    await raw.close();
  });

  test('the bridge binds loopback', async () => {
    const test = await start();
    expect(['127.0.0.1', '::1']).toContain(test.bridge.host);
  });
});

describe('multiple tabs', () => {
  test('two clients each get their own session and their own streams', async () => {
    const test = await start();
    const first = await test.connect(contract);
    const second = await test.connect(contract);

    const [a, b] = await Promise.all([
      first.call('demo.echo', { text: 'one' }),
      second.call('demo.echo', { text: 'two' }),
    ]);
    expect(a).toEqual({ text: 'ONE' });
    expect(b).toEqual({ text: 'TWO' });
    expect(test.bridge.sessions.length).toBeGreaterThanOrEqual(2);

    // Cancelling one tab's stream must not disturb the other's.
    let firstCount = 0;
    let secondCount = 0;
    const firstStream = await first.subscribe('demo.ticks', { count: 10_000 }, {
      onEvent: () => {
        firstCount += 1;
      },
      onError: () => undefined,
    });
    await second.subscribe('demo.ticks', { count: 10_000 }, {
      onEvent: () => {
        secondCount += 1;
      },
      onError: () => undefined,
    });

    await until(() => firstCount > 2 && secondCount > 2, 5_000, 'both streams');
    firstStream.cancel();
    const secondAtCancel = secondCount;
    await Bun.sleep(150);
    expect(secondCount).toBeGreaterThan(secondAtCancel);

    await first.close();
    await second.close();
  });
});

describe('invoke', () => {
  test('runs an operation without a bridge', async () => {
    // The AI layer calls operations this way, so it has to go through the same
    // validation the browser's calls do rather than reaching the handler raw.
    expect(await buildApp().invoke('demo.echo', { text: 'a' })).toEqual({ text: 'A' });
  });

  test('rejects invalid input the same way a browser call would', async () => {
    const failed = buildApp().invoke('demo.echo', { text: '' });
    // `PublicError.toBridgeError` prefixes the code, which is what the browser
    // sees too; an in-host caller must not get a softer error.
    await expect(failed).rejects.toThrow(/invalid_input/);
    await expect(failed).rejects.toThrow(/text/);
  });

  test('an unexpected failure does not leak its message', async () => {
    const failed = buildApp().invoke('demo.boom', undefined);
    await expect(failed).rejects.toThrow();
    try {
      await failed;
    } catch (cause) {
      expect(String(cause instanceof Error ? cause.message : cause)).not.toContain('secret-token');
    }
  });

  test('a stream is not invokable', () => {
    expect(() => buildApp().invoke('demo.ticks' as never, {})).toThrow(TypeError);
  });
});
