/**
 * The three offline tiers, tested rather than asserted.
 *
 * `docs/autoapp/packaging.md` makes three promises about what works without a
 * network. Each one has a case here, and the documentation says "tested in CI
 * on" only for the platforms this file passes on. A guarantee nobody exercised
 * is a guarantee nobody should have written down.
 *
 * What this file cannot do is sever the interface. It proves the two things
 * that are actually under Broapp's control — that a built release resolves
 * nothing at run time, and that a build refuses a dependency that is not
 * installed — and it says plainly, in `docs/autoapp/packaging.md`, that Bun
 * has no flag which guarantees no socket is opened.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

import { ollama } from 'broapp-ai-compatible';
import { aiContract } from 'broapp/ai';
import { createGate } from 'broapp/host';
import type { Gate } from 'broapp/host';
import { mergeContracts } from 'broapp/shared';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import {
  buildCandidate,
  connectToChild,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  type Journal,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout, setCurrent, type Layout } from 'broapp-autoapp/spec';

import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { harness, type Harness } from './harness.ts';

/** The compiled binary every child in this file is started from. */
const launcher = LAUNCHER;
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
const runRoot = join(import.meta.dir, '.autoapp-run');
const quiet = { warn: () => undefined, error: () => undefined };

const failure = await ensureLauncher();
if (failure !== null) console.warn(`[autoapp-offline] skipped: the launcher would not build\n${failure}`);
const available = failure === null;

interface World {
  readonly root: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly store: RunStore;
  readonly gate: Gate;
  readonly directory: string;
}

let world: World | null = null;
let live: Harness | null = null;

afterEach(async () => {
  await live?.stop();
  live = null;
  const current = world;
  world = null;
  if (current === null) return;
  await current.supervisor.stopAll(5_000).catch(() => undefined);
  current.journal.close();
  current.store.close();
  rmSync(current.directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

/** A launcher root with the fixture workspace copied in. */
function makeWorld(): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'offline-'));
  const root = layout(directory);
  const app = root.app('items');
  mkdirSync(app.dir, { recursive: true });
  cpSync(fixture, app.source, { recursive: true });
  const store = createRunStore(join(directory, 'launcher'), quiet);
  const built: World = {
    root,
    directory,
    supervisor: createSupervisor({ execPath: launcher, logger: quiet }),
    journal: openJournal(root.journal),
    store,
    gate: createGate({
      appId: 'launcher',
      releaseId: 'launcher',
      confirmTimeoutMs: 5_000,
      recorder: store.recorder(),
      logger: quiet,
    }),
  };
  world = built;
  return built;
}

/**
 * A `fetch` that fails the way an unplugged machine does.
 *
 * The AI layer takes its `fetch` as an option so a test can decide what the
 * network is; nothing here patches a global, which the common rules forbid.
 */
const noNetwork = Object.assign(() => Promise.reject(new Error('the network is unavailable')), {
  preconnect: () => undefined,
}) as unknown as typeof fetch;

/** Every module specifier a bundle still asks the runtime for. */
function importsOf(bundle: string): string[] {
  const found = new Set<string>();
  for (const match of bundle.matchAll(/(?:^|[\s;}])(?:import|export)[^'"();]*?from\s*["']([^"']+)["']/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  for (const match of bundle.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

describe.skipIf(!available)('run offline', () => {
  test('an installed application answers a read and a write with no network', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    mkdirSync(app.data, { recursive: true });

    const child = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(built.releaseId),
      releaseId: built.releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    const client = await connectToChild(child.url);
    // `items.add` is a `write` on channel `user`, which the policy allows
    // outright — an application's own tab needs nobody's permission.
    expect(await client.call('items.add', { label: 'offline' })).toMatchObject({ label: 'offline' });
    expect(await client.call('items.list', null)).toMatchObject({ count: 1 });
    await client.close();
    await child.shutdown(5_000);
  }, 120_000);

  test('the release serves with its whole source workspace deleted', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    mkdirSync(app.data, { recursive: true });

    // A release is immutable and self-contained: `Bun.build` inlined every
    // dependency into `host.js`, so nothing is resolved from `node_modules` —
    // or from anywhere else — once a child imports it. Deleting the workspace
    // is the strongest form of the check, and it covers the weaker one the
    // prompt asks for, moving `source/node_modules` away.
    rmSync(app.source, { recursive: true, force: true });
    expect(existsSync(app.source)).toBe(false);

    const child = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(built.releaseId),
      releaseId: built.releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    const client = await connectToChild(child.url);
    expect(await client.call('items.add', { label: 'no workspace' })).toMatchObject({
      label: 'no workspace',
    });
    expect(await client.call('items.list', null)).toMatchObject({ count: 1 });
    await client.close();
    await child.shutdown(5_000);
  }, 120_000);

  test('the host bundle asks the runtime for nothing but `bun:` and Node builtins', async () => {
    const where = makeWorld();
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));

    const bundle = readFileSync(join(where.root.app('items').release(built.releaseId), 'host.js'), 'utf8');
    const specifiers = importsOf(bundle);
    // `bun:sqlite` is external by design — it is part of the runtime the child
    // already is. Anything else left unbundled would be a file the release does
    // not carry, which is the whole offline claim.
    const outside = specifiers.filter(
      (name) =>
        !name.startsWith('bun:') &&
        !name.startsWith('node:') &&
        !builtinModules.includes(name),
    );
    expect(outside).toEqual([]);
    expect(specifiers).toContain('bun:sqlite');
  }, 120_000);
});

describe.skipIf(!available)('edit offline', () => {
  test('a source change builds and the release is a new one', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const first = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!first.ok) throw new Error(JSON.stringify(first.problems));

    // Uses only what is already installed, which is the tier's whole claim.
    const views = join(app.source, 'src', 'shared', 'views.ts');
    const source = await Bun.file(views).text();
    writeFileSync(views, source.replace("header: 'Label'", "header: 'Edited offline'"));

    const second = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.releaseId).not.toBe(first.releaseId);
  }, 120_000);

  test('the engineer reports the provider as unavailable when nothing can be reached', async () => {
    const where = makeWorld();
    const tab = createLauncherTab({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      dataDir: join(where.directory, 'launcher'),
      store: where.store,
      // Ollama is the local provider the documented tier names. With a `fetch`
      // that refuses, it stands in for every provider on a machine with no
      // network — a remote one fails at exactly the same place.
      providers: [ollama()],
      fetch: noNetwork,
      confirmTimeoutMs: 2_000,
      logger: quiet,
    });
    live = await harness((bridge) => tab.mount(bridge));

    const client = await live.connect(mergeContracts(launcherContract, aiContract));
    await client.call('ai.settingsUpdate', { provider: 'ollama', modelId: 'a-local-model' });

    // Settings first: this is the sentence a person sees when they press Test.
    // A failed test is the answer to the question rather than a broken route,
    // so it comes back as `ok: false` with the reason.
    const tested = await client.call('ai.connectionTest', undefined);
    expect(tested.ok).toBe(false);
    expect(tested.message).toMatch(/Could not reach/);

    // Then the chat itself, which is where the engineer lives. The turn does
    // not hang and does not pretend: it ends with an error the person can read.
    const events: { type: string; message?: string }[] = [];
    let failed: string | null = null;
    let finished = false;
    await client.subscribe(
      'ai.chat',
      { runId: 'run-offline', message: 'add a field', refs: [], history: [] },
      {
        onEvent: (event) => {
          events.push(event as { type: string; message?: string });
          if (event.type === 'done' || event.type === 'error') finished = true;
        },
        onDone: () => {
          finished = true;
        },
        onError: () => {
          failed = 'unavailable';
          finished = true;
        },
      },
    );
    const deadline = Date.now() + 20_000;
    while (!finished && Date.now() < deadline) await Bun.sleep(20);
    expect(finished).toBe(true);
    expect(failed !== null || events.some((event) => event.type === 'error')).toBe(true);
    await client.close();
  }, 120_000);
});

describe.skipIf(!available)('extend dependencies offline', () => {
  test('a dependency that was never installed is refused, with what to do about it', async () => {
    const where = makeWorld();
    const app = where.root.app('items');

    const path = join(app.source, 'package.json');
    const manifest = JSON.parse(await Bun.file(path).text()) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...manifest.dependencies, 'a-package-nobody-installed': '^1.0.0' };
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const problem = result.problems.find((one) =>
      one.message.includes('a-package-nobody-installed'),
    );
    expect(problem?.stage).toBe('host');
    expect(problem?.message).toContain(
      'dependencies are installed when an application is imported; re-import to add one',
    );
  }, 120_000);
});
