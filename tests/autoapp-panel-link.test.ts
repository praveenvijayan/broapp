/**
 * A way back to the panel.
 *
 * Three things are under test. An application the launcher serves can send a
 * person to the panel on a fresh single-use address, and only from a person's
 * own click; `broapp-autoapp open` against a running launcher joins it instead
 * of starting a second one; and applications that were serving are started
 * again when the launcher is.
 *
 * The panel's address is never handed to the application's page. The launcher
 * mints it and gives it to the operating system's browser opener, because a
 * page on the application's port navigating to the panel's port arrives
 * `Sec-Fetch-Site: same-site` and the panel's bridge refuses it. So the
 * in-process cases stub the opener to catch the address, and the compiled
 * launcher runs with `AUTOAPP_TEST_NO_BROWSER=1`, which sends every address to
 * its terminal instead.
 *
 * The run root is under `tests/.autoapp-run/` for the reason
 * `tests/autoapp-remove.test.ts` gives: the fixture resolves `broapp` by
 * walking up into this repository's `node_modules`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Bridge as ClientBridge } from '@brobridgejs/client';
import { createGate } from 'broapp/host';
import type { ExecutionRecord, Gate } from 'broapp/host';
import { fromTransportError } from 'broapp/shared';
import { panelContract } from 'broapp-autoapp/shared';
import { createCandidateStates } from 'broapp-autoapp/engineer';
import {
  addServing,
  buildCandidate,
  connectToChild,
  createLauncherApp,
  createSupervisor,
  launcherContract,
  NO_PANEL_REASON,
  openJournal,
  readServing,
  removeApplication,
  servingPath,
  type ChildHandle,
  type Journal,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { connectControl } from 'broapp-autoapp/mcp';
import { layout, setCurrent, writeGrants, type Layout } from 'broapp-autoapp/spec';

import { createPanelRoute } from '../packages/broapp-autoapp/src/child/panel.ts';
import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { harness, type Harness } from './harness.ts';

const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');

const failure = await ensureLauncher();
if (failure !== null) {
  console.warn(`[autoapp-panel-link] skipped: the launcher would not build\n${failure}`);
}
const available = failure === null;

const quiet = { warn: () => undefined, error: () => undefined };
const runRoot = join(import.meta.dir, '.autoapp-run');

interface World {
  readonly root: Layout;
  readonly directory: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
}

let world: World | null = null;
const tabs: Harness[] = [];
const clients: ClientBridge[] = [];
const launchers: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const tab of tabs.splice(0)) await tab.stop();
  for (const launcher of launchers.splice(0)) {
    launcher.kill('SIGTERM');
    await launcher.exited;
  }
  const current = world;
  world = null;
  if (current === null) return;
  await current.supervisor.stopAll(5_000).catch(() => undefined);
  current.journal.close();
  rmSync(current.directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

/** A launcher root with the fixture in one application's workspace. */
function makeWorld(options: Parameters<typeof createSupervisor>[0] = {}): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'panel-'));
  const root = layout(join(directory, 'autoapp'));
  const app = root.app('items');
  mkdirSync(app.dir, { recursive: true });
  cpSync(fixture, app.source, { recursive: true });
  const built: World = {
    root,
    directory,
    journal: openJournal(root.journal),
    supervisor: createSupervisor({ execPath: LAUNCHER, logger: quiet, ...options }),
  };
  world = built;
  return built;
}

/** Build the fixture and make it current, as an import would. */
async function build(where: World): Promise<string> {
  const result = await buildCandidate({ layout: where.root, appId: 'items' });
  if (!result.ok) throw new Error(result.problems.map((one) => `${one.stage}: ${one.message}`).join('; '));
  setCurrent(where.root, 'items', result.releaseId);
  writeGrants(where.root, 'items', { appId: 'items', releaseId: result.releaseId, grantedAt: Date.now(), capabilities: [] });
  return result.releaseId;
}

/** Start the application's child. */
async function serveItems(where: World, releaseId: string): Promise<ChildHandle> {
  const app = where.root.app('items');
  return await where.supervisor.start({
    appId: 'items',
    releaseDir: app.release(releaseId),
    releaseId,
    dataDir: app.data,
    mode: 'live',
  });
}

/** A browser-shaped connection to a child, closed after the test. */
async function tabOn(url: string): Promise<ClientBridge> {
  const client = await connectToChild(url);
  clients.push(client);
  return client;
}

/** A stand-in for the launcher's own tab: a bridge whose addresses the panel mints. */
async function panelTab(): Promise<Harness> {
  const tab = await harness(() => undefined);
  tabs.push(tab);
  return tab;
}

/** Load an address the way a browser's first request does; 303 means it redeemed. */
async function load(url: string): Promise<{ status: number; cookie: boolean }> {
  const response = await fetch(url, { redirect: 'manual' });
  return { status: response.status, cookie: response.headers.getSetCookie().length > 0 };
}

/** Run the compiled launcher once over a root. */
async function command(where: World, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const running = Bun.spawn({
    cmd: [LAUNCHER, ...args],
    env: { ...process.env, BROAPP_DATA_DIR: where.directory, NODE_ENV: 'test', AUTOAPP_TEST_NO_BROWSER: '1', AUTOAPP_TEST_NO_NETWORK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    running.exited,
    new Response(running.stdout as ReadableStream<Uint8Array>).text(),
    new Response(running.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  return { code, stdout, stderr };
}

/** Start the compiled launcher's panel in the background; resolves with what it has printed so far. */
async function startLauncher(where: World, args: readonly string[] = []): Promise<{ output: () => string }> {
  rmSync(where.root.control, { force: true });
  const running = Bun.spawn({
    cmd: [LAUNCHER, 'open', '--no-open', ...args],
    env: { ...process.env, BROAPP_DATA_DIR: where.directory, NODE_ENV: 'test', AUTOAPP_TEST_NO_BROWSER: '1', AUTOAPP_TEST_NO_NETWORK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  launchers.push(running);
  let text = '';
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  };
  void drain(running.stdout as ReadableStream<Uint8Array>);
  void drain(running.stderr as ReadableStream<Uint8Array>);
  // The tab's address is printed after the control file is written, and it is
  // the last thing a launcher does before it is ready to be asked anything.
  await until(() => text.includes('Open this address if your browser does not:'), 60_000);
  return { output: () => text };
}

/** Wait for a condition, or fail with the time it took. */
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(ms)}ms`);
    await Bun.sleep(50);
  }
}

/** The first loopback address with a launch token in some text. */
function addressIn(text: string, after: string): string {
  const at = text.lastIndexOf(after);
  const match = /http:\/\/127\.0\.0\.1:\d+\/\?bt=[A-Za-z0-9_-]+/.exec(at < 0 ? '' : text.slice(at));
  if (match === null) throw new Error(`no address after ${JSON.stringify(after)} in:\n${text}`);
  return match[0];
}

describe.skipIf(!available)('the mark’s route', () => {
  test('a served child probes, then opens the panel on a fresh single-use address', async () => {
    const tab = await panelTab();
    const issued: string[] = [];
    const where = makeWorld({
      panel: () => ({
        available: true,
        open: () => {
          issued.push(tab.app.launchUrl());
          return Promise.resolve({ opened: true });
        },
      }),
    });
    const child = await serveItems(where, await build(where));
    const client = await tabOn(child.url);

    expect((await client.call('autoapp.panel', { mint: false })) as unknown).toEqual({ available: true, opened: null });
    expect(issued).toEqual([]);

    expect((await client.call('autoapp.panel', { mint: true })) as unknown).toEqual({ available: true, opened: true });
    expect(issued).toHaveLength(1);
    const url = issued[0] as string;
    expect(new URL(url).origin).toBe(tab.bridge.origin);
    expect(url).not.toBe(tab.url);

    expect(await load(url)).toEqual({ status: 303, cookie: true });
    expect((await load(url)).status).toBe(403);
    // The application's own routes still answer beside it.
    expect(await client.call('items.list', undefined)).toBeDefined();
  }, 180_000);

  test('two clicks give two addresses, each usable once', async () => {
    const tab = await panelTab();
    const issued: string[] = [];
    const where = makeWorld({
      panel: () => ({
        available: true,
        open: () => {
          issued.push(tab.app.launchUrl());
          return Promise.resolve({ opened: true });
        },
      }),
    });
    const child = await serveItems(where, await build(where));
    const client = await tabOn(child.url);

    await client.call('autoapp.panel', { mint: true });
    await client.call('autoapp.panel', { mint: true });
    const [first, second] = issued as [string, string];
    expect(first).not.toBe(second);
    expect((await load(second)).status).toBe(303);
    expect((await load(first)).status).toBe(303);
    expect((await load(first)).status).toBe(403);
    expect((await load(second)).status).toBe(403);
  }, 180_000);

  test('a supervisor with no panel hides the mark and says how to get one', async () => {
    const where = makeWorld();
    const child = await serveItems(where, await build(where));
    const client = await tabOn(child.url);

    expect((await client.call('autoapp.panel', { mint: false })) as unknown).toEqual({ available: false, opened: null });
    let refusal: unknown = null;
    await client.call('autoapp.panel', { mint: true }).catch((cause: unknown) => {
      refusal = cause;
    });
    expect(String((refusal as Error | null)?.message)).toContain(NO_PANEL_REASON);
  }, 180_000);

  test('refuses every channel but user, and the gate writes that down', async () => {
    const records: ExecutionRecord[] = [];
    const gate: Gate = createGate({
      appId: 'items',
      releaseId: 'r',
      mode: 'live',
      recorder: { record: (record) => records.push(record) },
      logger: quiet,
    });
    let asked = 0;
    const route = createPanelRoute({
      gate,
      logger: quiet,
      ask: (message) => {
        asked += 1;
        return Promise.resolve({ v: 1, id: 'a', re: message.id, type: 'answer', ok: true, available: true, opened: true });
      },
    });

    for (const channel of ['ai', 'mcp', 'workflow'] as const) {
      let refusal: unknown = null;
      await route
        .invoke('autoapp.panel', { mint: true }, { requestId: `r-${channel}`, channel, caller: `${channel}:test` })
        .catch((cause: unknown) => {
          refusal = cause;
        });
      expect(fromTransportError(refusal).code).toBe('rejected');
    }
    expect(asked).toBe(0);
    expect(records.map((record) => [record.channel, record.outcome])).toEqual([
      ['ai', 'failed'],
      ['mcp', 'failed'],
      ['workflow', 'failed'],
    ]);
    expect(records.every((record) => record.route === 'autoapp.panel')).toBe(true);

    // The person's own click is answered.
    expect(await route.invoke('autoapp.panel', { mint: true }, { requestId: 'r-user', channel: 'user', caller: 'tab' })).toEqual({
      available: true,
      opened: true,
    });
    expect(asked).toBe(1);
    expect(Object.keys(panelContract.operations)).toEqual(['autoapp.panel']);
  });
});

describe.skipIf(!available)('open against a running launcher', () => {
  test('prints a fresh panel address and starts nothing; a second ask within two seconds is refused', async () => {
    const where = makeWorld();
    await startLauncher(where);
    const before = JSON.parse(readFileSync(where.root.control, 'utf8')) as { pid: number; port: number };

    const joined = await command(where, ['open', '--no-open']);
    expect(joined.code).toBe(0);
    const url = addressIn(joined.stdout, 'Open the panel at this address:');
    const after = JSON.parse(readFileSync(where.root.control, 'utf8')) as { pid: number; port: number };
    expect(after).toEqual(before);

    expect(await load(url)).toEqual({ status: 303, cookie: true });
    expect((await load(url)).status).toBe(403);

    const again = await command(where, ['open', '--no-open']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('unavailable');
    expect(JSON.parse(readFileSync(where.root.control, 'utf8'))).toEqual(before);
  }, 180_000);
});

describe.skipIf(!available)('restart survival', () => {
  test('opening adds an application, stopping and removing take it out', async () => {
    const where = makeWorld();
    await build(where);
    const states = createCandidateStates(where.root, quiet);
    const opened: string[] = [];
    const launcher = createLauncherApp({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      states,
      gate: createGate({ appId: 'launcher', releaseId: 'launcher', logger: quiet }),
      logger: quiet,
      openBrowser: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
    });
    const tab = await harness((bridge) => launcher.mount(bridge));
    tabs.push(tab);
    const client = await tab.connect(launcherContract);

    expect(readServing(where.root)).toEqual([]);
    await client.call('launcher.appOpen', { appId: 'items' });
    expect(readServing(where.root)).toEqual(['items']);
    expect(JSON.parse(readFileSync(servingPath(where.root), 'utf8'))).toEqual({ v: 1, apps: ['items'] });

    await client.call('launcher.appStop', { appId: 'items' });
    expect(readServing(where.root)).toEqual([]);

    await client.call('launcher.appOpen', { appId: 'items' });
    await client.call('launcher.appStop', { appId: 'items' });
    addServing(where.root, 'items');
    await removeApplication({ layout: where.root, supervisor: where.supervisor, states, journal: where.journal, logger: quiet }, 'items');
    expect(readServing(where.root)).toEqual([]);
    await client.close();
  }, 180_000);

  test('a launcher started over a listed application serves it again, unless --no-restore', async () => {
    const where = makeWorld();
    await build(where);
    // One activated application, and one id nothing answers to.
    mkdirSync(join(where.directory, 'autoapp', 'launcher'), { recursive: true });
    writeFileSync(servingPath(where.root), `${JSON.stringify({ v: 1, apps: ['items', 'ghost'] })}\n`);

    const restored = await startLauncher(where);
    expect(restored.output()).toContain('restored: items');
    expect(restored.output()).toContain('ghost was serving when the launcher stopped and has no current release');
    // The ghost is dropped; the application stays listed.
    expect(readServing(where.root)).toEqual(['items']);
    // A child exists for it: the launcher says so over its control connection.
    const control = await connectControl(where.root.control);
    expect(await control.serving('items')).toBe(true);
    control.close();
    // Nothing was opened: the only addresses printed are the tab's own.
    expect(restored.output()).not.toContain('Could not open a browser');

    // Stopped the way a person stops it, from the terminal.
    const first = launchers.pop();
    first?.kill('SIGTERM');
    await first?.exited;
    // Stopping the launcher does not clear the file.
    expect(readServing(where.root)).toEqual(['items']);

    await startLauncher(where, ['--no-restore']);
    const again = await connectControl(where.root.control);
    expect(await again.serving('items')).toBe(false);
    again.close();
    expect(readServing(where.root)).toEqual(['items']);
  }, 240_000);
});
