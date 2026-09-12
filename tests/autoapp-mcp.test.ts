/**
 * The MCP adapter: an external agent reaching an application through the gate.
 *
 * The whole path is exercised for real — a compiled launcher, a control socket,
 * a child process, and the application's own gate at the end of it. What is
 * under test is that the last of those is unavoidable: there is one way in, it
 * arrives on channel `mcp`, and a write asks the person in the application's
 * tab or is refused because nobody is there to ask.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createRunStore } from 'broapp-autoapp/host';
import {
  buildCandidate,
  createSupervisor,
  keepServing,
  openJournal,
  startControl,
  type Control,
  type Journal,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { connectControl, createMcpServer, runMcp, toolNameOf } from 'broapp-autoapp/mcp';
import type { ControlClient } from 'broapp-autoapp/mcp';
import { layout, setCurrent, type Layout } from 'broapp-autoapp/spec';
import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';


/** The compiled binary every child in this file is started from. */
const launcher = LAUNCHER;
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
const runRoot = join(import.meta.dir, '.autoapp-run');
const quiet = { warn: () => undefined, error: () => undefined };

const failure = await ensureLauncher();
if (failure !== null) console.warn(`[autoapp-mcp] skipped: the launcher would not build\n${failure}`);
const available = failure === null;

/** Everything one test built. */
interface World {
  readonly root: Layout;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly control: Control;
  readonly releaseId: string;
  readonly directory: string;
}

let world: World | null = null;
let client: ControlClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  const current = world;
  world = null;
  if (current === null) return;
  current.control.stop();
  await current.supervisor.stopAll(5_000).catch(() => undefined);
  current.journal.close();
  rmSync(current.directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) {
    rmSync(runRoot, { recursive: true, force: true });
  }
  // Longer than the drain deadline above: a child still holding an unanswered
  // approval is busy until the gate's own timeout, so that deadline is spent in
  // full rather than returning early.
}, 30_000);

/** A launcher with the fixture built, current, and (optionally) running. */
async function makeWorld(options: { start?: boolean } = {}): Promise<World> {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'mcp-'));
  const root = layout(directory);
  const app = root.app('items');
  mkdirSync(app.dir, { recursive: true });
  Bun.spawnSync({ cmd: ['cp', '-R', fixture, app.source] });

  const built = await buildCandidate({ layout: root, appId: 'items' });
  if (!built.ok) throw new Error(JSON.stringify(built.problems));
  setCurrent(root, 'items', built.releaseId);
  mkdirSync(app.data, { recursive: true });

  const journal = openJournal(root.journal);
  const supervisor = createSupervisor({ execPath: launcher, logger: quiet });
  const control = startControl({ layout: root, supervisor, logger: quiet, invokeTimeoutMs: 8_000 });

  if (options.start !== false) {
    await supervisor.start({
      appId: 'items',
      releaseDir: app.release(built.releaseId),
      releaseId: built.releaseId,
      dataDir: app.data,
      mode: 'live',
    });
  }

  const made: World = { root, journal, supervisor, control, releaseId: built.releaseId, directory };
  world = made;
  return made;
}

/** One raw line-protocol connection, for the tests about the protocol itself. */
async function rawConnect(port: number): Promise<{
  send(line: unknown): void;
  next(ms?: number): Promise<Record<string, unknown> | 'closed'>;
  close(): void;
}> {
  const lines: Record<string, unknown>[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const socket = await Bun.connect<undefined>({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, chunk) {
        for (const line of new TextDecoder().decode(chunk).split('\n')) {
          if (line.trim() === '') continue;
          lines.push(JSON.parse(line) as Record<string, unknown>);
        }
        wake?.();
      },
      close() {
        closed = true;
        wake?.();
      },
    },
  });
  return {
    send: (line) => void socket.write(`${JSON.stringify(line)}\n`),
    async next(ms = 3_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const first = lines.shift();
        if (first !== undefined) return first;
        if (closed) return 'closed';
        if (Date.now() > deadline) throw new Error('nothing arrived');
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 25).unref?.();
        });
      }
    },
    close: () => socket.end(),
  };
}

/** Attach a raw Brobridge client to the running child, the way a browser does. */
async function attachTab(where: World): Promise<unknown> {
  const child = where.supervisor.children[0];
  if (child === undefined) throw new Error('nothing running');
  const { connectToChild } = await import('broapp-autoapp/launcher');
  // A raw Brobridge client is what makes `running.attached` true, which is
  // what `attachedOnly` asks about.
  return await connectToChild(child.url);
}

/** Poll a tab's `approvalsList` until something is waiting. */
async function waitForPending(tab: {
  call(route: 'autoapp.approvalsList', input: undefined): Promise<{
    pending: readonly { requestId: string; route: string; channel: string; caller: string; releaseId: string; argumentsHash: string }[];
  }>;
}): Promise<{ requestId: string; route: string; channel: string; caller: string; releaseId: string; argumentsHash: string }> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { pending } = await tab.call('autoapp.approvalsList', undefined);
    const first = pending[0];
    if (first !== undefined) return first;
    await Bun.sleep(20);
  }
  throw new Error('nothing ever asked for approval');
}

describe.skipIf(!available)('the control connection', () => {
  test('listens on loopback and writes a file only this user can read', async () => {
    const where = await makeWorld({ start: false });
    expect(where.control.hostname).toBe('127.0.0.1');
    expect(where.control.port).toBeGreaterThan(0);
    expect(existsSync(where.root.control)).toBe(true);

    if (process.platform === 'win32') {
      console.warn('[autoapp-mcp] file mode is not asserted on Windows');
    } else {
      // The secret's whole job is to be unreadable by anybody else.
      expect(statSync(where.root.control).mode & 0o777).toBe(0o600);
    }
    const file = JSON.parse(await Bun.file(where.root.control).text()) as { secret: string };
    expect(file.secret).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  test('closes a connection that does not authenticate correctly', async () => {
    const where = await makeWorld({ start: false });

    // Something that is not an auth line at all.
    const first = await rawConnect(where.control.port);
    first.send({ v: 1, type: 'describe', appId: 'items' });
    expect(await first.next()).toBe('closed');

    // The right shape with the wrong secret.
    const second = await rawConnect(where.control.port);
    second.send({ v: 1, type: 'auth', secret: 'f'.repeat(64) });
    expect(await second.next()).toBe('closed');

    // And the right one is answered.
    const third = await rawConnect(where.control.port);
    third.send({ v: 1, type: 'auth', secret: where.control.secret });
    expect(await third.next()).toMatchObject({ type: 'auth', ok: true });
    third.close();
  }, 60_000);

  test('describe reads the release without starting anything', async () => {
    const where = await makeWorld({ start: false });
    client = await connectControl(where.root.control);
    const described = await client.describe('items');

    expect(described.releaseId).toBe(where.releaseId);
    expect(described.name).toBe('Items');
    expect(Object.keys(described.contract.operations).sort()).toEqual([
      'items.add',
      'items.list',
      'items.ping',
    ]);
    // Nothing was started to answer it.
    expect(where.supervisor.children).toHaveLength(0);
  }, 60_000);
});

describe.skipIf(!available)('forwarded calls', () => {
  test('a read runs with no tab attached', async () => {
    const where = await makeWorld();
    client = await connectControl(where.root.control);
    const result = await client.invoke({
      appId: 'items',
      route: 'items.list',
      input: null,
      client: 'test-client',
    });
    expect(result).toMatchObject({ ok: true, output: { count: 0 } });
  }, 60_000);

  test('a write with no tab attached is refused, and recorded as denied', async () => {
    const where = await makeWorld();
    client = await connectControl(where.root.control);
    const result = await client.invoke({
      appId: 'items',
      route: 'items.add',
      input: { label: 'from an agent' },
      client: 'test-client',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('rejected');
    // The agent on the other end has to be able to tell "somebody declined"
    // from "nobody was there", or it will keep trying.
    expect(result.message).toContain('no browser tab is open');

    // The child recorded the refusal against the channel it arrived on.
    const store = createRunStore(where.root.app('items').data, quiet);
    try {
      const runs = store.listRuns({ channels: ['mcp'] });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.caller).toBe('mcp:test-client');
      const detail = store.getRun(runs[0]?.id ?? '');
      expect(detail?.steps[0]).toMatchObject({ route: 'items.add', decision: 'denied' });
    } finally {
      store.close();
    }
  }, 60_000);

  test('a child killed mid-call is unavailable, not a hung reply', async () => {
    const where = await makeWorld();
    const tab = (await attachTab(where)) as { close(): Promise<void> };
    client = await connectControl(where.root.control);

    // A write, so the call is still in the child waiting on the tab when the
    // child dies. The reply has to come from the launcher noticing the exit
    // rather than from the forwarding deadline several seconds later.
    const running = client.invoke({
      appId: 'items',
      route: 'items.add',
      input: { label: 'interrupted' },
      client: 'test-client',
    });
    const child = where.supervisor.children[0];
    if (child === undefined) throw new Error('nothing running');
    await Bun.sleep(300);
    const started = Date.now();
    process.kill(child.pid, 'SIGKILL');

    expect(await running).toMatchObject({ ok: false, code: 'unavailable' });
    // Comfortably inside the 8 s forwarding deadline this world is built with.
    expect(Date.now() - started).toBeLessThan(4_000);
    await tab.close().catch(() => undefined);
  }, 60_000);

  test('serve starts a crashed child again, and gives up on a crash loop', async () => {
    const where = await makeWorld({ start: false });
    const starts: string[] = [];
    const serving = keepServing({
      layout: where.root,
      supervisor: where.supervisor,
      appId: 'items',
      logger: quiet,
      maxRestarts: 2,
      onStart: (child) => {
        starts.push(child.url);
        // Killed as soon as it is up, so this is a crash loop by construction.
        process.kill(child.pid, 'SIGKILL');
      },
    });

    const code = await serving;
    expect(code).not.toBe(0);
    // The first start plus two restarts, and then it is left stopped.
    expect(starts).toHaveLength(3);
    expect(new Set(starts).size).toBe(3);
  }, 120_000);

  test('an unknown application is unavailable rather than a crash', async () => {
    const where = await makeWorld({ start: false });
    client = await connectControl(where.root.control);
    const result = await client.invoke({
      appId: 'items',
      route: 'items.list',
      input: null,
      client: 'test-client',
    });
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
  }, 60_000);
});

describe.skipIf(!available)('approving from the application’s tab', () => {

  /** A raw Brobridge connection standing in for the application's own tab. */
  interface Tab {
    call(route: string, input?: unknown): Promise<unknown>;
    close(): Promise<void>;
  }

  test('a write asks in the tab, and runs when approved', async () => {
    const where = await makeWorld();
    const tab = (await attachTab(where)) as Tab;
    client = await connectControl(where.root.control);

    const running = client.invoke({
      appId: 'items',
      route: 'items.add',
      input: { label: 'approved' },
      client: 'test-client',
    });
    const question = await waitForPending(tab as never);
    expect(question.route).toBe('items.add');
    expect(question.channel).toBe('mcp');
    expect(question.caller).toBe('mcp:test-client');

    expect(
      await tab.call('autoapp.approvalsAnswer', {
        requestId: question.requestId,
        approved: true,
        releaseId: question.releaseId,
        argumentsHash: question.argumentsHash,
      }),
    ).toMatchObject({ result: 'accepted' });

    const result = await running;
    expect(result).toMatchObject({ ok: true, output: { label: 'approved' } });

    const listed = await client.invoke({
      appId: 'items',
      route: 'items.list',
      input: null,
      client: 'test-client',
    });
    expect(listed).toMatchObject({ ok: true, output: { count: 1 } });
    await tab.close();
  }, 60_000);

  test('an answer about different arguments is a mismatch, and the call is refused', async () => {
    const where = await makeWorld();
    const tab = (await attachTab(where)) as Tab;
    client = await connectControl(where.root.control);

    const running = client.invoke({
      appId: 'items',
      route: 'items.add',
      input: { label: 'never' },
      client: 'test-client',
    });
    const question = await waitForPending(tab as never);
    expect(
      await tab.call('autoapp.approvalsAnswer', {
        requestId: question.requestId,
        approved: true,
        releaseId: question.releaseId,
        argumentsHash: '0'.repeat(32),
      }),
    ).toMatchObject({ result: 'mismatch' });

    expect(await running).toMatchObject({ ok: false, code: 'rejected' });
    expect(
      await client.invoke({ appId: 'items', route: 'items.list', input: null, client: 'test-client' }),
    ).toMatchObject({ ok: true, output: { count: 0 } });
    await tab.close();
  }, 60_000);

  test('nobody answering is a refusal, not a hung call', async () => {
    const where = await makeWorld();
    const tab = (await attachTab(where)) as Tab;
    client = await connectControl(where.root.control);

    // The gate's own `confirmTimeoutMs` in a child is the default two minutes,
    // so this waits on the launcher's shorter forwarding deadline instead.
    const started = Date.now();
    const result = await client.invoke({
      appId: 'items',
      route: 'items.add',
      input: { label: 'unanswered' },
      client: 'test-client',
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(30_000);
    await tab.close();
  }, 60_000);
});

describe.skipIf(!available)('the stdio server', () => {
  /** A control client that answers from a fixed contract, for the SDK tests. */
  function fakeControl(calls: { route: string; client: string }[]): ControlClient {
    return {
      describe: () =>
        Promise.resolve({
          releaseId: 'a'.repeat(32),
          name: 'Items',
          contract: {
            operations: {
              'items.list': {
                effect: 'read' as const,
                summary: 'Every item.',
                input: { type: 'object', properties: {} },
                output: { type: 'object', properties: {} },
              },
              'items.add': {
                effect: 'write' as const,
                summary: 'Add one item.',
                input: { type: 'object', properties: { label: { type: 'string' } } },
                output: { type: 'object', properties: {} },
              },
              'items.ping': {
                effect: 'external' as const,
                summary: 'Reach outside.',
                input: { type: 'object', properties: {} },
                output: { type: 'object', properties: {} },
              },
            },
            streams: {},
          },
        }),
      // Nothing here asks; the MCP server never needs to know whether a
      // launcher is serving, which is a question the `remove` command asks.
      serving: () => Promise.resolve(true),
      invoke: ({ route, client: name }) => {
        calls.push({ route, client: name });
        return Promise.resolve({ ok: true as const, output: { route } });
      },
      close: () => undefined,
    };
  }

  test('offers read and write tools with the right hints, and never external ones', async () => {
    const calls: { route: string; client: string }[] = [];
    const built = await createMcpServer({
      appId: 'items',
      controlPath: '/does/not/matter',
      control: fakeControl(calls),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await Promise.all([built.server.connect(serverSide), agent.connect(clientSide)]);

    const listed = await agent.listTools();
    const names = listed.tools.map((tool: { name: string }) => tool.name);
    expect([...names].sort()).toEqual(['items_add', 'items_list']);
    // `items.ping` is `external` and is not offered at all.
    expect(names.some((name: string) => name.includes('ping'))).toBe(false);

    const read = listed.tools.find((tool: { name: string }) => tool.name === 'items_list');
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(read?.annotations?.destructiveHint).toBe(false);
    const write = listed.tools.find((tool: { name: string }) => tool.name === 'items_add');
    expect(write?.annotations?.readOnlyHint).toBe(false);
    expect(write?.annotations?.destructiveHint).toBe(true);

    // A call round-trips, carrying the client's own name from the handshake.
    const result = await agent.callTool({ name: 'items_add', arguments: { label: 'x' } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ route: 'items.add', client: 'test-agent' }]);

    await agent.close();
  }, 60_000);

  test('a refusal is a tool result the agent can read, not a transport failure', async () => {
    const control: ControlClient = {
      ...fakeControl([]),
      invoke: () =>
        Promise.resolve({
          ok: false as const,
          code: 'rejected',
          message: 'no browser tab is attached to answer',
        }),
    };
    const built = await createMcpServer({ appId: 'items', controlPath: '/x', control });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await Promise.all([built.server.connect(serverSide), agent.connect(clientSide)]);

    const result = await agent.callTool({ name: 'items_add', arguments: { label: 'x' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no browser tab');
    await agent.close();
  }, 60_000);

  test('a tool name is the route with its dot replaced', () => {
    expect(toolNameOf('items.list')).toBe('items_list');
    expect(toolNameOf('notes.create')).toBe('notes_create');
  });

  test('with no launcher running, it says so and exits 1', async () => {
    const written: string[] = [];
    // This case builds no world, so nothing else has created the run root. On a
    // machine that has never run these tests — every CI runner — `mkdtempSync`
    // would fail on the missing parent rather than on anything being tested.
    mkdirSync(runRoot, { recursive: true });
    const code = await runMcp({
      appId: 'items',
      controlPath: join(mkdtempSync(join(runRoot, 'empty-')), 'launcher.json'),
      stderr: { write: (text) => void written.push(text) },
    });
    expect(code).toBe(1);
    expect(written.join('')).toContain('the launcher is not running');
    expect(written.join('')).toContain('broapp-autoapp serve');
  }, 60_000);
});

describe('the one way in', () => {
  test('only the child runtime ever sets channel mcp', async () => {
    const grep = Bun.spawnSync({
      cmd: ['grep', '-rn', "channel: 'mcp'", 'packages/broapp-autoapp/src', 'packages/broapp/src'],
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const lines = new TextDecoder()
      .decode(grep.stdout)
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('child/run-child.ts');
  });
});
