/**
 * A real bridge, in-process, for integration tests.
 *
 * These tests connect the actual `@brobridgejs/client` to an actual
 * `createBridge`, over an actual loopback socket. Nothing about the transport,
 * the trust fence or the authentication is stubbed — that is the point. What
 * has to be supplied is the part a browser gives for free and a test process
 * does not: a cookie jar, and a way to put a `Cookie` header on a WebSocket
 * upgrade. `connect()` takes both as options for exactly this reason.
 */
import { WebSocket as NodeWebSocket } from 'ws';

import type { Bridge as ClientBridge, ConnectOptions, FetchLike } from '@brobridgejs/client';
import { connect } from '@brobridgejs/client';
import type { Bridge as HostBridge } from 'brobridge';

import { createClient } from 'broapp/client';
import type { BroappClient } from 'broapp/client';
import type { AnyContract } from 'broapp/shared';
import { startApp } from 'broapp/host';
import type { RunningApp, StartAppOptions } from 'broapp/host';

/** A test bridge plus the pieces needed to talk to it. */
export interface Harness {
  readonly app: RunningApp;
  readonly bridge: HostBridge;
  /** The launch URL, token included. */
  readonly url: string;
  /** Connect a Brobridge client, carrying cookies like a browser would. */
  connectRaw(options?: ConnectOptions): Promise<ClientBridge>;
  /** Connect a contract-typed Broapp client. */
  connect<C extends AnyContract>(contract: C): Promise<BroappClient<C>>;
  /** Stop everything. */
  stop(): Promise<void>;
}

/** A minimal cookie jar: one origin, whatever the host set. */
function jar(): { fetch: FetchLike; header: () => string | undefined } {
  const cookies = new Map<string, string>();
  const wrapped: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    const header = cookieHeader();
    if (header !== undefined) headers.set('cookie', header);
    // `redirect: "manual"` matters: the bootstrap answers 303 and sets the
    // session cookie on *that* response. Following it automatically would
    // work too, but this way the test can assert on the 303 itself.
    const response = await fetch(input as RequestInfo, { ...init, headers, redirect: 'manual' });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  };
  function cookieHeader(): string | undefined {
    if (cookies.size === 0) return undefined;
    return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  return { fetch: wrapped, header: cookieHeader };
}

/** Start a bridge running `register`, with no browser launch and no idle exit. */
export async function harness(
  register: StartAppOptions['register'],
  overrides: Partial<StartAppOptions> = {},
): Promise<Harness> {
  const cookies = jar();

  const app = await startApp({
    page: '<!doctype html><title>test</title>',
    appName: 'broapp-test',
    version: '0.0.0-test',
    // `background` so the poll loop never decides the test has no browser and
    // shuts the host down mid-assertion.
    mode: 'background',
    openBrowser: false,
    register,
    stdout: { log: () => undefined },
    ...overrides,
  });

  const connectRaw = (options: ConnectOptions = {}): Promise<ClientBridge> =>
    connect(app.bridge.url, {
      reconnect: false,
      ...options,
      fetch: cookies.fetch,
      socket: (url) =>
        new NodeWebSocket(url, {
          headers: {
            cookie: cookies.header() ?? '',
            origin: app.bridge.origin,
          },
        }) as unknown as ReturnType<NonNullable<ConnectOptions['socket']>>,
    });

  return {
    app,
    bridge: app.bridge,
    url: app.bridge.url,
    connectRaw,
    connect: <C extends AnyContract>(contract: C) =>
      createClient(contract, {
        url: app.bridge.url,
        reconnect: false,
        fetch: cookies.fetch,
        socket: (url) =>
          new NodeWebSocket(url, {
            headers: { cookie: cookies.header() ?? '', origin: app.bridge.origin },
          }) as unknown as ReturnType<NonNullable<ConnectOptions['socket']>>,
      }),
    stop: () => app.stop(),
  };
}

/** Wait until `predicate` holds, or fail after `timeoutMs`. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}
