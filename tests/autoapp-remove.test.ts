/**
 * Removing an application.
 *
 * The property under test throughout: a removal moves and never deletes, and
 * refuses whenever moving could take a directory out from under a process that
 * is using it. Every assertion about "it was removed" is paired with one about
 * where it went — a test that only checked the application was gone would pass
 * against an implementation that deleted it.
 *
 * The run root is `tests/.autoapp-run/remove-*`, inside this repository rather
 * than under `mkdtemp` in the system temporary directory, for the reason
 * `tests/autoapp-activation.test.ts` gives at its own: the fixture workspace
 * depends on `broapp` and `broapp-autoapp`, and the only way its build resolves
 * them is by walking up into this repository's own `node_modules`.
 *
 * The launcher root is `<directory>/autoapp`, which is where `defaultRoot` puts
 * it under a given `BROAPP_DATA_DIR` — so the tests that run the compiled
 * `remove` command and the tests that call the function reach the same root.
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { createGate } from 'broapp/host';
import type { Gate } from 'broapp/host';
import { isPublicError } from 'broapp/shared';
import { createCandidateStates, engineerTools } from 'broapp-autoapp/engineer';
import {
  buildCandidate,
  createLauncherApp,
  createSupervisor,
  describeRemoval,
  launcherContract,
  listApps,
  openJournal,
  removeApplication,
  startControl,
  type Control,
  type Journal,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { openSession } from 'broapp-autoapp/knowledge';
import { layout, readCurrent, setCurrent, writeGrants, type Layout } from 'broapp-autoapp/spec';

import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { harness, type Harness } from './harness.ts';

const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');

// Compiled at module load, not in `beforeAll`: `describe.skipIf` is evaluated
// when the tests are registered, which is before any hook has run.
const failure = await ensureLauncher();
if (failure !== null) {
  console.warn(`[autoapp-remove] skipped: the launcher would not build\n${failure}`);
}
const available = failure === null;

const quiet = { warn: () => undefined, error: () => undefined };
const runRoot = join(import.meta.dir, '.autoapp-run');

interface World {
  readonly root: Layout;
  /** The directory `BROAPP_DATA_DIR` points at; the root is `autoapp` inside it. */
  readonly directory: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly states: ReturnType<typeof createCandidateStates>;
  readonly gate: Gate;
}

let world: World | null = null;
let live: Harness | null = null;
let control: Control | null = null;

afterEach(async () => {
  await live?.stop();
  live = null;
  control?.stop();
  control = null;
  const current = world;
  world = null;
  if (current === null) return;
  // Children first: a directory removed under a running child produces noise
  // that has nothing to do with what was under test.
  await current.supervisor.stopAll(5_000).catch(() => undefined);
  current.journal.close();
  rmSync(current.directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

/** A launcher root with the fixture copied into one application's workspace. */
function makeWorld(): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'remove-'));
  const root = layout(join(directory, 'autoapp'));
  const app = root.app('items');
  mkdirSync(app.dir, { recursive: true });
  cpSync(fixture, app.source, { recursive: true });
  const built: World = {
    root,
    directory,
    journal: openJournal(root.journal),
    supervisor: createSupervisor({ execPath: LAUNCHER, logger: quiet }),
    states: createCandidateStates(root, quiet),
    gate: createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, logger: quiet }),
  };
  world = built;
  return built;
}

/** Build the fixture and make it current, as an import would. */
async function build(where: World): Promise<string> {
  const result = await buildCandidate({ layout: where.root, appId: 'items' });
  if (!result.ok) throw new Error(result.problems.map((one) => `${one.stage}: ${one.message}`).join('; '));
  setCurrent(where.root, 'items', result.releaseId);
  writeGrants(where.root, 'items', {
    appId: 'items',
    releaseId: result.releaseId,
    grantedAt: Date.now(),
    capabilities: [],
  });
  return result.releaseId;
}

/** What a removal needs, with the session only when a test cares about it. */
function deps(where: World, session?: ReturnType<typeof openSession>): Parameters<typeof removeApplication>[0] {
  return {
    layout: where.root,
    supervisor: where.supervisor,
    states: where.states,
    journal: where.journal,
    logger: quiet,
    ...(session === undefined ? {} : { session }),
  };
}

/** Every path under a directory, sorted, for a before-and-after comparison. */
function listing(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      out.push(`${prefix}${entry.name}`);
      if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`);
    }
  };
  walk(directory, '');
  return out.sort();
}

/** The one directory in the trash, whatever its timestamp turned out to be. */
function trashed(where: World): string {
  const entries = readdirSync(where.root.trash);
  const first = entries[0];
  if (entries.length !== 1 || first === undefined) {
    throw new Error(`expected one directory in the trash, found ${entries.join(', ') || 'none'}`);
  }
  return join(where.root.trash, first);
}

/**
 * Run the compiled launcher once, against this world's root.
 *
 * `Bun.spawn` and not `spawnSync`: one of these tests has the control listener
 * running in *this* process, and a synchronous spawn holds this event loop for
 * as long as the child runs — so the child's connection would never be
 * answered and both processes would wait for each other for ever.
 */
async function command(
  where: World,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const running = Bun.spawn({
    cmd: [LAUNCHER, ...args],
    env: { ...process.env, BROAPP_DATA_DIR: where.directory },
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

describe.skipIf(!available)('describeRemoval', () => {
  test('counts what is there, and measures the data', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    const app = where.root.app('items');
    // Data, a snapshot of it, and a previous data directory: the three things
    // a person is told the size of before they agree to move them.
    mkdirSync(app.data, { recursive: true });
    writeFileSync(join(app.data, 'items.sqlite'), 'x'.repeat(4_096));
    // A snapshot directory, not a real snapshot: what is counted is how many
    // there are, and `VACUUM INTO` on four kilobytes of `x` is not a database.
    mkdirSync(join(app.snapshots, 'one'), { recursive: true });
    mkdirSync(app.dataPrev(1_700_000_000_000), { recursive: true });

    const described = describeRemoval(where.root, 'items');
    expect(described).toEqual({
      appId: 'items',
      releases: 1,
      hadSource: true,
      dataBytes: 4_096,
      snapshots: 1,
      dataPrev: 1,
    });
    expect(existsSync(app.release(releaseId))).toBe(true);
  }, 120_000);

  test('an application nobody has is not found', () => {
    const where = makeWorld();
    expect(() => describeRemoval(where.root, 'nothing')).toThrow(/no application called nothing/);
  });
});

describe.skipIf(!available)('removeApplication', () => {
  test('renames the directory into the trash with every byte inside it', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });
    writeFileSync(join(app.data, 'items.sqlite'), 'the person’s data');

    const session = openSession(join(where.directory, 'launcher'), quiet);
    session.select('items');
    // Written beside the application, so it is part of what moves.
    where.states.update('items', { releaseId, changed: ['src/shared/views.ts'] });
    const before = listing(app.dir);
    expect(before).toContain('candidate.json');

    const receipt = await removeApplication(deps(where, session), 'items');

    expect(receipt.appId).toBe('items');
    expect(receipt.trashPath).toMatch(/^trash[\\/\\\\]items-\d{4}-\d{2}-\d{2}T/);
    expect(receipt.previewStopped).toBe(false);
    expect(receipt.releases).toBe(1);
    expect(receipt.hadSource).toBe(true);
    expect(receipt.dataBytes).toBeGreaterThan(0);

    // Moved, not copied and not deleted: the same tree, byte for byte.
    expect(existsSync(app.dir)).toBe(false);
    const moved = trashed(where);
    expect(listing(moved)).toEqual(before);
    expect(readFileSync(join(moved, 'data', 'items.sqlite'), 'utf8')).toBe('the person’s data');
    expect(join(where.root.root, receipt.trashPath)).toBe(moved);

    // The launcher stops listing it, and stops pointing anything at it.
    expect(listApps(where.root, where.supervisor, where.journal)).toEqual([]);
    expect(session.get().selectedAppId).toBeNull();
    expect(where.states.get('items').releaseId).toBeNull();
    expect(where.states.get('items').changed).toEqual([]);

    // The journal keeps everything it knew, and says what happened last.
    const history = where.journal.history('items');
    expect(history[0]?.phase).toBe('removed');
    expect(history[0]?.fromRelease).toBe(releaseId);
    // Terminal, so recovery has nothing to finish.
    expect(where.journal.unfinished()).toEqual([]);
  }, 120_000);

  test('refuses while it is serving, and moves nothing', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    const app = where.root.app('items');
    await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    const before = listing(app.dir);

    let refusal: unknown = null;
    await removeApplication(deps(where), 'items').catch((cause: unknown) => {
      refusal = cause;
    });
    expect(isPublicError(refusal)).toBe(true);
    expect((refusal as { code?: string }).code).toBe('unavailable');
    expect((refusal as Error).message).toMatch(/Stop it first/);

    expect(existsSync(app.dir)).toBe(true);
    expect(listing(app.dir)).toEqual(before);
    expect(existsSync(where.root.trash)).toBe(false);
  }, 180_000);

  test('stops a running preview, and says so in the receipt', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    const app = where.root.app('items');
    const previewDir = app.preview(releaseId);
    mkdirSync(previewDir, { recursive: true });
    const preview = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: previewDir,
      mode: 'preview',
    });
    where.states.update('items', { preview, previewWasRunning: true, releaseId });

    const receipt = await removeApplication(deps(where), 'items');
    expect(receipt.previewStopped).toBe(true);
    expect(await preview.exited).not.toBeNull();
    expect(existsSync(app.dir)).toBe(false);
    // The preview's own data copy went with it: it lived inside the directory.
    expect(existsSync(join(trashed(where), 'previews'))).toBe(true);
  }, 180_000);
});

describe.skipIf(!available)('launcher.appRemove', () => {
  /** The launcher's routes over a real bridge. */
  async function startApp(where: World): Promise<Harness> {
    const app = createLauncherApp({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      states: where.states,
      gate: where.gate,
      logger: quiet,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      openBrowser: () => Promise.resolve(true),
    });
    live = await harness((bridge) => app.mount(bridge));
    return live;
  }

  test('is a write, refuses a confirmation that is not the id, and returns the receipt', async () => {
    // A write, so an agent reaching it through the MCP adapter or a workflow
    // is asked before anything moves. A person's own click is channel `user`
    // and is not.
    expect(launcherContract.operations['launcher.appRemove'].effect).toBe('write');

    const where = makeWorld();
    await build(where);
    const test = await startApp(where);
    const client = await test.connect(launcherContract);
    const app = where.root.app('items');
    const before = listing(app.dir);

    await expect(client.call('launcher.appRemove', { appId: 'items', confirm: 'item' })).rejects.toThrow(
      /Type items to confirm/,
    );
    expect(listing(app.dir)).toEqual(before);
    expect(existsSync(where.root.trash)).toBe(false);

    const receipt = await client.call('launcher.appRemove', { appId: 'items', confirm: 'items' });
    expect(receipt.appId).toBe('items');
    expect(receipt.trashPath).toContain('items-');
    expect(existsSync(app.dir)).toBe(false);
    expect(listing(trashed(where))).toEqual(before);

    const listed = await client.call('launcher.appsList', undefined);
    expect(listed.apps).toEqual([]);
    // The journal still answers about it, which is where the removal is.
    const journal = await client.call('launcher.journalList', { appId: 'items' });
    expect(journal.activations[0]?.phase).toBe('removed');
    await client.close();
  }, 180_000);

  test('an application nobody has is not found', async () => {
    const where = makeWorld();
    const test = await startApp(where);
    const client = await test.connect(launcherContract);
    await expect(
      client.call('launcher.appRemove', { appId: 'nothing', confirm: 'nothing' }),
    ).rejects.toThrow(/no application called nothing/);
    await client.close();
  }, 60_000);
});

describe.skipIf(!available)('the remove command', () => {
  test('prints what would move and refuses without --yes, then moves with it', async () => {
    const where = makeWorld();
    await build(where);
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });
    writeFileSync(join(app.data, 'items.sqlite'), 'x'.repeat(1_024));
    const before = listing(app.dir);

    const refused = await command(where, ['remove', 'items']);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('1 release');
    expect(refused.stdout).toContain('a source workspace');
    expect(refused.stdout).toContain('1024 bytes of data');
    expect(refused.stderr).toContain('refused: pass --yes to move it to trash');
    expect(listing(app.dir)).toEqual(before);

    const moved = await command(where, ['remove', 'items', '--yes']);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain('moved to');
    expect(existsSync(app.dir)).toBe(false);
    expect(listing(trashed(where))).toEqual(before);
  }, 180_000);

  test('an application nobody has is an error, and nothing is made', async () => {
    const where = makeWorld();
    const missing = await command(where, ['remove', 'nothing', '--yes']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no application called nothing');
    expect(existsSync(where.root.trash)).toBe(false);
  }, 60_000);

  test('refuses while a launcher is serving the application', async () => {
    const where = makeWorld();
    const releaseId = await build(where);
    const app = where.root.app('items');
    await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    // The control listener is how a separate process finds out: this one has a
    // supervisor of its own with no children in it, and would otherwise
    // believe nothing was running.
    control = startControl({ layout: where.root, supervisor: where.supervisor, logger: quiet });

    const refused = await command(where, ['remove', 'items', '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('being served');
    expect(existsSync(app.dir)).toBe(true);
    expect(existsSync(where.root.trash)).toBe(false);

    // And once nothing is serving, the same command works. The control file is
    // still there and still answers; what changed is the answer.
    await where.supervisor.stopAll(10_000);
    const moved = await command(where, ['remove', 'items', '--yes']);
    expect(moved.code).toBe(0);
    expect(existsSync(app.dir)).toBe(false);
  }, 180_000);
});

describe('the engineer', () => {
  test('has no tool that removes an application', () => {
    const where = makeWorld();
    const tools = engineerTools({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      states: where.states,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      logger: quiet,
    });
    const names = Object.keys(tools);
    expect(names).toContain('apps.create');
    // Not "no tool called `apps.remove`": anything that reads as removing an
    // application is the thing that must not be there.
    expect(names.filter((name) => /remove|delete|destroy|trash/i.test(name))).toEqual([]);
  });

  test('is told it may not, in its standing instructions', async () => {
    const instructions = await Bun.file(
      join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'engineer', 'instructions.ts'),
    ).text();
    expect(instructions).toMatch(/Do not ask.*remove|remove an application/i);
  });
});

describe('the trash', () => {
  test('is one directory beside the applications, and is never emptied here', () => {
    const where = makeWorld();
    expect(where.root.trash).toBe(join(where.root.root, 'trash'));
    // Nothing in the launcher removes anything from it. `prune` is where that
    // decision will be made, with a list and a `--yes` of its own.
    const sources = join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src');
    const offenders: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        const text = readFileSync(path, 'utf8');
        for (const line of text.split('\n')) {
          if (/rmSync|rm\(/.test(line) && /trash/.test(line)) offenders.push(`${entry.name}: ${line.trim()}`);
        }
      }
    };
    walk(sources);
    expect(offenders).toEqual([]);
    expect(statSync(sources).isDirectory()).toBe(true);
  });
});
