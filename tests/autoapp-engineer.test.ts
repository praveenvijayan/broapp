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
  designTopic,
  applyEdits,
  createCandidateStates,
  diffSummary,
  engineerTools,
  readTree,
  readWorkspaceFile,
  snapshot,
  type CandidateStates,
} from 'broapp-autoapp/engineer';
import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { STARTER, STARTER_VERSIONS } from './autoapp-template.ts';
import { harness, type Harness } from './harness.ts';
import { pageCost } from '../packages/broapp-autoapp/src/launcher/ui/CandidatePanel.tsx';

/** The compiled binary every child in this file is started from. */
const launcher = LAUNCHER;
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');

const failure = await ensureLauncher();
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
/** Every URL the launcher asked to open in a browser, per test. */
let openedUrls: string[] = [];

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
  const tools = engineerTools({
    layout: root,
    supervisor,
    journal,
    gate,
    states,
    logger: quiet,
    template: STARTER,
    versions: STARTER_VERSIONS,
    // Nothing in this file creates an application, and nothing in it may reach
    // a registry or somebody's git configuration.
    install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
    initGit: () => false,
  });

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

  test('one hunk changes exactly what it names', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    const path = join(source, 'src', 'shared', 'views.ts');
    const before = readFileSync(path, 'utf8');

    const applied = applyEdits(
      source,
      [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }],
      'rename a column',
    );
    expect(applied.changed).toEqual(['src/shared/views.ts']);
    const after = readFileSync(path, 'utf8');
    expect(after).toContain("header: 'What it is'");
    expect(after).toBe(before.replace("header: 'Label'", "header: 'What it is'"));
  });

  test('two hunks on one file apply in order to the same buffer', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    writeFileSync(join(source, 'src', 'seq.ts'), 'const a = 1;\nconst b = 2;\n');

    applyEdits(
      source,
      [
        { path: 'src/seq.ts', find: 'const a = 1;', replace: 'const a = 10;' },
        // Only matches what the first hunk wrote, so this passes only if the
        // second hunk sees the first one's result.
        { path: 'src/seq.ts', find: 'const a = 10;\nconst b = 2;', replace: 'const a = 10;\nconst b = 20;' },
      ],
      'two hunks',
    );
    expect(readFileSync(join(source, 'src', 'seq.ts'), 'utf8')).toBe('const a = 10;\nconst b = 20;\n');
  });

  test('a find that is not there names the file and the text', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    expect(() =>
      applyEdits(
        source,
        [{ path: 'src/shared/views.ts', find: 'header: "nothing like this"', replace: 'x' }],
        'no',
      ),
    ).toThrow(/not found in src\/shared\/views\.ts: header/);
  });

  test('a find that occurs twice says how many and asks for more context', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    writeFileSync(join(source, 'src', 'twice.ts'), 'const x = 1;\nconst x = 1;\n');
    expect(() =>
      applyEdits(source, [{ path: 'src/twice.ts', find: 'const x = 1;', replace: 'const x = 2;' }], 'no'),
    ).toThrow(/ambiguous in src\/twice\.ts: 2 matches, include more context/);
  });

  test('one bad hunk among three leaves every file untouched', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    const views = join(source, 'src', 'shared', 'views.ts');
    const manifest = join(source, 'autoapp.json');
    const viewsBefore = readFileSync(views, 'utf8');
    const manifestBefore = readFileSync(manifest, 'utf8');

    expect(() =>
      applyEdits(
        source,
        [
          { path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'Renamed'" },
          { path: 'autoapp.json', find: '"schemaVersion"', replace: '"schemaVersion"' },
          { path: 'src/shared/views.ts', find: 'this text is not in the file', replace: 'x' },
        ],
        'one of these is wrong',
      ),
    ).toThrow(/not found/);

    // Every hunk is checked before any file is written, so a set either all
    // lands or none does. A half-applied edit would leave the model working out
    // which half.
    expect(readFileSync(views, 'utf8')).toBe(viewsBefore);
    expect(readFileSync(manifest, 'utf8')).toBe(manifestBefore);
    expect(existsSync(where.root.app('items').sourceHistory)).toBe(false);
  });

  test('a hunk refuses a path outside src/ and autoapp.json, and a file that is not there', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    expect(() =>
      applyEdits(source, [{ path: 'package.json', find: '{', replace: '{' }], 'no'),
    ).toThrow(/may be changed/);
    expect(() =>
      applyEdits(source, [{ path: '../escape.ts', find: 'a', replace: 'b' }], 'no'),
    ).toThrow();
    expect(() =>
      applyEdits(source, [{ path: 'src/never-written.ts', find: 'a', replace: 'b' }], 'no'),
    ).toThrow(/is not there; use source.change to create a file/);
  });

  test('an edit is committed with git, and kept in history without it', () => {
    const withGit = makeWorld();
    const gitSource = withGit.root.app('items').source;
    Bun.spawnSync({ cmd: ['git', 'init', '--quiet'], cwd: gitSource, stdout: 'ignore', stderr: 'ignore' });
    const committed = applyEdits(
      gitSource,
      [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'Renamed'" }],
      'rename the column',
    );
    expect(committed.undo).toBe('git');
    const log = Bun.spawnSync({ cmd: ['git', 'log', '--oneline'], cwd: gitSource, stdout: 'pipe', stderr: 'ignore' });
    expect(new TextDecoder().decode(log.stdout)).toContain('rename the column');

    const noGit = makeWorld();
    const app = noGit.root.app('items');
    const before = readFileSync(join(app.source, 'src', 'shared', 'views.ts'), 'utf8');
    const kept = applyEdits(
      app.source,
      [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'Renamed'" }],
      'rename the column',
    );
    expect(kept.undo).toBe('source-history');
    const versions = readdirSync(app.sourceHistory);
    expect(versions).toHaveLength(1);
    expect(
      readFileSync(join(app.sourceHistory, versions[0] ?? '', 'src', 'shared', 'views.ts'), 'utf8'),
    ).toBe(before);
  });

  test('an exact match wins over one that ignores indentation', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    const path = join(source, 'src', 'mixed.ts');
    // Two lines that differ only in how they are indented. Ignoring the
    // whitespace would make this ambiguous; matching exactly does not.
    writeFileSync(path, '  const a = 1;\n\tconst a = 1;\n');

    const applied = applyEdits(
      source,
      [{ path: 'src/mixed.ts', find: '  const a = 1;', replace: '  const a = 2;' }],
      'exact',
    );
    expect(applied.matchedBy).toEqual(['exact']);
    expect(readFileSync(path, 'utf8')).toBe('  const a = 2;\n\tconst a = 1;\n');
  });

  test('a hunk one space out matches, and the file keeps its own indentation', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    const path = join(source, 'src', 'shared', 'views.ts');

    const applied = applyEdits(
      source,
      [
        {
          path: 'src/shared/views.ts',
          // Thirteen spaces where the file has twelve: report 08b watched a
          // real model do exactly this to text it had just been given.
          find: "             { id: 'label', header: 'Label', path: 'label' },",
          replace: "             { id: 'label', header: 'What it is', path: 'label' },",
        },
      ],
      'rename a column',
    );
    expect(applied.matchedBy).toEqual(['indent']);
    expect(readFileSync(path, 'utf8')).toContain(
      "\n            { id: 'label', header: 'What it is', path: 'label' },\n",
    );
  });

  test('a replacement that adds a line takes the matched block’s indentation', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    const path = join(source, 'src', 'shared', 'views.ts');

    applyEdits(
      source,
      [
        {
          path: 'src/shared/views.ts',
          find: "             { id: 'label', header: 'Label', path: 'label' },",
          replace:
            "             { id: 'label', header: 'Label', path: 'label' },\n" +
            "             { id: 'note', header: 'Note', path: 'note' },",
        },
      ],
      'add a column',
    );
    const after = readFileSync(path, 'utf8');
    expect(after).toContain("\n            { id: 'note', header: 'Note', path: 'note' },\n");
    expect(after).not.toContain("\n             { id: 'note'");
  });

  test('two matches that differ only in indentation are ambiguous, with their lines', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    writeFileSync(join(source, 'src', 'twice.ts'), '  foo();\n  bar();\n\tfoo();\n\tbar();\n');

    expect(() =>
      applyEdits(
        source,
        [{ path: 'src/twice.ts', find: 'foo();\nbar();', replace: 'foo();\nbaz();' }],
        'no',
      ),
    ).toThrow(/ambiguous in src\/twice\.ts: 2 matches, include more context \(lines 1, 3\)/);
  });

  test('a hunk that matches nowhere quotes the nearest real line', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    let message = '';
    try {
      applyEdits(
        source,
        [
          {
            path: 'src/shared/views.ts',
            // A typo, not a whitespace slip, so neither pass can match it.
            find: "{ id: 'label', header: 'Lable', path: 'label' },",
            replace: 'x',
          },
        ],
        'no',
      );
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain('not found in src/shared/views.ts');
    expect(message).toMatch(/Closest line \d+: ".*header: 'Label'.*"/);
  });

  test('a file indented with tabs stays indented with tabs', () => {
    const where = makeWorld();
    const source = where.root.app('items').source;
    const path = join(source, 'src', 'tabs.ts');
    writeFileSync(path, 'function f() {\n\t\tconst a = 1;\n}\n');

    const applied = applyEdits(
      source,
      [{ path: 'src/tabs.ts', find: '  const a = 1;', replace: '  const a = 2;' }],
      'spaces in, tabs out',
    );
    expect(applied.matchedBy).toEqual(['indent']);
    expect(readFileSync(path, 'utf8')).toBe('function f() {\n\t\tconst a = 2;\n}\n');
  });

  test('report 08b’s three whitespace failures now apply', () => {
    // The report does not quote the hunks, so these are the equivalent it
    // describes: seven spaces where the file has six, and a `s.optional(…)`
    // line added inside an object. All three in one call, as the model sent
    // them, and all three have to land or none does.
    const where = makeWorld();
    const source = where.root.app('items').source;
    const contract = join(source, 'src', 'shared', 'contract.ts');
    const views = join(source, 'src', 'shared', 'views.ts');

    const applied = applyEdits(
      source,
      [
        {
          path: 'src/shared/contract.ts',
          find: '   label: s.string(),\n   createdAt: s.number(),',
          replace:
            '   label: s.string(),\n   done: s.optional(s.boolean()),\n   createdAt: s.number(),',
        },
        {
          path: 'src/shared/contract.ts',
          find: "       effect: 'write',\n       summary: 'Add one item.',",
          replace: "       effect: 'write',\n       summary: 'Add one item, with a flag.',",
        },
        {
          path: 'src/shared/views.ts',
          find: "             { id: 'label', header: 'Label', path: 'label' },",
          replace: "             { id: 'label', header: 'What it is', path: 'label' },",
        },
      ],
      'tags and archive',
    );

    expect(applied.matchedBy).toEqual(['indent', 'indent', 'indent']);
    const after = readFileSync(contract, 'utf8');
    expect(after).toContain('\n  done: s.optional(s.boolean()),\n');
    expect(after).toContain("\n      summary: 'Add one item, with a flag.',\n");
    expect(readFileSync(views, 'utf8')).toContain(
      "\n            { id: 'label', header: 'What it is', path: 'label' },\n",
    );
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
  test('apps.list answers "which application" without anybody being asked', async () => {
    const where = makeWorld();
    type Row = {
      appId: string;
      name: string;
      currentRelease: string | null;
      serving: boolean;
      schemaVersion: number | null;
    };

    // A read, so no approver is offered and none is needed.
    const before = (await callTool(where, 'apps.list', undefined)) as { apps: Row[] };
    expect(before.apps.map((row) => row.appId)).toEqual(['items']);
    expect(before.apps[0]?.currentRelease).toBeNull();

    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);

    const after = (await callTool(where, 'apps.list', undefined)) as { apps: Row[] };
    expect(after.apps[0]).toEqual({
      appId: 'items',
      name: built.spec.manifest.name,
      currentRelease: built.releaseId,
      serving: false,
      schemaVersion: null,
    });
    // The same rows the tab gets, minus the process id: a number a model
    // cannot use is a number it will try to use.
    expect(JSON.stringify(after)).not.toContain('pid');
  }, 90_000);

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

  test('an edit asks first, then lands, and the release it builds is a new one', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const first = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!first.ok) throw new Error(JSON.stringify(first.problems));
    setCurrent(where.root, 'items', first.releaseId);

    const views = join(app.source, 'src', 'shared', 'views.ts');
    const before = readFileSync(views, 'utf8');

    // Declined, nothing moves.
    await expect(
      callTool(
        where,
        'source.edit',
        {
          appId: 'items',
          message: 'rename a column',
          hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }],
        },
        { approve: false },
      ),
    ).rejects.toThrow(/rejected|not approved/);
    expect(readFileSync(views, 'utf8')).toBe(before);

    const applied = (await callTool(
      where,
      'source.edit',
      {
        appId: 'items',
        message: 'rename a column',
        hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }],
      },
      { approve: true },
    )) as { changed: string[]; diff: string };
    expect(applied.changed).toEqual(['src/shared/views.ts']);
    expect(applied.diff).toContain('src/shared/views.ts');

    // A views-only change reaches a release now, which is the other half of
    // this prompt: before it, this hashed to the release it came from.
    const second = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as {
      ok: boolean;
      releaseId: string;
    };
    expect(second.ok).toBe(true);
    expect(second.releaseId).not.toBe(first.releaseId);
  }, 90_000);

  test('source.change refuses to rewrite a large file and names source.edit', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const long = `${Array.from({ length: 80 }, (_, i) => `// line ${String(i)}`).join('\n')}\n`;

    // Creating a file is unlimited: there is no smaller way to say it.
    await callTool(
      where,
      'source.change',
      { appId: 'items', message: 'add a long file', changes: [{ path: 'src/long.ts', content: long }] },
      { approve: true },
    );
    expect(readFileSync(join(app.source, 'src', 'long.ts'), 'utf8')).toBe(long);

    // Replacing it is not.
    await expect(
      callTool(
        where,
        'source.change',
        {
          appId: 'items',
          message: 'rewrite the long file',
          changes: [{ path: 'src/long.ts', content: '// one line\n' }],
        },
        { approve: true },
      ),
    ).rejects.toThrow(/source\.edit/);
    expect(readFileSync(join(app.source, 'src', 'long.ts'), 'utf8')).toBe(long);

    // A small existing file is still fair game.
    await callTool(
      where,
      'source.change',
      { appId: 'items', message: 'shorten it', changes: [{ path: 'src/short.ts', content: '// a\n' }] },
      { approve: true },
    );
    await callTool(
      where,
      'source.change',
      { appId: 'items', message: 'shorten it again', changes: [{ path: 'src/short.ts', content: '// b\n' }] },
      { approve: true },
    );
    expect(readFileSync(join(app.source, 'src', 'short.ts'), 'utf8')).toBe('// b\n');
  }, 90_000);

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
    expect(started).toMatchObject({ ok: true, dataReset: true, replacedPreviewId: null });
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
    })) as {
      results: { id: string; passed: boolean; detail?: string }[];
      coverage: { host: number; structure: number };
      unverified: string;
    };

    expect(checked.results).toHaveLength(1);
    expect(checked.results[0]?.passed).toBe(false);
    expect(checked.results[0]?.detail).toContain('count');
    // What the check covered, and the one thing no check can: the rendered page.
    expect(checked.coverage).toEqual({ host: 1, structure: 0 });
    expect(checked.unverified).toMatch(/neither renders a page/);
    // The check ran over IPC, so the preview's one-time launch token is still
    // there for the person's Open preview. This is the first visit.
    const { connectToChild } = await import('broapp-autoapp/launcher');
    const preview = where.states.get('items').preview;
    if (preview === null) throw new Error('the preview should be running');
    const visitor = await connectToChild(preview.url);
    await visitor.close();
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
    })) as {
      routesAdded: string[];
      routesRemoved: string[];
      schemaVersionTo: number;
      pageBytes: number | null;
      pageBytesBefore: number | null;
    };
    expect(facts.routesAdded).toEqual(['items.count']);
    expect(facts.routesRemoved).toEqual([]);
    expect(facts.schemaVersionTo).toBe(3);
    // The page's cost, before and after, read from the two releases' own pages.
    expect(facts.pageBytes).toBe(readFileSync(join(app.release(second.releaseId), 'page.html')).length);
    expect(facts.pageBytesBefore).toBe(readFileSync(join(app.release(first.releaseId), 'page.html')).length);
  }, 90_000);

  test('the candidate panel shows the page cost only when it moved more than 2%', () => {
    expect(pageCost(1_000_000, 1_000_000)).toBeNull();
    expect(pageCost(1_020_000, 1_000_000)).toBeNull();
    expect(pageCost(1_153_434, 1_120_000)).toBe('page 1.1 MB (+3%)');
    expect(pageCost(270_000, 300_000)).toBe('page 264 KB (-10%)');
    expect(pageCost(300_000, null)).toBeNull();
  });

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
    openedUrls = [];
    const tab = createLauncherTab({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      dataDir: join(where.directory, 'launcher'),
      store: where.store,
      template: STARTER,
      versions: STARTER_VERSIONS,
      install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
      initGit: () => false,
      providers: [adapter],
      fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), {
        preconnect: () => undefined,
      }) as typeof fetch,
      logger: quiet,
      // A suite must not open browser tabs. What is opened is checked instead.
      openBrowser: async (url) => {
        openedUrls.push(url);
        return true;
      },
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

    // The tab is opened by the host, with the launch URL the first time and
    // the bare origin after that: the token has burnt, the cookie remains.
    expect(await client.call('launcher.appOpen', { appId: 'items' })).toEqual({ opened: true });
    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?bt=/);
    expect((await client.call('launcher.appsList', undefined)).apps[0]?.serving).toBe(true);
    expect(await client.call('launcher.appOpen', { appId: 'items' })).toEqual({ opened: true });
    expect(openedUrls).toHaveLength(2);
    expect(openedUrls[1]).toBe(`${new URL(openedUrls[0] ?? '').origin}/`);

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
    // The activated release is a new child on a new port, so the host opens
    // it: the tab that showed the previous one cannot be reloaded into it.
    expect(result.opened).toBe(true);
    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?bt=/);

    const runs = where.store.listRuns({ channels: ['user'] });
    expect(runs.some((run) => run.summary === 'launcher.activate')).toBe(true);
    await client.close();
  }, 90_000);

  test('a model composing hunks reaches a release', async () => {
    // The whole point of `source.edit`: the model's tool call is proportional
    // to the change rather than to the file. Scripted here so the shape is
    // pinned; report 08b's demo is where a real model composes them.
    const { harness: test, where } = await start([
      {
        kind: 'tool',
        name: 'source.edit',
        input: {
          appId: 'items',
          message: 'rename the label column',
          hunks: [
            { path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" },
          ],
        },
        then: [{ kind: 'text', chunks: ['renamed it'] }],
      },
    ]);
    const first = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!first.ok) throw new Error(JSON.stringify(first.problems));
    setCurrent(where.root, 'items', first.releaseId);

    const client = await test.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });

    const events: { type: string; callId?: string; denied?: boolean }[] = [];
    let finished = false;
    await client.subscribe(
      'ai.chat',
      { runId: 'run-abcdefgh', message: 'rename the column', refs: [], history: [] },
      {
        onEvent: (event) => {
          events.push(event as { type: string });
          if (event.type === 'done' || event.type === 'error') finished = true;
        },
        onError: () => {
          finished = true;
        },
      },
    );

    // A write, so it waits for the person exactly as a click would.
    while (!events.some((event) => event.type === 'confirm')) await Bun.sleep(10);
    const asked = events.find((event) => event.type === 'confirm');
    await client.call('ai.chatConfirm', {
      runId: 'run-abcdefgh',
      callId: asked?.callId ?? '',
      approve: true,
    });
    while (!finished) await Bun.sleep(10);
    expect(events.find((event) => event.type === 'tool-result')?.denied).toBeUndefined();
    await client.close();

    const views = readFileSync(
      join(where.root.app('items').source, 'src', 'shared', 'views.ts'),
      'utf8',
    );
    expect(views).toContain("header: 'What it is'");

    const second = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.releaseId).not.toBe(first.releaseId);
  }, 90_000);

  test('a model that starts with apps.list goes on to spec.read unaided', async () => {
    // Report 08b watched a real model stop before doing anything and ask which
    // application was meant, because there was no way to find out. Both calls
    // are reads, so nothing is asked and nothing is nudged.
    const { harness: test, where } = await start([
      {
        kind: 'tool',
        name: 'apps.list',
        input: {},
        then: [
          {
            kind: 'tool',
            name: 'spec.read',
            input: { appId: 'items' },
            then: [{ kind: 'text', chunks: ['it is the items application'] }],
          },
        ],
      },
    ]);
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);

    const client = await test.connect(merged);
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });

    const events: { type: string; tool?: string; denied?: boolean }[] = [];
    let finished = false;
    await client.subscribe(
      'ai.chat',
      { runId: 'run-bcdefghi', message: 'add a column', refs: [], history: [] },
      {
        onEvent: (event) => {
          events.push(event as { type: string });
          if (event.type === 'done' || event.type === 'error') finished = true;
        },
        onError: () => {
          finished = true;
        },
      },
    );
    while (!finished) await Bun.sleep(10);
    await client.close();

    expect(events.some((event) => event.type === 'confirm')).toBe(false);
    expect(
      events.filter((event) => event.type === 'tool-result').map((event) => event.tool),
    ).toEqual(['apps.list', 'spec.read']);
    expect(events.some((event) => event.denied === true)).toBe(false);
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

  test('are under seventy lines, so they are read', () => {
    expect(ENGINEER_INSTRUCTIONS.split('\n').length).toBeLessThanOrEqual(70);
  });

  test('name apps.list first in the loop, and forgive indentation', () => {
    const flat = ENGINEER_INSTRUCTIONS.replace(/\s+/g, ' ');
    expect(flat).toContain('Find the application with `apps.list` if you were not told its id');
    // `apps.list` is the first tool the loop names.
    const loop = ENGINEER_INSTRUCTIONS.slice(ENGINEER_INSTRUCTIONS.indexOf('# How to work'));
    expect(loop.indexOf('`apps.list`')).toBeLessThan(loop.indexOf('`spec.read`'));
    expect(flat).toContain('Leading whitespace need not match');
    expect(flat).toContain('three to eight lines is right');
  });

  test('send it to the design topic for views.ts, and ask for the check’s count', () => {
    const flat = ENGINEER_INSTRUCTIONS.replace(/\s+/g, ' ');
    expect(flat).toContain('`design` topic');
    expect(flat).toContain("say its check's count when you ask the person to look");
  });

  test('send the engineer to source.edit rather than to whole-file rewrites', () => {
    expect(ENGINEER_INSTRUCTIONS).toContain('source.edit');
    const flat = ENGINEER_INSTRUCTIONS.replace(/\s+/g, ' ');
    expect(flat).toContain('Use `source.change` only to create a new file');
  });
});

describe('the specification tools', () => {
  test('spec.read reads the candidate when one is built, the current release otherwise, and says which', async () => {
    const where = makeWorld();
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);

    // Nothing built through the engineer yet: the current release, and said so.
    const current = (await callTool(where, 'spec.read', { appId: 'items' })) as {
      from: string;
      releaseId: string;
      candidateReleaseId: string | null;
      sourceRev: string;
      editsSinceBuild: boolean;
    };
    expect(current.from).toBe('current');
    expect(current.releaseId).toBe(built.releaseId);
    expect(current.candidateReleaseId).toBeNull();
    expect(typeof current.sourceRev).toBe('string');
    await expect(callTool(where, 'spec.read', { appId: 'items', from: 'candidate' })).rejects.toThrow(
      /no candidate built yet/,
    );

    // Built through the engineer: the candidate, by default.
    const candidate = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as {
      ok: boolean;
      releaseId: string;
    };
    expect(candidate.ok).toBe(true);
    const read = (await callTool(where, 'spec.read', { appId: 'items' })) as { from: string; releaseId: string; editsSinceBuild: boolean };
    expect(read.from).toBe('candidate');
    expect(read.releaseId).toBe(candidate.releaseId);
    expect(read.editsSinceBuild).toBe(false);
    const explicit = (await callTool(where, 'spec.read', { appId: 'items', from: 'current' })) as { from: string };
    expect(explicit.from).toBe('current');
  });

  test('source reads carry the revision they came from', async () => {
    const where = makeWorld();
    const listed = (await callTool(where, 'source.list', { appId: 'items' })) as { rev: string };
    const read = (await callTool(where, 'source.read', { appId: 'items', path: 'autoapp.json' })) as { rev: string };
    expect(read.rev).toBe(listed.rev);
    expect(read.rev.length).toBeGreaterThan(0);
  });

  test('spec.reference serves one topic, and the views topic states the confirmText rule', async () => {
    const where = makeWorld();
    const views = (await callTool(where, 'spec.reference', { topic: 'views' })) as { topic: string; text: string };
    expect(views.topic).toBe('views');
    expect(views.text).toMatch(/confirmText/);
    expect(views.text).not.toMatch(/# acceptance/);
    const all = (await callTool(where, 'spec.reference', {})) as { topic: string; text: string };
    expect(all.topic).toBe('all');
    expect(all.text).toMatch(/# acceptance/);
  });

  test('spec.reference serves the design topic, and the whole reference contains it', async () => {
    const where = makeWorld();
    const design = (await callTool(where, 'spec.reference', { topic: 'design' })) as { topic: string; text: string };
    expect(design.topic).toBe('design');
    expect(design.text).toBe(designTopic());
    expect(design.text).toMatch(/emptyText/);
    const all = (await callTool(where, 'spec.reference', {})) as { text: string };
    expect(all.text).toContain(design.text);
  });

  test('PRODUCT.md is read from a workspace and never written', async () => {
    const where = makeWorld();
    const source = layout(where.directory).app('items').source;
    const path = join(source, 'PRODUCT.md');

    await expect(callTool(where, 'source.read', { appId: 'items', path: 'PRODUCT.md' })).rejects.toMatchObject({
      code: 'not_found',
    });

    writeFileSync(path, '# Product\n\nA weekly shopping list, used on a phone in a supermarket.\n', 'utf8');
    const read = (await callTool(where, 'source.read', { appId: 'items', path: 'PRODUCT.md' })) as { content: string };
    expect(read.content).toContain('supermarket');

    // The person owns the brief: an engineer that can rewrite it can agree with
    // itself about anything.
    await expect(
      callTool(
        where,
        'source.change',
        { appId: 'items', message: 'rewrite the brief', changes: [{ path: 'PRODUCT.md', content: 'mine now' }] },
        { approve: true },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(readFileSync(path, 'utf8')).toContain('supermarket');
  });

  test('a wrong input names the field, as invalid_input, instead of "the tool failed"', async () => {
    const where = makeWorld();
    await expect(callTool(where, 'knowledge.show', { lessonId: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/lessonId/),
    });
    // A write tool asks the gate before it parses, by design; a read tool parses at once.
    await expect(callTool(where, 'spec.read', { appId: 'items', from: 'nope' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/from/),
    });
  });

  test('a check with no preview says how to get one', async () => {
    const where = makeWorld();
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    await expect(callTool(where, 'candidate.check', { appId: 'items', releaseId: built.releaseId })).rejects.toThrow(
      /Start one with candidate.preview/,
    );
  });
});

describe.skipIf(!available)('trying steps against a preview', () => {
  test('preview.try returns what a route returns, judges view steps, refuses writes, and records nothing', async () => {
    const where = makeWorld();
    const app = where.root.app('items');
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    mkdirSync(app.data, { recursive: true });

    await expect(callTool(where, 'preview.try', { appId: 'items', steps: [{ route: 'items.list', input: null }] })).rejects.toThrow(
      /no preview running/,
    );

    const first = (await callTool(where, 'candidate.preview', { appId: 'items', releaseId: built.releaseId }, { approve: true })) as {
      previewId: string;
      replacedPreviewId: string | null;
      dataReset: boolean;
      checksInvalidated: string[];
    };
    expect(first.replacedPreviewId).toBeNull();
    expect(first.dataReset).toBe(true);
    expect(first.checksInvalidated).toEqual([]);

    const tried = (await callTool(where, 'preview.try', {
      appId: 'items',
      steps: [
        { route: 'items.list', input: null },
        { route: 'items.list', input: null, expect: { items: [], count: 99 } },
        { view: { page: 'items', component: 'items-table', match: { kind: 'table' } } },
        { view: { page: 'items', component: 'nowhere' } },
      ],
    })) as {
      releaseId: string;
      previewId: string;
      verification: string;
      results: { step: number; passed: boolean; detail?: string; output?: unknown }[];
    };
    expect(tried.releaseId).toBe(built.releaseId);
    expect(tried.previewId).toBe(first.previewId);
    expect(tried.verification).toMatch(/not a check/);
    expect(tried.results.map((result) => result.passed)).toEqual([true, false, true, false]);
    expect(tried.results[0]?.output).toMatchObject({ items: [] });
    expect(tried.results[1]?.detail).toMatch(/\(expect; differs at count\)/);
    expect(tried.results[3]?.detail).toMatch(/not declared/);
    // A trial verifies nothing: the candidate's checks are as they were.
    expect(where.states.get('items').checks).toBeNull();

    // A write route is refused before it runs, naming the effect.
    await expect(
      callTool(where, 'preview.try', { appId: 'items', steps: [{ route: 'items.add', input: { label: 'x' } }] }),
    ).rejects.toThrow(/effect write; preview.try runs read routes only/);
    await expect(callTool(where, 'preview.try', { appId: 'items', steps: [{ route: 'items.nope', input: null }] })).rejects.toThrow(
      /not an operation/,
    );

    // Checks, then a second preview: the receipt names what it replaced and which results no longer hold.
    await callTool(where, 'candidate.check', { appId: 'items', releaseId: built.releaseId });
    const second = (await callTool(where, 'candidate.preview', { appId: 'items', releaseId: built.releaseId }, { approve: true })) as {
      previewId: string;
      replacedPreviewId: string | null;
      checksInvalidated: string[];
    };
    expect(second.replacedPreviewId).toBe(first.previewId);
    expect(second.previewId).not.toBe(first.previewId);
    expect(second.checksInvalidated.length).toBeGreaterThan(0);
    await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });
  }, 120_000);
});
