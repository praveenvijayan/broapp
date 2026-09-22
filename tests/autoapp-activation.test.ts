/**
 * Candidate releases, supervision, snapshots and activation.
 *
 * Everything that starts a child here starts the *compiled* launcher, because
 * that is what will do it on somebody's machine. The property under test
 * throughout is the one that matters when an update goes wrong: whatever
 * happens, the person still has their data and an application that runs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

import {
  activate,
  buildCandidate,
  connectToChild,
  createSupervisor,
  keepServing,
  openJournal,
  recover,
  snapshotDirectory,
  type Journal,
  type Phase,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { runAcceptance } from 'broapp-autoapp/engineer';
import { fromTransportError } from 'broapp/shared';
import {
  layout,
  listReleases,
  readCurrent,
  readRelease,
  releaseId as computeReleaseId,
  setCurrent,
  writeGrants,
  writeRelease,
  type AcceptanceExample,
  type Layout,
} from 'broapp-autoapp/spec';
import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';

/** The compiled binary every child in this file is started from. */
const launcher = LAUNCHER;
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');

// Compiled at module load, not in `beforeAll`: `describe.skipIf` is evaluated
// when the tests are *registered*, which is before any hook has run. Deciding
// there would skip the whole file every time, silently — which is the one thing
// a skip must never do.
const failure = await ensureLauncher();
if (failure !== null) {
  console.warn(`[autoapp-activation] skipped: bun build --compile is unavailable\n${failure}`);
}
const available = failure === null;

/** Everything one test built, so `afterEach` can take it all down. */
interface World {
  readonly root: Layout;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly directory: string;
}

let world: World | null = null;

afterEach(async () => {
  const current = world;
  world = null;
  if (current === null) return;
  // Children first: a directory removed under a running child produces noise
  // that has nothing to do with what was under test.
  await current.supervisor.stopAll(5_000).catch(() => undefined);
  current.journal.close();
  rmSync(current.directory, { recursive: true, force: true });
  // Only when nothing is left, so a parallel file does not lose its own root.
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) rmSync(runRoot, { recursive: true, force: true });
  delete process.env['AUTOAPP_TEST_CRASH_AT'];
  delete process.env['AUTOAPP_FIXTURE_MIGRATIONS'];
  delete process.env['AUTOAPP_FIXTURE_FAIL_MIGRATION'];
});

/**
 * Where a test's launcher root goes.
 *
 * Inside the repository rather than in a temporary directory: the source
 * workspace imports `broapp` and `broapp-autoapp`, and module resolution has to
 * be able to walk up to a `node_modules` that has them — exactly as a real
 * installed workspace's would. `tests/build.test.ts` does the same for the same
 * reason.
 */
const runRoot = join(import.meta.dir, '.autoapp-run');

/** A launcher root with the fixture copied into one application's workspace. */
function makeWorld(): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'act-'));
  const root = layout(directory);
  const app = root.app('items');
  mkdirSync(app.dir, { recursive: true });
  cpSync(fixture, app.source, { recursive: true });
  const built: World = {
    root,
    directory,
    journal: openJournal(root.journal),
    supervisor: createSupervisor({
      execPath: launcher,
      logger: { warn: () => undefined, error: () => undefined },
    }),
  };
  world = built;
  return built;
}

/** Build a release of the fixture at a chosen schema version. */
async function build(
  where: World,
  options: { schemaVersion?: number; edit?: (sourceDir: string) => void } = {},
): Promise<string> {
  const app = where.root.app('items');
  options.edit?.(app.source);
  if (options.schemaVersion !== undefined) {
    const manifest = JSON.parse(await Bun.file(join(app.source, 'autoapp.json')).text()) as {
      schemaVersion: number;
      migrations: { toSchemaVersion: number }[];
    };
    manifest.schemaVersion = options.schemaVersion;
    const wanted = options.schemaVersion;
    manifest.migrations = manifest.migrations.filter((step) => step.toSchemaVersion <= wanted);
    writeFileSync(join(app.source, 'autoapp.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // The build bundles `db.ts` as it is, so the cap has to travel with the
    // release rather than with the process that built it.
    const db = await Bun.file(join(app.source, 'src', 'host', 'db.ts')).text();
    writeFileSync(
      join(app.source, 'src', 'host', 'db.ts'),
      db.replace(
        "const capped = Number(process.env['AUTOAPP_FIXTURE_MIGRATIONS'] ?? '');",
        `const capped = ${String(options.schemaVersion)};`,
      ),
    );
  }
  const result = await buildCandidate({ layout: where.root, appId: 'items' });
  if (!result.ok) throw new Error(result.problems.map((p) => `${p.stage}: ${p.message}`).join('; '));
  return result.releaseId;
}

/**
 * What the fixture asks for. `items.ping` is `external`, and since 22a a build
 * refuses an `external` route in a manifest that asks for nothing.
 */
const FIXTURE_CAPABILITIES = (JSON.parse(readFileSync(join(fixture, 'autoapp.json'), 'utf8')) as { capabilities: unknown[] })
  .capabilities;

/** Grant whatever the release asks for, so activation is not blocked on it. */
function grantAll(where: World, releaseId: string, capabilities: unknown[] = FIXTURE_CAPABILITIES): void {
  writeGrants(where.root, 'items', {
    appId: 'items',
    releaseId,
    grantedAt: Date.now(),
    capabilities: capabilities as never,
  });
}

/** Write `acceptance` into the workspace's manifest, build, and grant what the release asks for. */
async function withAcceptance(where: World, acceptance: unknown[]): Promise<string> {
  const path = join(where.root.app('items').source, 'autoapp.json');
  const manifest = JSON.parse(await Bun.file(path).text()) as { acceptance: unknown[] };
  manifest.acceptance = acceptance;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  const releaseId = await build(where);
  grantAll(where, releaseId);
  return releaseId;
}

/**
 * A release carrying `acceptance` that no build since 22a would make — a step
 * on an `external` route — written the way a release built before it was:
 * the fixture's own build, its examples replaced, its identity recomputed.
 * What such a release does once stored is what this file holds to.
 */
async function storedWithAcceptance(where: World, acceptance: readonly AcceptanceExample[]): Promise<string> {
  const built = readRelease(where.root, 'items', await build(where));
  const dir = where.root.app('items').release(built.manifest.releaseId);
  const page = readFileSync(join(dir, built.manifest.entry.page));
  const host = readFileSync(join(dir, built.manifest.entry.host));
  const draft = { ...built, acceptance };
  const releaseId = computeReleaseId({ page, host, spec: draft });
  writeRelease(where.root, { ...draft, manifest: { ...draft.manifest, releaseId } }, { page, host });
  grantAll(where, releaseId);
  return releaseId;
}

/**
 * What `candidate.check` does: `runAcceptance` over a preview of the release,
 * on a fresh copy of the live data when there is any, as `startPreview` makes.
 */
async function previewCheck(where: World, releaseId: string): ReturnType<typeof runAcceptance> {
  const app = where.root.app('items');
  const copy = join(mkdtempSync(join(where.directory, 'preview-')), 'data');
  if (existsSync(app.data)) snapshotDirectory(app.data, copy);
  else mkdirSync(copy, { recursive: true });
  const preview = await where.supervisor.start({
    appId: 'items',
    releaseDir: app.release(releaseId),
    releaseId,
    dataDir: copy,
    mode: 'preview',
  });
  const spec = readRelease(where.root, 'items', releaseId);
  const results = await runAcceptance(preview, spec.acceptance, spec.views);
  await preview.shutdown(5_000);
  return results;
}

/** Activate, stop the new child, and say what happened in one string a test can compare. */
async function activation(where: World, releaseId: string): Promise<string> {
  const result = await activate({
    layout: where.root,
    supervisor: where.supervisor,
    journal: where.journal,
    appId: 'items',
    releaseId,
    logger: { warn: () => undefined, error: () => undefined },
  });
  if (result.ok) await result.child.shutdown(5_000);
  return result.ok ? 'activated' : `${result.phase}: ${result.reason}`;
}

/** A sentence with its numbers and ids taken out, so two runs of one step compare equal. */
function shape(text: string | undefined): string {
  return (text ?? '').replace(/\d+/g, '#');
}

/** Count the rows in one items database, without migrating it. */
function countItems(directory: string): number {
  const db = new Database(join(directory, 'items.sqlite'), { readonly: true });
  try {
    return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM items').get()?.n ?? 0;
  } finally {
    db.close();
  }
}

/** True when a process with this id is still on the process table. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as { code?: string }).code === 'EPERM';
  }
}

describe.skipIf(!available)('buildCandidate', () => {
  test('builds a release, and an identical rebuild is the same release', async () => {
    const where = makeWorld();
    const first = await build(where);
    expect(first).toMatch(/^[0-9a-f]{32}$/);

    const again = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.releaseId).toBe(first);
    // The release directory is immutable and named by its contents, so there
    // was nothing a second write could legitimately change.
    expect(again.rebuilt).toBe(false);
  });

  test('a route with no effect is a contract problem', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const path = join(app.source, 'src', 'shared', 'contract.ts');
    const source = await Bun.file(path).text();
    // Matched with a pattern rather than a literal: a Windows checkout stores
    // the fixture with CRLF line endings, and a literal ending in `\n` silently
    // fails to match — the file would be written back unchanged and the test
    // would assert against a build that had nothing wrong with it.
    writeFileSync(path, source.replace(/ *effect: 'external',\r?\n/, ''));

    const result = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.stage === 'contract')).toBe(true);
    expect(result.problems.some((p) => p.message.includes('items.ping'))).toBe(true);
  });

  /**
   * The flaw prompt 08b fixes. Under the old rule an acceptance-only change
   * hashed to the release it came from, so `buildCandidate` had to refuse it —
   * and `activate` runs the acceptance examples as its check, which meant a
   * person could add a check that could never reach a release.
   */
  test('an acceptance-only change is a new release, and it activates', async () => {
    const where = makeWorld();
    const first = await build(where);
    const app = where.root.app('items');

    const manifestPath = join(app.source, 'autoapp.json');
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      acceptance: { id: string; title: string; steps: unknown[] }[];
    };
    manifest.acceptance.push({
      id: 'added-later',
      title: 'Something new to check',
      steps: [{ route: 'items.list', input: null }],
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const second = await build(where);
    expect(second).not.toBe(first);
    expect(readRelease(where.root, 'items', second).acceptance.map((one) => one.id)).toContain(
      'added-later',
    );

    grantAll(where, second);
    setCurrent(where.root, 'items', first);
    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId: second,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readCurrent(where.root, 'items')).toBe(second);
    // The acceptance check ran over IPC, so the new child's one-time launch
    // token is still unspent for the tab that opens next.
    const visitor = await connectToChild(result.child.url);
    await visitor.close();
    await result.child.shutdown(5_000);
  }, 120_000);

  test('a views-only change is a new release, and it activates', async () => {
    const where = makeWorld();
    const first = await build(where);
    const app = where.root.app('items');

    // A column header, which the page bundle does not contain: the views module
    // is bundled for the specification, not shipped to the browser as code.
    const viewsPath = join(app.source, 'src', 'shared', 'views.ts');
    const source = await Bun.file(viewsPath).text();
    writeFileSync(viewsPath, source.replace("header: 'Label'", "header: 'What it is'"));

    const second = await build(where);
    expect(second).not.toBe(first);

    grantAll(where, second);
    setCurrent(where.root, 'items', first);
    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId: second,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readCurrent(where.root, 'items')).toBe(second);
    await result.child.shutdown(5_000);
  }, 120_000);

  test('views naming a route that is not there is a views problem', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const path = join(app.source, 'src', 'shared', 'views.ts');
    const source = await Bun.file(path).text();
    writeFileSync(path, source.replace("operation: 'items.list'", "operation: 'items.missing'"));

    const result = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.stage === 'views')).toBe(true);
    expect(result.problems.some((p) => p.message.includes('items.missing'))).toBe(true);
  });
});

describe.skipIf(!available)('snapshots', () => {
  test('a snapshot taken under concurrent writes is a consistent database', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    grantAll(where, releaseId);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });

    const child = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    const client = await connectToChild(child.url);

    // Write continuously while the snapshot is taken. `VACUUM INTO` is what
    // makes this safe: a byte copy of a WAL database mid-transaction opens and
    // is wrong.
    let writing = true;
    let written = 0;
    const writer = (async () => {
      while (writing) {
        await client.call('items.add', { label: `item ${String(written)}` });
        written += 1;
      }
    })();

    await Bun.sleep(150);
    const before = written;
    const target = join(where.directory, 'snap');
    const entries = snapshotDirectory(app.data, target);
    const after = written;
    writing = false;
    await writer;
    await client.close();

    // Both databases came across, each through `VACUUM INTO`. The run store
    // lives in the data directory too, so the history of what agents did
    // travels with the data it was done to.
    expect(entries.map((entry) => `${entry.path}:${entry.method}`).sort()).toEqual([
      'items.sqlite:vacuum',
      'runs.sqlite:vacuum',
    ]);
    // No sidecar came across: `VACUUM INTO` folded each one in.
    expect(readdirSync(target).sort()).toEqual(['items.sqlite', 'runs.sqlite']);

    const copy = new Database(join(target, 'items.sqlite'), { readonly: true });
    try {
      expect(copy.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      const rows = copy.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM items').get()?.n ?? -1;
      expect(rows).toBeGreaterThanOrEqual(before);
      // `after + 1` because the writer increments its counter once the call has
      // already committed: a row can be in the database while the count of it
      // is still one statement away.
      expect(rows).toBeLessThanOrEqual(after + 1);
    } finally {
      copy.close();
    }
    await child.shutdown(5_000);
  }, 30_000);
});

describe.skipIf(!available)('preview mode', () => {
  test('refuses what reaches outside, allows what does not, and leaves live data alone', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    grantAll(where, releaseId);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });
    mkdirSync(app.dataNext, { recursive: true });

    const child = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.dataNext,
      mode: 'preview',
    });
    const client = await connectToChild(child.url);

    try {
      await client.call('items.ping', undefined);
      throw new Error('preview should have refused items.ping');
    } catch (cause) {
      // `rejected` is Broapp's own code, read back through the marker the host
      // put in the message. That is the vocabulary the policy speaks; the
      // protocol code underneath it is Brobridge's business.
      const error = fromTransportError(cause);
      expect(error.code).toBe('rejected');
      expect(error.message).toContain('preview');
    }

    // A write inside the data directory is fine: a preview runs against a copy
    // of the data, and a copy of the data is not a copy of the world.
    await client.call('items.add', { label: 'only in the preview' });
    const listed = (await client.call('items.list', undefined)) as { count: number };
    expect(listed.count).toBe(1);

    await client.close();
    await child.shutdown(5_000);

    expect(countItems(app.dataNext)).toBe(1);
    // The live directory never had a database created in it.
    expect(existsSync(join(app.data, 'items.sqlite'))).toBe(false);
  }, 30_000);
});

describe.skipIf(!available)('activation', () => {
  /** Build A at schema 2, put some data behind it, then build B at schema 3. */
  async function twoReleases(
    where: World,
    /** Applied to the source workspace after the full migration list is restored, before B is built. */
    beforeB?: (sourceDir: string) => void | Promise<void>,
  ): Promise<{ a: string; b: string }> {
    const a = await build(where, { schemaVersion: 2 });
    grantAll(where, a);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });

    const first = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(a),
      releaseId: a,
      dataDir: app.data,
      mode: 'live',
    });
    const client = await connectToChild(first.url);
    await client.call('items.add', { label: 'written under A' });
    await client.close();
    await first.shutdown(5_000);
    setCurrent(where.root, 'items', a);

    // Restore the full migration list, so B is a real forward step.
    cpSync(join(fixture, 'src', 'host', 'db.ts'), join(app.source, 'src', 'host', 'db.ts'));
    cpSync(join(fixture, 'autoapp.json'), join(app.source, 'autoapp.json'));
    await beforeB?.(app.source);
    const b = await build(where);
    return { a, b };
  }

  test('a release-and-data pair is switched together', async () => {
    const where = makeWorld();
    const { a, b } = await twoReleases(where);
    const app = where.root.app('items');

    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId: b,
      logger: { warn: () => undefined, error: () => undefined },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previousRelease).toBe(a);
    expect(result.child.schemaVersion).toBe(3);
    expect(readCurrent(where.root, 'items')).toBe(b);

    const activation = where.journal.history('items')[0];
    expect(activation?.phase).toBe('done');
    expect(activation?.fromRelease).toBe(a);

    // The data came across, the previous copy is kept, and so is the snapshot.
    expect(countItems(app.data)).toBe(1);
    const prev = readdirSync(app.dir).filter((name) => name.startsWith('data-prev-'));
    expect(prev).toHaveLength(1);
    expect(countItems(join(app.dir, prev[0] ?? ''))).toBe(1);
    expect(readdirSync(app.snapshots)).toHaveLength(1);
    await result.child.shutdown(5_000);
  }, 60_000);

  test('a migration that fails leaves the previous release serving unchanged data', async () => {
    const where = makeWorld();
    // Broken in the *source*, so B is a real release with a real bad migration.
    // Corrupting the built directory instead would now be caught earlier, by
    // the identity check, and would never reach the migrate phase at all.
    const { a, b } = await twoReleases(where, async (sourceDir) => {
      const path = join(sourceDir, 'src', 'host', 'db.ts');
      const source = await Bun.file(path).text();
      writeFileSync(
        path,
        source.replace(
          "ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT '';",
          'ALTER TABLE items ADD COLUMN note NOT VALID SQL;',
        ),
      );
    });
    const app = where.root.app('items');

    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId: b,
      logger: { warn: () => undefined, error: () => undefined },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.phase).toBe('migrated');
    expect(result.recovered).toBe('previous-serving');
    expect(where.journal.history('items')[0]?.phase).toBe('failed-before-switch');
    expect(readCurrent(where.root, 'items')).toBe(a);
    expect(existsSync(app.dataNext)).toBe(false);
    expect(countItems(app.data)).toBe(1);
  }, 60_000);

  test('an acceptance example that fails stops the activation', async () => {
    const where = makeWorld();
    // Written into the manifest, so B genuinely contains this check. Acceptance
    // examples are part of a release's identity now, so this is an ordinary
    // build rather than a doctored directory.
    const { a, b } = await twoReleases(where, async (sourceDir) => {
      const path = join(sourceDir, 'autoapp.json');
      const manifest = JSON.parse(await Bun.file(path).text()) as {
        acceptance: { id: string; title: string; steps: unknown[] }[];
      };
      manifest.acceptance = [
        {
          id: 'impossible',
          title: 'Expects something that is not so',
          steps: [{ route: 'items.list', input: null, expect: { items: [], count: 99 } }],
        },
      ];
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    const app = where.root.app('items');

    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId: b,
      logger: { warn: () => undefined, error: () => undefined },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.phase).toBe('checked');
    expect(result.reason).toContain('acceptance');
    expect(result.recovered).toBe('previous-serving');
    expect(readCurrent(where.root, 'items')).toBe(a);
    expect(existsSync(app.dataNext)).toBe(false);
  }, 60_000);

  test('an example whose keys are in another order than the output passes activation, as it passes a preview', async () => {
    const where = makeWorld();
    // `items.list` answers `{ items, count }`; the example names them the other
    // way round, which is also how a stored example comes back, keys sorted.
    // Activation compared by `JSON.stringify` until 12d's follow-up and refused this.
    const path = join(where.root.app('items').source, 'autoapp.json');
    const manifest = JSON.parse(await Bun.file(path).text()) as { acceptance: unknown[] };
    manifest.acceptance = [
      { id: 'empty', title: 'Nothing is there yet', steps: [{ route: 'items.list', input: null, expect: { count: 0, items: [] } }] },
    ];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const releaseId = await build(where);
    grantAll(where, releaseId);

    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId,
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(result.ok ? 'activated' : `${result.phase}: ${result.reason}`).toBe('activated');
    if (result.ok) await result.child.shutdown(5_000);
  }, 60_000);

  test('an example with $is and fails, reading and writing, gets the same answer from a preview check and from activation', async () => {
    const where = makeWorld();

    // Refused by the route's own input schema, a write that succeeds, then a
    // list whose contents the example gives only by kind. Activation runs the
    // examples where the preview does since 14e, so the write runs in both.
    const holds = await withAcceptance(where, [
      {
        id: 'refused-then-listed',
        title: 'A list with input is refused, an item is added, and the list holds it',
        steps: [
          { route: 'items.list', input: { page: 2 }, fails: { code: 'invalid_input' } },
          { route: 'items.add', input: { label: 'from the example' }, match: { id: { $is: 'number' }, label: 'from the example' } },
          { route: 'items.list', input: null, match: { items: { $is: 'array' }, count: { $is: 'number' } } },
        ],
      },
    ]);
    expect((await previewCheck(where, holds)).map((result) => result.passed)).toEqual([true]);
    expect(await activation(where, holds)).toBe('activated');

    // The same shapes, wrong: a read that succeeds where the example says it is
    // refused, a count that is a number where it says a string, and a write
    // said to be refused that succeeds. Each fails in both places, for the same
    // reason.
    const wrong = await withAcceptance(where, [
      { id: 'not-refused', title: 'The list is refused', steps: [{ route: 'items.list', input: null, fails: {} }] },
      { id: 'wrong-kind', title: 'The count is a string', steps: [{ route: 'items.list', input: null, match: { count: { $is: 'string' } } }] },
      { id: 'write-refused', title: 'Adding is refused', steps: [{ route: 'items.add', input: { label: 'x' }, fails: {} }] },
    ]);
    const checked = await previewCheck(where, wrong);
    expect(checked.map((result) => result.passed)).toEqual([false, false, false]);
    expect(checked[0]?.detail).toContain('items.list succeeded with');
    expect(checked[0]?.detail).toContain('but the example says it is refused');
    expect(checked[1]?.detail).toMatch(/count: expected a string, got \d+/);
    expect(checked[2]?.detail).toContain('items.add succeeded with');
    const refused = await activation(where, wrong);
    expect(refused).toStartWith('checked:');
    expect(refused).toContain(`not-refused: ${checked[0]?.detail ?? ''}`);
  }, 120_000);

  test('a drain that times out leaves the previous release serving', async () => {
    const where = makeWorld();
    const { a, b } = await twoReleases(where);
    const app = where.root.app('items');

    const serving = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(a),
      releaseId: a,
      dataDir: app.data,
      mode: 'live',
    });
    const client = await connectToChild(serving.url);
    // A stream that never ends, so the application is genuinely still busy when
    // the deadline passes.
    const stream = await client.openStream('items.watch', { everyMs: 20 });
    let events = 0;
    // Iterating is what grants credit, so the producer only keeps going while
    // something is actually reading.
    void (async () => {
      for await (const _chunk of stream) events += 1;
    })().catch(() => undefined);
    await Bun.sleep(200);
    expect(events).toBeGreaterThan(0);

    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId: b,
      drainDeadlineMs: 300,
      logger: { warn: () => undefined, error: () => undefined },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.phase).toBe('drained');
    expect(result.recovered).toBe('previous-serving');
    expect(readCurrent(where.root, 'items')).toBe(a);

    // The stream the person was watching is still running.
    const seen = events;
    await Bun.sleep(150);
    expect(events).toBeGreaterThan(seen);
    await stream.cancel();
    await client.close();
  }, 60_000);

  test('a release asking for a capability nobody granted is refused', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const manifestPath = join(app.source, 'autoapp.json');
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { capabilities: unknown[] };
    manifest.capabilities = [
      { kind: 'network', hosts: ['api.example.com'], reason: 'To sync items.' },
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const releaseId = await build(where);
    // Deliberately no grant.

    const result = await activate({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      appId: 'items',
      releaseId,
      logger: { warn: () => undefined, error: () => undefined },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.phase).toBe('requested');
    expect(result.reason).toContain('capabilities');
    expect(where.journal.history('items')[0]?.phase).toBe('failed-before-switch');
  }, 60_000);
});

describe.skipIf(!available)('recovery', () => {
  /** Run an activation that stops dead at `phase`, then recover from it. */
  async function crashAt(
    phase: string,
    /** Looks at the disk the crash left, before recovery touches it. */
    beforeRecover?: (where: World) => void,
  ): Promise<{
    where: World;
    a: string;
    b: string;
    recovered: Awaited<ReturnType<typeof recover>>;
  }> {
    const where = makeWorld();
    const a = await build(where, { schemaVersion: 2 });
    grantAll(where, a);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });
    const first = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(a),
      releaseId: a,
      dataDir: app.data,
      mode: 'live',
    });
    const client = await connectToChild(first.url);
    await client.call('items.add', { label: 'written under A' });
    await client.close();
    await first.shutdown(5_000);
    setCurrent(where.root, 'items', a);
    cpSync(join(fixture, 'src', 'host', 'db.ts'), join(app.source, 'src', 'host', 'db.ts'));
    cpSync(join(fixture, 'autoapp.json'), join(app.source, 'autoapp.json'));
    const b = await build(where);

    process.env['NODE_ENV'] = 'test';
    process.env['AUTOAPP_TEST_CRASH_AT'] = phase;
    await expect(
      activate({
        layout: where.root,
        supervisor: where.supervisor,
        journal: where.journal,
        appId: 'items',
        releaseId: b,
        logger: { warn: () => undefined, error: () => undefined },
      }),
    ).rejects.toThrow(/crash injected/);
    delete process.env['AUTOAPP_TEST_CRASH_AT'];

    // A crashed launcher leaves its children behind; a fresh one would not know
    // about them. Stopping them here is what restarting the launcher does.
    await where.supervisor.stopAll(5_000);
    beforeRecover?.(where);

    const recovered = await recover({
      layout: where.root,
      journal: where.journal,
      supervisor: where.supervisor,
      logger: { warn: () => undefined, error: () => undefined },
    });
    return { where, a, b, recovered };
  }

  for (const phase of ['snapshotted', 'migrated', 'checked'] as const) {
    test(`a crash at ${phase} abandons the update and keeps the data`, async () => {
      const { where, a, recovered } = await crashAt(phase);
      const app = where.root.app('items');
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.outcome).toBe('abandoned');
      expect(recovered[0]?.serving).toBe(a);
      expect(where.journal.history('items')[0]?.phase).toBe('failed-before-switch');
      expect(existsSync(app.dataNext)).toBe(false);
      expect(readCurrent(where.root, 'items')).toBe(a);
      expect(countItems(app.data)).toBe(1);
    }, 60_000);
  }

  test('a crash with the examples\' copy still on disk abandons the update and removes both copies', async () => {
    let leftBehind: boolean[] = [];
    const { where, a, recovered } = await crashAt('checked-copy', (at) => {
      const app = at.root.app('items');
      leftBehind = [existsSync(app.dataCheck), existsSync(app.dataNext)];
    });
    const app = where.root.app('items');
    // The crash really did leave both copies behind, so recovery is what removed them.
    expect(leftBehind).toEqual([true, true]);
    expect(recovered[0]?.outcome).toBe('abandoned');
    expect(recovered[0]?.serving).toBe(a);
    expect(where.journal.history('items')[0]?.phase).toBe('failed-before-switch');
    expect(existsSync(app.dataCheck)).toBe(false);
    expect(existsSync(app.dataNext)).toBe(false);
    expect(readCurrent(where.root, 'items')).toBe(a);
    expect(countItems(app.data)).toBe(1);
    expect(where.supervisor.children.map((child) => child.releaseId)).toEqual([a]);
  }, 60_000);

  test('a stray examples\' copy with no activation in flight is removed at start, and nothing else is', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const planted = [app.data, app.dataNext, app.dataPrev(1), join(app.snapshots, '1-none')];
    for (const directory of [...planted, app.dataCheck]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'marker'), 'x');
    }

    const recovered = await recover({
      layout: where.root,
      journal: where.journal,
      supervisor: where.supervisor,
      logger: { warn: () => undefined, error: () => undefined },
    });

    expect(recovered).toEqual([]);
    expect(existsSync(app.dataCheck)).toBe(false);
    for (const directory of planted) expect(existsSync(join(directory, 'marker'))).toBe(true);
    expect(where.supervisor.children).toHaveLength(0);
  }, 30_000);

  test('a crash between the two renames finishes the switch', async () => {
    const { where, b, recovered } = await crashAt('switched-half');
    const app = where.root.app('items');
    expect(recovered[0]?.outcome).toBe('completed');
    expect(recovered[0]?.serving).toBe(b);
    expect(recovered[0]?.finding).toContain('between the two renames');
    expect(readCurrent(where.root, 'items')).toBe(b);
    expect(existsSync(app.dataNext)).toBe(false);
    expect(countItems(app.data)).toBe(1);
    expect(readdirSync(app.dir).filter((n) => n.startsWith('data-prev-'))).toHaveLength(1);
    expect(where.journal.history('items')[0]?.phase).toBe('done');
  }, 60_000);

  test('a crash after both renames is already complete', async () => {
    const { where, b, recovered } = await crashAt('switched-both');
    const app = where.root.app('items');
    expect(recovered[0]?.outcome).toBe('completed');
    expect(recovered[0]?.serving).toBe(b);
    expect(readCurrent(where.root, 'items')).toBe(b);
    expect(countItems(app.data)).toBe(1);
    expect(where.journal.history('items')[0]?.phase).toBe('done');
  }, 60_000);

  test('a crash while starting the new release just starts it', async () => {
    const { where, b, recovered } = await crashAt('serving');
    expect(recovered[0]?.outcome).toBe('completed');
    expect(recovered[0]?.serving).toBe(b);
    expect(recovered[0]?.finding).toContain('the switch was complete');
    expect(readCurrent(where.root, 'items')).toBe(b);
    expect(where.journal.history('items')[0]?.phase).toBe('done');
  }, 60_000);

  test('recovery never throws away a previous data directory or a snapshot', async () => {
    const { where } = await crashAt('switched-both');
    const app = where.root.app('items');
    expect(readdirSync(app.dir).filter((n) => n.startsWith('data-prev-'))).toHaveLength(1);
    expect(readdirSync(app.snapshots).length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!available)('examples at activation', () => {
  /** Adds one item, then lists it with the row A wrote. Passes only where writes run. */
  const ADD_THEN_LIST = {
    id: 'add-then-list',
    title: 'An added item is listed first',
    steps: [
      { route: 'items.add', input: { label: 'from the example' }, match: { label: 'from the example' } },
      {
        route: 'items.list',
        input: null,
        match: { items: [{ label: 'from the example' }, { label: 'written under A' }], count: 2 },
      },
    ],
  };

  /** A at schema 2 with one row serving, and B at schema 3 carrying `acceptance`. */
  async function aThenB(where: World, acceptance: unknown[], edit?: (sourceDir: string) => void): Promise<{ a: string; b: string }> {
    const a = await build(where, { schemaVersion: 2 });
    grantAll(where, a);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });
    const first = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(a),
      releaseId: a,
      dataDir: app.data,
      mode: 'live',
    });
    const client = await connectToChild(first.url);
    await client.call('items.add', { label: 'written under A' });
    await client.close();
    await first.shutdown(5_000);
    setCurrent(where.root, 'items', a);
    cpSync(join(fixture, 'src', 'host', 'db.ts'), join(app.source, 'src', 'host', 'db.ts'));
    cpSync(join(fixture, 'autoapp.json'), join(app.source, 'autoapp.json'));
    edit?.(app.source);
    const b = await withAcceptance(where, acceptance);
    return { a, b };
  }

  test('an example that writes passes a preview check and activation', async () => {
    const where = makeWorld();
    const { b } = await aThenB(where, [ADD_THEN_LIST]);
    expect(await previewCheck(where, b)).toEqual([{ id: 'add-then-list', title: ADD_THEN_LIST.title, passed: true }]);
    expect(await activation(where, b)).toBe('activated');
    expect(readCurrent(where.root, 'items')).toBe(b);
  }, 120_000);

  test('after it, the live data holds nothing the example wrote, and the examples\' copy is gone', async () => {
    const where = makeWorld();
    const { b } = await aThenB(where, [ADD_THEN_LIST]);
    const app = where.root.app('items');
    expect(await activation(where, b)).toBe('activated');
    expect(countItems(app.data)).toBe(1);
    expect(existsSync(app.dataCheck)).toBe(false);
    expect(existsSync(app.dataNext)).toBe(false);
    // The migrated data became live and the release opened it: the note column
    // B's migration added is there, and the row A wrote came across.
    const db = new Database(join(app.data, 'items.sqlite'), { readonly: true });
    try {
      expect(db.query<{ label: string }, []>('SELECT label FROM items').all()).toEqual([{ label: 'written under A' }]);
      expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(3);
    } finally {
      db.close();
    }
  }, 120_000);

  test('an example that fails gives up before the switch and leaves no copy', async () => {
    const where = makeWorld();
    const { a, b } = await aThenB(where, [
      {
        id: 'add-then-wrong-count',
        title: 'An added item makes a count nobody has',
        steps: [
          { route: 'items.add', input: { label: 'from the example' } },
          { route: 'items.list', input: null, match: { count: 99 } },
        ],
      },
    ]);
    const app = where.root.app('items');
    const said = await activation(where, b);
    expect(said).toStartWith('checked: an acceptance example failed: add-then-wrong-count:');
    expect(readCurrent(where.root, 'items')).toBe(a);
    expect(where.supervisor.children.map((child) => [child.releaseId, child.mode])).toEqual([[a, 'live']]);
    expect(existsSync(app.dataCheck)).toBe(false);
    expect(existsSync(app.dataNext)).toBe(false);
    expect(countItems(app.data)).toBe(1);
  }, 120_000);

  test('a write the route refuses passes in both places; a write said refused that succeeds fails in both, with one sentence', async () => {
    const where = makeWorld();
    const refuses = await withAcceptance(where, [
      {
        id: 'empty-label',
        title: 'An empty label is refused, and nothing was added',
        steps: [
          { route: 'items.add', input: { label: '' }, fails: { code: 'invalid_input' } },
          { route: 'items.list', input: null, match: { count: 0 } },
        ],
      },
    ]);
    expect((await previewCheck(where, refuses)).map((result) => result.passed)).toEqual([true]);
    expect(await activation(where, refuses)).toBe('activated');

    const succeeds = await withAcceptance(where, [
      { id: 'add-refused', title: 'Adding is refused', steps: [{ route: 'items.add', input: { label: 'x' }, fails: {} }] },
    ]);
    const [checked] = await previewCheck(where, succeeds);
    expect(checked?.passed).toBe(false);
    expect(checked?.detail).toContain('items.add succeeded with');
    const said = await activation(where, succeeds);
    expect(said).toStartWith('checked: an acceptance example failed: add-refused: ');
    expect(shape(said.slice('checked: an acceptance example failed: add-refused: '.length))).toBe(shape(checked?.detail));
  }, 120_000);

  test('a route that reaches outside is refused the same way, with the same words, in both places', async () => {
    const where = makeWorld();
    const pings = await storedWithAcceptance(where, [
      { id: 'ping', title: 'The ping answers', steps: [{ route: 'items.ping', input: null }] },
    ]);
    const [checked] = await previewCheck(where, pings);
    expect(checked?.passed).toBe(false);
    const said = await activation(where, pings);
    expect(said).toBe(`checked: an acceptance example failed: ping: ${checked?.detail ?? ''}`);

    // And an example that says so passes in both.
    const refusedOutside = await storedWithAcceptance(where, [
      { id: 'ping-refused', title: 'The ping is refused here', steps: [{ route: 'items.ping', input: null, fails: {} }] },
    ]);
    expect((await previewCheck(where, refusedOutside)).map((result) => result.passed)).toEqual([true]);
    expect(await activation(where, refusedOutside)).toBe('activated');
  }, 120_000);

  test('examples that pass, then a release that will not open the migrated data, says the second', async () => {
    const where = makeWorld();
    // The candidate starts in preview mode for the examples and refuses to start
    // live: the one start that differs between the two is the one on data-next.
    const { a, b } = await aThenB(where, [ADD_THEN_LIST], (sourceDir) => {
      const path = join(sourceDir, 'src', 'host', 'app.ts');
      const source = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        source.replace(
          'export function start(context: AppStartContext): Promise<AppInstance> {',
          "export function start(context: AppStartContext): Promise<AppInstance> {\n  if (context.mode === 'live') throw new Error('this release will not open live data');",
        ),
      );
    });
    const app = where.root.app('items');
    const said = await activation(where, b);
    expect(said).toStartWith('checked: the acceptance examples passed, but the release would not open the migrated data:');
    expect(said).not.toContain('an acceptance example failed');
    expect(readCurrent(where.root, 'items')).toBe(a);
    expect(existsSync(app.dataCheck)).toBe(false);
    expect(existsSync(app.dataNext)).toBe(false);
  }, 120_000);

  test('the checked phase records the copy\'s duration, and no phase was added', async () => {
    const where = makeWorld();
    const { b } = await aThenB(where, [ADD_THEN_LIST]);
    expect(await activation(where, b)).toBe('activated');
    const row = where.journal.history('items')[0];
    expect(row?.phase).toBe('done');
    expect(typeof row?.checkCopyMs).toBe('number');
    expect(row?.checkCopyMs ?? -1).toBeGreaterThanOrEqual(0);
    // Named while the copy existed, cleared once it was removed.
    expect(row?.checkDir).toBeNull();

    // Every phase, once. A phase added to `Phase` is a missing key here and a
    // removed one an unknown key: either way this file stops typechecking.
    const phases: Record<Phase, true> = {
      requested: true,
      drained: true,
      snapshotted: true,
      migrated: true,
      checked: true,
      switched: true,
      serving: true,
      done: true,
      'failed-before-switch': true,
      'failed-after-switch': true,
      'rolled-back': true,
      removed: true,
    };
    expect(Object.keys(phases)).toHaveLength(12);
  }, 120_000);
});

describe.skipIf(!available)('serving', () => {
  test('a release serves with its whole source workspace deleted', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    grantAll(where, releaseId);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });

    // The guarantee that is actually true about a release: `Bun.build` inlines
    // every dependency into `host.js`, so the release directory carries what it
    // needs and resolves nothing at runtime. Deleting the workspace outright is
    // the strongest form of that check and subsumes removing its
    // `node_modules` — which this fixture does not have, because it resolves
    // through the repository's own. A test that moved a directory that was
    // never there would pass for the wrong reason.
    rmSync(app.source, { recursive: true, force: true });
    expect(existsSync(app.source)).toBe(false);

    const child = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
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

  test('the host bundle imports nothing but the runtime’s own modules', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    const bundle = await Bun.file(
      join(where.root.app('items').release(releaseId), 'host.js'),
    ).text();

    // Every `import ... from "x"` left in the bundle, and every `require("x")`.
    const specifiers = new Set<string>();
    for (const match of bundle.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      if (match[1] !== undefined) specifiers.add(match[1]);
    }
    for (const match of bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      if (match[1] !== undefined) specifiers.add(match[1]);
    }

    // `bun:` and Node's own builtins — with or without the `node:` prefix, both
    // of which the bundler emits — are the runtime the child already is.
    // Anything else would be a dependency the release expects to find on disk
    // at run time, which is exactly what must not survive the build.
    const builtin = new Set(builtinModules);
    const external = [...specifiers].filter(
      (one) =>
        !one.startsWith('bun:') &&
        !builtin.has(one.startsWith('node:') ? one.slice('node:'.length) : one),
    );
    expect(external).toEqual([]);
    // The check is only worth anything if the bundle really did inline the
    // application's dependencies rather than emitting nothing at all.
    expect(bundle.length).toBeGreaterThan(10_000);
  }, 120_000);

  test('a dependency that is not installed is a build problem naming it', async () => {
    const where = makeWorld();
    const app = where.root.app('items');

    // Declared but never installed, and not resolvable from anywhere above the
    // workspace either. The bundler would eventually fail on the import; this
    // fails first, with a sentence a person can act on.
    const path = join(app.source, 'package.json');
    const manifest = JSON.parse(await Bun.file(path).text()) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...manifest.dependencies, 'left-pad-that-is-not-here': '^1.0.0' };
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const problem = result.problems.find((one) => one.message.includes('left-pad-that-is-not-here'));
    expect(problem?.stage).toBe('host');
    expect(problem?.message).toContain('re-import to add one');
  }, 120_000);

  test('a stale current is refused with the sentence, not started', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    setCurrent(where.root, 'items', releaseId);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });

    // Exactly what a release built before prompt 08b looks like: the directory
    // holds a specification the name is no longer the hash of. Simulated by
    // editing one field the identity now covers and nothing else.
    const specPath = join(app.release(releaseId), 'spec.json');
    const spec = JSON.parse(await Bun.file(specPath).text()) as {
      acceptance: { id: string; title: string; steps: unknown[] }[];
    };
    spec.acceptance.push({
      id: 'added-by-hand',
      title: 'Not what this release was named for',
      steps: [{ route: 'items.list', input: null }],
    });
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);

    const said: string[] = [];
    const code = await keepServing({
      layout: where.root,
      supervisor: where.supervisor,
      appId: 'items',
      logger: { warn: () => undefined, error: (message) => said.push(message) },
    });

    expect(code).toBe(1);
    expect(said.join('\n')).toContain('built by an earlier version of broapp-autoapp');
    // Nothing was started, so there is nothing to clean up.
    expect(where.supervisor.children).toHaveLength(0);

    // And `releases` says which one is the problem.
    const listed = listReleases(where.root, 'items');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.stale).toBe(true);
  }, 120_000);
});

describe.skipIf(!available)('the supervisor', () => {
  test('stopAll leaves no child behind', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    grantAll(where, releaseId);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });

    const child = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    expect(alive(child.pid)).toBe(true);
    expect(where.supervisor.children).toHaveLength(1);

    await where.supervisor.stopAll(5_000);
    expect(where.supervisor.children).toHaveLength(0);
    expect(alive(child.pid)).toBe(false);
  }, 30_000);

  test('a health report says what the child is doing', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    grantAll(where, releaseId);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });

    const child = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    const health = await child.health();
    expect(health.state).toBe('serving');
    expect(health.activeWork).toBe(0);
    // Nothing has connected, so nothing is attached.
    expect(health.attached).toBe(false);

    const client = await connectToChild(child.url);
    expect((await child.health()).attached).toBe(true);
    await client.close();
    await child.shutdown(5_000);
  }, 30_000);

  test('a release that will not start is reported, not left hanging', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    const app = where.root.app('items');
    // A host bundle that throws on import cannot possibly start.
    writeFileSync(join(app.release(releaseId), 'host.js'), 'throw new Error("this release is broken");\n');
    mkdirSync(app.data, { recursive: true });

    await expect(
      where.supervisor.start({
        appId: 'items',
        releaseDir: app.release(releaseId),
        releaseId,
        dataDir: app.data,
        mode: 'live',
      }),
    ).rejects.toThrow(/could not be started|broken/);
    expect(where.supervisor.children).toHaveLength(0);
  }, 30_000);
});

