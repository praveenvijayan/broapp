/**
 * The engineer: what it may touch, what it must ask for, and what it is never
 * told.
 *
 * Two properties run through the whole file. Every action is a `guardedTool`,
 * so `source.change` and `candidate.build` wait for a person and
 * `release.activate` is refused outright in a preview. And no tool output ever
 * carries a launch URL — the model is told a preview is running, and the person
 * gets the address from a route they clicked.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAdapter } from 'broapp/ai/host';
import type { FakeStep } from 'broapp/ai/host';
import { createGate, createPendingApprovals } from 'broapp/host';
import type { Envelope, Gate } from 'broapp/host';
import { mergeContracts } from 'broapp/shared';
import { aiContract } from 'broapp/ai';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import {
  buildCandidate,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  type Journal,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout, readCurrent, setCurrent, writeGrants, type Layout } from 'broapp-autoapp/spec';

import {
  ENGINEER_INSTRUCTIONS,
  INSTRUCTION_SECTIONS,
  applyChange,
  createCandidateStates,
  diffSummary,
  engineerTools,
  readTree,
  readWorkspaceFile,
  snapshot,
  type CandidateStates,
} from 'broapp-autoapp/engineer';
import { harness, type Harness } from './harness.ts';

const packageDir = join(import.meta.dir, '..', 'packages', 'broapp-autoapp');
const launcher = join(packageDir, 'dist', 'broapp-autoapp');
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');

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
    new Response(built.stdout).text(),
    new Response(built.stderr).text(),
  ]);
  return code === 0 ? null : stderr.trim();
}

const failure = await compile();
if (failure !== null) {
  console.warn(`[autoapp-engineer] skipped: the launcher would not build\n${failure}`);
}
const available = failure === null;

const quiet = { warn: () => undefined, error: () => undefined };

/** Everything one test built. */
interface World {
  readonly root: Layout;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly store: RunStore;
  readonly states: CandidateStates;
  readonly gate: Gate;
  readonly tools: ReturnType<typeof engineerTools>;
  readonly directory: string;
}

let world: World | null = null;
let live: Harness | null = null;

/** Inside the repository, so the workspace can resolve `broapp`. */
const runRoot = join(import.meta.dir, '.autoapp-run');

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

/** A launcher root with the fixture as one application's workspace. */
function makeWorld(options: { mode?: 'live' | 'preview' } = {}): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'eng-'));
  const root = layout(directory);
  const app = root.app('items');
  mkdirSync(app.dir, { recursive: true });
  cpSync(fixture, app.source, { recursive: true });

  const store = createRunStore(join(directory, 'launcher'), quiet);
  const gate = createGate({
    appId: 'launcher',
    releaseId: 'launcher',
    confirmTimeoutMs: 5_000,
    recorder: store.recorder(),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    logger: quiet,
  });
  const journal = openJournal(root.journal);
  const supervisor = createSupervisor({ execPath: launcher, logger: quiet });
  const states = createCandidateStates();
  const tools = engineerTools({ layout: root, supervisor, journal, gate, states, logger: quiet });

  const built: World = { root, journal, supervisor, store, states, gate, tools, directory };
  world = built;
  return built;
}

/** An envelope from the AI channel, with somebody to ask. */
function asEngineer(approvals: ReturnType<typeof createPendingApprovals>, id: string): Envelope {
  return { requestId: id, channel: 'ai', caller: 'ai:test', approver: approvals };
}

/** Call one tool, answering its question if it asks one. */
async function callTool(
  where: World,
  name: string,
  input: unknown,
  options: { approve?: boolean; id?: string } = {},
): Promise<unknown> {
  const approvals = createPendingApprovals(quiet);
  const tool = where.tools[name];
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  const id = options.id ?? `run-1:${name}-${String(Math.random()).slice(2, 8)}`;
  const running = tool.execute(input, asEngineer(approvals, id), new AbortController().signal);
  if (options.approve !== undefined) {
    while (approvals.pending.length === 0) await Bun.sleep(5);
    const question = approvals.pending[0];
    if (question === undefined) throw new Error('nothing to answer');
    approvals.answer({
      requestId: question.requestId,
      approved: options.approve,
      releaseId: question.releaseId,
      argumentsHash: question.argumentsHash,
    });
  }
  return await running;
}

describe('the workspace', () => {
  test('refuses a path that leads outside it', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;

    for (const path of ['../secrets.txt', '/etc/passwd', 'src/../../escape.ts']) {
      expect(() => readWorkspaceFile(source, path)).toThrow();
    }
    // A symlink pointing out is refused too: containment is about where the
    // name leads, not only about how it is spelled.
    writeFileSync(join(where.directory, 'outside.txt'), 'not yours');
    symlinkSync(join(where.directory, 'outside.txt'), join(source, 'src', 'link.ts'));
    expect(() => readWorkspaceFile(source, 'src/link.ts')).toThrow(/outside/);
  });

  test('lists only what an engineer may see', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    mkdirSync(join(source, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'x', 'index.js'), 'nope');

    const paths = readTree(source).map((entry) => entry.path);
    expect(paths).toContain('autoapp.json');
    expect(paths).toContain('src/shared/contract.ts');
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
  });

  test('refuses to write outside src/ and autoapp.json', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    expect(() =>
      applyChange(source, [{ path: 'package.json', content: '{}' }], 'no'),
    ).toThrow(/may be changed/);
    expect(() => applyChange(source, [{ path: '../x.ts', content: '' }], 'no')).toThrow();
  });

  test('with git present, a change is committed', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    Bun.spawnSync({ cmd: ['git', 'init', '--quiet'], cwd: source, stdout: 'ignore', stderr: 'ignore' });

    const applied = applyChange(source, [{ path: 'src/note.ts', content: 'export const a = 1;\n' }], 'add a note');
    expect(applied.undo).toBe('git');
    expect(applied.changed).toEqual(['src/note.ts']);
    const log = Bun.spawnSync({ cmd: ['git', 'log', '--oneline'], cwd: source, stdout: 'pipe', stderr: 'ignore' });
    expect(new TextDecoder().decode(log.stdout)).toContain('add a note');
  });

  test('without a repository of its own, the previous contents are kept', () => {
    const where = makeWorld();
    const app = where.root.app('items');
    // No `git init` in the workspace itself. It sits inside this repository's
    // checkout, which is exactly the case that must *not* count as having git:
    // committing there would put the change in somebody else's history.
    const before = readFileSync(join(app.source, 'autoapp.json'), 'utf8');
    const applied = applyChange(app.source, [{ path: 'autoapp.json', content: '{}' }], 'break it');

    expect(applied.undo).toBe('source-history');
    const kept = readdirSync(app.sourceHistory);
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(app.sourceHistory, kept[0] ?? '', 'autoapp.json'), 'utf8')).toBe(before);
  });

  test('the diff says what changed', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    const before = snapshot(source);
    applyChange(source, [{ path: 'src/added.ts', content: 'export const a = 1;\n' }], 'add');
    const summary = diffSummary(before, snapshot(source));
    expect(summary).toContain('+++ src/added.ts');
  });
});

describe.skipIf(!available)('the tools', () => {
  test('reading needs nobody, changing asks first', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);

    // A read runs with nobody to ask.
    const spec = (await callTool(where, 'spec.read', { appId: 'items' })) as {
      manifest: { appId: string };
    };
    expect(spec.manifest.appId).toBe('items');

    // A change waits, and a declined change leaves the file alone.
    const before = readFileSync(join(app.source, 'autoapp.json'), 'utf8');
    await expect(
      callTool(
        where,
        'source.change',
        { appId: 'items', message: 'break it', changes: [{ path: 'autoapp.json', content: '{}' }] },
        { approve: false },
      ),
    ).rejects.toThrow(/rejected|not approved/);
    expect(readFileSync(join(app.source, 'autoapp.json'), 'utf8')).toBe(before);

    // Approved, it goes through.
    const changed = (await callTool(
      where,
      'source.change',
      {
        appId: 'items',
        message: 'add a comment',
        changes: [{ path: 'src/note.ts', content: '// hello\n' }],
      },
      { approve: true },
    )) as { changed: string[] };
    expect(changed.changed).toEqual(['src/note.ts']);
    expect(existsSync(join(app.source, 'src', 'note.ts'))).toBe(true);
  }, 60_000);

  test('a broken build returns its problems, and a fix builds', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const path = join(app.source, 'src', 'shared', 'contract.ts');
    const good = readFileSync(path, 'utf8');
    writeFileSync(path, good.replace("      effect: 'external',\n", ''));

    const failed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as {
      ok: boolean;
      problems: { stage: string; message: string }[];
    };
    expect(failed.ok).toBe(false);
    // Verbatim, so the model can act on it.
    expect(failed.problems.some((problem) => problem.message.includes('items.ping'))).toBe(true);

    writeFileSync(path, good);
    const fixed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as {
      ok: boolean;
      releaseId: string;
    };
    expect(fixed.ok).toBe(true);
    expect(fixed.releaseId).toMatch(/^[0-9a-f]{32}$/);
  }, 60_000);

  test('a preview runs on a copy, and refuses to reach outside', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    mkdirSync(app.data, { recursive: true });

    // One row in the live data, so the copy has something to differ from.
    const liveChild = await where.supervisor.start({
      appId: 'items',
      releaseDir: app.release(built.releaseId),
      releaseId: built.releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    const { connectToChild } = await import('broapp-autoapp/launcher');
    const liveClient = await connectToChild(liveChild.url);
    await liveClient.call('items.add', { label: 'live only' });
    await liveClient.close();
    await liveChild.shutdown(5_000);

    const started = await callTool(
      where,
      'candidate.preview',
      { appId: 'items', releaseId: built.releaseId },
      { approve: true },
    );
    // The model is told whether, not where.
    expect(started).toEqual({ ok: true });
    expect(JSON.stringify(started)).not.toContain('127.0.0.1');

    const preview = where.states.get('items').preview;
    if (preview === null) throw new Error('no preview started');
    const previewClient = await connectToChild(preview.url);
    // The copy carries the live row, and a write here stays in the copy.
    expect((await previewClient.call('items.list')) as { count: number }).toMatchObject({ count: 1 });
    await previewClient.call('items.add', { label: 'preview only' });
    // Reaching outside is refused for everybody in a preview.
    await expect(previewClient.call('items.ping')).rejects.toThrow();
    await previewClient.close();

    await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });

    // The live data never saw the preview's write.
    const db = new Database(join(app.data, 'items.sqlite'), { readonly: true });
    try {
      expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM items').get()?.n).toBe(1);
    } finally {
      db.close();
    }
  }, 90_000);

  test('a failing acceptance example is reported', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const manifestPath = join(app.source, 'autoapp.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      acceptance: { id: string; title: string; steps: unknown[] }[];
    };
    manifest.acceptance = [
      {
        id: 'impossible',
        title: 'Expects what is not so',
        steps: [{ route: 'items.list', input: null, expect: { items: [], count: 99 } }],
      },
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    mkdirSync(app.data, { recursive: true });

    await callTool(
      where,
      'candidate.preview',
      { appId: 'items', releaseId: built.releaseId },
      { approve: true },
    );
    const checked = (await callTool(where, 'candidate.check', {
      appId: 'items',
      releaseId: built.releaseId,
    })) as { results: { id: string; passed: boolean; detail?: string }[] };

    expect(checked.results).toHaveLength(1);
    expect(checked.results[0]?.passed).toBe(false);
    expect(checked.results[0]?.detail).toContain('count');
    await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });
  }, 90_000);

  test('explaining a candidate reports facts, not prose', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const first = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!first.ok) throw new Error(JSON.stringify(first.problems));
    setCurrent(where.root, 'items', first.releaseId);

    // Add a route, and rebuild.
    const path = join(app.source, 'src', 'shared', 'contract.ts');
    const source = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      source.replace(
        "    'items.ping': {",
        `    'items.count': {
      effect: 'read',
      summary: 'How many items there are.',
      input: s.void(),
      output: s.object({ count: s.number() }),
    },
    'items.ping': {`,
      ),
    );
    const hostPath = join(app.source, 'src', 'host', 'app.ts');
    const host = readFileSync(hostPath, 'utf8');
    writeFileSync(
      hostPath,
      host.replace(
        "  app.operation('items.ping', () => ({ ok: true }));",
        `  app.operation('items.count', () => ({ count: store.count() }));
  app.operation('items.ping', () => ({ ok: true }));`,
      ),
    );

    const second = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!second.ok) throw new Error(JSON.stringify(second.problems));

    const facts = (await callTool(where, 'candidate.explain', {
      appId: 'items',
      releaseId: second.releaseId,
    })) as { routesAdded: string[]; routesRemoved: string[]; schemaVersionTo: number };
    expect(facts.routesAdded).toEqual(['items.count']);
    expect(facts.routesRemoved).toEqual([]);
    expect(facts.schemaVersionTo).toBe(3);
  }, 90_000);

  test('activating is refused in a preview and confirmed in a live launcher', async () => {
    // A launcher whose own gate is in preview mode: an `external` tool is
    // refused for every channel, without anybody being asked.
    const previewing = makeWorld({ mode: 'preview' });
    const built = await buildCandidate({ layout: previewing.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    writeGrants(previewing.root, 'items', {
      appId: 'items',
      releaseId: built.releaseId,
      grantedAt: Date.now(),
      capabilities: [],
    });
    await expect(
      callTool(previewing, 'release.activate', { appId: 'items', releaseId: built.releaseId }),
    ).rejects.toThrow(/preview/);
    await previewing.supervisor.stopAll(5_000);
    previewing.journal.close();
    previewing.store.close();
    rmSync(previewing.directory, { recursive: true, force: true });
    world = null;

    // A live launcher asks, and then activates.
    const where = makeWorld();
    const app = where.root.app('items');
    const release = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!release.ok) throw new Error(JSON.stringify(release.problems));
    writeGrants(where.root, 'items', {
      appId: 'items',
      releaseId: release.releaseId,
      grantedAt: Date.now(),
      capabilities: [],
    });
    mkdirSync(app.data, { recursive: true });

    const result = (await callTool(
      where,
      'release.activate',
      { appId: 'items', releaseId: release.releaseId },
      { approve: true, id: 'run-activate:c1' },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(readCurrent(where.root, 'items')).toBe(release.releaseId);

    // The run store records it against the channel it arrived on.
    const recorded = where.store.getRun('run-activate');
    expect(recorded?.run.channel).toBe('ai');
    expect(recorded?.steps.some((step) => step.route === 'release.activate')).toBe(true);
  }, 90_000);

  test('no tool output ever carries a launch URL', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    mkdirSync(app.data, { recursive: true });

    const outputs: unknown[] = [];
    outputs.push(await callTool(where, 'spec.read', { appId: 'items' }));
    outputs.push(await callTool(where, 'source.list', { appId: 'items' }));
    outputs.push(await callTool(where, 'source.read', { appId: 'items', path: 'autoapp.json' }));
    outputs.push(
      await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true }),
    );
    outputs.push(
      await callTool(
        where,
        'candidate.preview',
        { appId: 'items', releaseId: built.releaseId },
        { approve: true },
      ),
    );
    outputs.push(
      await callTool(where, 'candidate.check', { appId: 'items', releaseId: built.releaseId }),
    );
    outputs.push(
      await callTool(where, 'candidate.explain', { appId: 'items', releaseId: built.releaseId }),
    );

    const everything = JSON.stringify(outputs);
    // A launch URL, a token, and the launcher root's own path.
    expect(everything).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(everything).not.toContain('?bt=');
    expect(everything).not.toContain(where.directory);
    await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });
  }, 90_000);
});

describe.skipIf(!available)('the launcher tab', () => {
  const merged = mergeContracts(launcherContract, aiContract);

  /** The launcher's tab over a real bridge, with a model that reaches nothing. */
  async function start(script: readonly FakeStep[] = []): Promise<{
    harness: Harness;
    where: World;
    adapter: ReturnType<typeof createFakeAdapter>;
  }> {
    const where = makeWorld();
    const adapter = createFakeAdapter({ script });
    const tab = createLauncherTab({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      dataDir: join(where.directory, 'launcher'),
      store: where.store,
      providers: [adapter],
      fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), {
        preconnect: () => undefined,
      }) as typeof fetch,
      logger: quiet,
    });
    live = await harness((bridge) => tab.mount(bridge));
    return { harness: live, where, adapter };
  }

  test('lists applications and opens one, handing the tab its address', async () => {
    const { harness: test, where } = await start();
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    mkdirSync(where.root.app('items').data, { recursive: true });

    const client = await test.connect(merged);
    const listed = await client.call('launcher.appsList', undefined);
    expect(listed.apps.map((app) => app.appId)).toEqual(['items']);
    expect(listed.apps[0]?.serving).toBe(false);

    const opened = await client.call('launcher.appOpen', { appId: 'items' });
    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?bt=/);
    expect((await client.call('launcher.appsList', undefined)).apps[0]?.serving).toBe(true);

    expect(await client.call('launcher.appStop', { appId: 'items' })).toEqual({ stopped: true });
    await client.close();
  }, 90_000);

  test('a grant about a release nobody is being shown is refused', async () => {
    const { harness: test, where } = await start();
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);

    const client = await test.connect(merged);
    await expect(
      client.call('launcher.grantsSet', {
        appId: 'items',
        // A release that is not what the person was shown.
        releaseId: 'f'.repeat(32),
        capabilities: [],
      }),
    ).rejects.toThrow(/changed since/);

    // The one they were shown is accepted.
    expect(
      await client.call('launcher.grantsSet', {
        appId: 'items',
        releaseId: built.releaseId,
        capabilities: [],
      }),
    ).toEqual({ ok: true });
    await client.close();
  }, 90_000);

  test('activating from the tab is the person’s own click, with no confirmation', async () => {
    const { harness: test, where } = await start();
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    writeGrants(where.root, 'items', {
      appId: 'items',
      releaseId: built.releaseId,
      grantedAt: Date.now(),
      capabilities: [],
    });
    mkdirSync(where.root.app('items').data, { recursive: true });

    const client = await test.connect(merged);
    // No approver anywhere: a `write` on channel `user` needs none.
    const result = await client.call('launcher.activate', {
      appId: 'items',
      releaseId: built.releaseId,
    });
    expect(result.ok).toBe(true);
    expect(readCurrent(where.root, 'items')).toBe(built.releaseId);

    const runs = where.store.listRuns({ channels: ['user'] });
    expect(runs.some((run) => run.summary === 'launcher.activate')).toBe(true);
    await client.close();
  }, 90_000);

  test('the engineer’s tools are offered to the model, and are all guarded', async () => {
    const { harness: test, where } = await start([{ kind: 'text', chunks: ['hello'] }]);
    void where;
    const client = await test.connect(merged);
    // It starts at all, which is what proves every tool carries the brand:
    // `createAi` refuses an unbranded one with a TypeError.
    expect(await client.call('ai.settingsGet', undefined)).toMatchObject({ configured: false });
    await client.close();
  }, 60_000);
});

describe('the engineer’s instructions', () => {
  test('say all five things', () => {
    for (const section of INSTRUCTION_SECTIONS) {
      expect(ENGINEER_INSTRUCTIONS).toContain(section);
    }
    // The sentence the prompt requires, compared without its line wrapping.
    const flat = ENGINEER_INSTRUCTIONS.replace(/\s+/g, ' ');
    expect(flat).toContain(
      'this change runs on your machine with the same permissions as the application; the preview uses a copy of your data',
    );
    // And what it must never call it.
    expect(ENGINEER_INSTRUCTIONS).toContain('Do not call it sandboxed');
  });

  test('are under sixty lines, so they are read', () => {
    expect(ENGINEER_INSTRUCTIONS.split('\n').length).toBeLessThanOrEqual(60);
  });
});
