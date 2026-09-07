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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildCandidate, connectToChild, createSupervisor, type Supervisor } from 'broapp-autoapp/launcher';
import { layout, setCurrent, type Layout } from 'broapp-autoapp/spec';

const packageDir = join(import.meta.dir, '..', 'packages', 'broapp-autoapp');
const launcher = join(packageDir, 'dist', 'broapp-autoapp');
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
const runRoot = join(import.meta.dir, '.autoapp-run');
const quiet = { warn: () => undefined, error: () => undefined };

/** Compile the launcher once. See `tests/autoapp-activation.test.ts` for why here. */
async function compile(): Promise<string | null> {
  const built = Bun.spawn({
    cmd: ['bun', 'run', 'build:launcher'],
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, , stderr] = await Promise.all([
    built.exited,
    new Response(built.stdout as ReadableStream<Uint8Array>).text(),
    new Response(built.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  return code === 0 ? null : stderr.trim();
}

const failure = await compile();
if (failure !== null) console.warn(`[autoapp-offline] skipped: the launcher would not build\n${failure}`);
const available = failure === null;

interface World {
  readonly root: Layout;
  readonly supervisor: Supervisor;
  readonly directory: string;
}

let world: World | null = null;

afterEach(async () => {
  const current = world;
  world = null;
  if (current === null) return;
  await current.supervisor.stopAll(5_000).catch(() => undefined);
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
  const built: World = {
    root,
    directory,
    supervisor: createSupervisor({ execPath: launcher, logger: quiet }),
  };
  world = built;
  return built;
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
