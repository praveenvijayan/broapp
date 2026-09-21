/**
 * A workspace where the person chose to put it (19a).
 *
 * The run root is `tests/.autoapp-run/location-*`, inside this repository, for
 * the reason `autoapp-create.test.ts` gives: a created workspace's build
 * resolves `broapp` by walking up into this repository's `node_modules`, and
 * the install that would otherwise fetch it is replaced. Each test makes its
 * own directory there, with the launcher's root and the person's folders side
 * by side, and removes it afterwards. Nothing here opens a dialog or reaches
 * the network.
 *
 * Numbered as 19a's verification list is, so a failure names the item.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import type { Ai } from 'broapp/ai/host';
import { createGate, createPendingApprovals } from 'broapp/host';
import { isPublicError } from 'broapp/shared';
import type { Envelope, Gate } from 'broapp/host';
import { BroappProvider } from 'broapp/react';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import { createCandidateStates, engineerTools, type CandidateStates } from 'broapp-autoapp/engineer';
import { createExecutor, openIntents, type TaskInput } from 'broapp-autoapp/intent';
import { orientation } from 'broapp-autoapp/knowledge';
import {
  addServing,
  buildCandidate,
  checkLocation,
  createApplication,
  createLauncherApp,
  createSupervisor,
  launcherContract,
  listApps,
  locateApplication,
  LOCATION_WORDS,
  normaliseLocation,
  openJournal,
  recover,
  removeApplication,
  restoreServing,
  sourceProblem,
  sourceState,
  writeStarter,
  type Journal,
  type LauncherApp,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout, readCurrent, type Layout } from 'broapp-autoapp/spec';

import { AppsTable } from '../packages/broapp-autoapp/src/launcher/ui/AppsTable.tsx';
import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';

const failure = await ensureLauncher();
if (failure !== null) console.warn(`[autoapp-location] some cases skipped: the launcher would not build\n${failure}`);
const available = failure === null;

const quiet = { warn: () => undefined, error: () => undefined };
const runRoot = join(import.meta.dir, '.autoapp-run');
const installedOk = () => Promise.resolve({ ok: true, detail: '' });
const noGit = (): boolean => false;
const windows = process.platform === 'win32';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** Permission bits mean nothing on Windows or to root, so those cases are skipped there. */
const permissionsHold = !windows && !asRoot;

interface World {
  readonly directory: string;
  readonly root: Layout;
  /** Where the person keeps their projects: beside the launcher's root, never in it. */
  readonly places: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly store: RunStore;
  readonly gate: Gate;
  readonly states: CandidateStates;
  readonly warnings: string[];
}

let world: World | null = null;
/** Modes to put back before removal, so a `chmod 000` cannot outlive its test. */
const restoreModes: { path: string; mode: number }[] = [];

afterEach(async () => {
  for (const { path, mode } of restoreModes.splice(0)) {
    try {
      chmodSync(path, mode);
    } catch {
      // Already gone.
    }
  }
  const current = world;
  world = null;
  if (current === null) return;
  await current.supervisor.stopAll(5_000).catch(() => undefined);
  current.journal.close();
  current.store.close();
  rmSync(current.directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) rmSync(runRoot, { recursive: true, force: true });
});

function makeWorld(): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'location-'));
  const root = layout(join(directory, 'root'));
  mkdirSync(root.root, { recursive: true });
  const places = join(directory, 'places');
  mkdirSync(places);
  const store = createRunStore(join(root.root, 'launcher'), quiet);
  const warnings: string[] = [];
  const built: World = {
    directory,
    root,
    places,
    journal: openJournal(root.journal),
    supervisor: createSupervisor({ execPath: LAUNCHER, logger: quiet }),
    store,
    gate: createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, recorder: store.recorder(), logger: quiet }),
    states: createCandidateStates(root, quiet),
    warnings,
  };
  world = built;
  return built;
}

/** Create one application, optionally in a chosen folder. */
async function create(
  where: World,
  appId: string,
  location?: string,
  extra: Partial<Parameters<typeof createApplication>[0]> = {},
): ReturnType<typeof createApplication> {
  return await createApplication({
    layout: where.root,
    templates: TEMPLATES,
    versions: STARTER_VERSIONS,
    appId,
    name: appId === 'recipes' ? 'Recipe tracker' : appId,
    install: installedOk,
    initGit: noGit,
    logger: quiet,
    ...(location === undefined ? {} : { location }),
    ...extra,
  });
}

/** The launcher's routes, called as the tab calls them. */
function launcherApp(where: World): LauncherApp {
  return createLauncherApp({
    layout: where.root,
    supervisor: where.supervisor,
    journal: where.journal,
    states: where.states,
    gate: where.gate,
    templates: TEMPLATES,
    versions: STARTER_VERSIONS,
    install: installedOk,
    initGit: noGit,
    logger: quiet,
    openBrowser: () => Promise.resolve(true),
  });
}

const asPerson = (id = 'r-1'): Envelope => ({ requestId: id, channel: 'user', caller: 'user' });

interface Row {
  appId: string;
  name: string;
  serving: boolean;
  workspace: { chosen: boolean; dir: string | null; state: string };
}
async function appsList(app: LauncherApp): Promise<Row[]> {
  return ((await app.invoke('launcher.appsList', undefined, asPerson())) as { apps: Row[] }).apps;
}

/** Everything under a directory, with each file's bytes, for a before-and-after comparison. */
function contents(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(directory)) return out;
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        out[`${prefix}${entry.name}/`] = '';
        walk(path, `${prefix}${entry.name}/`);
      } else if (entry.isFile()) out[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
      else out[`${prefix}${entry.name}`] = '(link)';
    }
  };
  walk(directory, '');
  return out;
}

/** The message of whatever a promise rejected with. */
async function refusal(promise: Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await promise;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // A route called through `invoke` comes back as the bridge would carry
    // it: the code in front of the sentence.
    const carried = /^broapp\/([a-z_]+) ([\s\S]*)$/.exec(message);
    if (carried !== null) return { message: carried[2] ?? '', code: carried[1] ?? '' };
    return { message, code: isPublicError(cause) ? cause.code : 'thrown' };
  }
  throw new Error('it did not refuse');
}

/** An engineer's tool call, approving whatever it asks. */
async function callTool(where: World, name: string, input: unknown): Promise<unknown> {
  const tools = engineerTools({
    layout: where.root,
    supervisor: where.supervisor,
    journal: where.journal,
    gate: where.gate,
    states: where.states,
    logger: quiet,
    templates: TEMPLATES,
    versions: STARTER_VERSIONS,
    confirmTimeoutMs: 5_000,
    install: installedOk,
    initGit: noGit,
  });
  const tool = tools[name];
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  const approvals = createPendingApprovals(quiet);
  const running = tool.execute(
    input,
    { requestId: `run-1:${name}-${String(Math.random()).slice(2, 8)}`, channel: 'ai', caller: 'ai:test', approver: approvals },
    new AbortController().signal,
  );
  let settled = false;
  void running.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    const question = approvals.pending[0];
    if (question !== undefined) {
      approvals.answer({ requestId: question.requestId, approved: true, releaseId: question.releaseId, argumentsHash: question.argumentsHash });
    }
    await Bun.sleep(5);
  }
  return await running;
}

// ── Unchanged behaviour ─────────────────────────────────────────────────────

describe('with no folder given', () => {
  test('1. nothing changes: no pointer, the default workspace, kind default', async () => {
    const where = makeWorld();
    const created = await create(where, 'recipes');
    expect(created.ok).toBe(true);
    const app = where.root.app('recipes');
    expect(existsSync(app.location)).toBe(false);
    expect(app.source).toBe(join(where.root.root, 'apps', 'recipes', 'source'));
    expect(app.sourceLocation).toEqual({ kind: 'default' });
    expect(existsSync(join(app.source, 'autoapp.json'))).toBe(true);
    expect(created.notes.some((note) => note.startsWith('the workspace is at'))).toBe(false);
  }, 120_000);

  test('2. layout.app() for an id with no directory at all is the default and does not throw', () => {
    const where = makeWorld();
    const app = where.root.app('nothing-here');
    expect(app.sourceLocation).toEqual({ kind: 'default' });
    expect(app.source).toBe(join(where.root.root, 'apps', 'nothing-here', 'source'));
  });
});

// ── The happy path ──────────────────────────────────────────────────────────

describe('in a folder the person chose', () => {
  test('3. the workspace is made at <location>/<id>, with a 0600 pointer, and builds', async () => {
    const where = makeWorld();
    const location = join(where.places, 'My Prøjects');
    mkdirSync(location);
    const created = await create(where, 'recipes', location);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const target = join(location, 'recipes');
    expect(existsSync(join(target, 'autoapp.json'))).toBe(true);
    const app = where.root.app('recipes');
    expect(JSON.parse(readFileSync(app.location, 'utf8'))).toEqual({ version: 1, source: target });
    if (!windows) expect(statSync(app.location).mode & 0o777).toBe(0o600);
    expect(existsSync(join(where.root.root, 'apps', 'recipes', 'source'))).toBe(false);
    expect(app.source).toBe(target);
    expect(readCurrent(where.root, 'recipes')).toBe(created.releaseId);
    expect(created.notes[0]).toBe(LOCATION_WORDS.created(target));
  }, 120_000);

  test('4. ~ is the home folder, a/../b is normalised, and a trailing separator changes nothing', () => {
    const where = makeWorld();
    mkdirSync(join(where.places, 'b'));
    const home = (): string => where.places;
    expect(normaliseLocation('~/b', { home })).toEqual({ ok: true, path: join(where.places, 'b') });
    expect(normaliseLocation('~', { home })).toEqual({ ok: true, path: where.places });
    expect(normaliseLocation(`${where.places}${sep}a${sep}..${sep}b`)).toEqual({ ok: true, path: join(where.places, 'b') });
    expect(normaliseLocation(`${join(where.places, 'b')}${sep}`)).toEqual({ ok: true, path: join(where.places, 'b') });

    const viaHome = checkLocation(where.root, 'recipes', '~/b', { home });
    const plain = checkLocation(where.root, 'recipes', join(where.places, 'b'));
    const dotted = checkLocation(where.root, 'recipes', `${where.places}${sep}a${sep}..${sep}b${sep}`);
    expect(viaHome.ok && viaHome.target).toBe(join(where.places, 'b', 'recipes'));
    expect(plain).toEqual(viaHome);
    expect(dotted).toEqual(viaHome);
  });

  test('5. launcher.appsList says chosen, where, and present; a default one says neither', async () => {
    const where = makeWorld();
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    expect((await create(where, 'second')).ok).toBe(true);
    const rows = await appsList(launcherApp(where));
    expect(rows.find((row) => row.appId === 'recipes')?.workspace).toEqual({
      chosen: true,
      dir: join(where.places, 'recipes'),
      state: 'present',
    });
    expect(rows.find((row) => row.appId === 'second')?.workspace).toEqual({ chosen: false, dir: null, state: 'present' });
  }, 180_000);

  test('6. the engineer reads, edits and lists there, and is confined to it', async () => {
    const where = makeWorld();
    // A chosen location that is itself a symbolic link works.
    mkdirSync(join(where.places, 'real'));
    const linked = join(where.places, 'linked');
    symlinkSync(join(where.places, 'real'), linked, 'dir');
    expect((await create(where, 'recipes', linked)).ok).toBe(true);

    const listed = (await callTool(where, 'source.list', { appId: 'recipes' })) as { files: { path: string }[] };
    expect(listed.files.map((file) => file.path)).toContain('autoapp.json');
    const read = (await callTool(where, 'source.read', { appId: 'recipes', path: 'autoapp.json' })) as { content: string };
    expect(read.content).toContain('"recipes"');
    await callTool(where, 'source.edit', {
      appId: 'recipes',
      message: 'rename',
      hunks: [{ path: 'autoapp.json', find: '"name": "Recipe tracker"', replace: '"name": "Recipes"' }],
    });
    expect(readFileSync(join(where.places, 'real', 'recipes', 'autoapp.json'), 'utf8')).toContain('"name": "Recipes"');

    // A sibling of the workspace, and a link inside it that points out.
    mkdirSync(join(where.places, 'real', 'sibling'));
    writeFileSync(join(where.places, 'real', 'sibling', 'file.ts'), 'not yours');
    await expect(callTool(where, 'source.read', { appId: 'recipes', path: 'src/../../sibling/file.ts' })).rejects.toThrow(/outside/);
    symlinkSync(join(where.places, 'real', 'sibling', 'file.ts'), join(where.places, 'real', 'recipes', 'src', 'out.ts'));
    await expect(callTool(where, 'source.read', { appId: 'recipes', path: 'src/out.ts' })).rejects.toThrow(/outside/);
  }, 120_000);
});

// ── Refusals at creation ────────────────────────────────────────────────────

interface Case {
  readonly name: string;
  readonly location: string;
  readonly sentence: string;
  readonly conflict?: boolean;
  /** A directory whose contents must be exactly the same afterwards. */
  readonly watch?: string;
}

/** Every refusal in 7, in one world with two other applications to be inside of. */
async function refusalCases(where: World): Promise<Case[]> {
  const other = join(where.places, 'a');
  mkdirSync(other);
  expect((await create(where, 'other', other)).ok).toBe(true);
  expect((await create(where, 'third')).ok).toBe(true);

  const file = join(where.places, 'a-file');
  writeFileSync(file, 'x');
  const intoRoot = join(where.places, 'into-root');
  symlinkSync(where.root.root, intoRoot, 'dir');
  const taken = join(where.places, 'taken');
  mkdirSync(join(taken, 'recipes'), { recursive: true });
  writeFileSync(join(taken, 'recipes', 'theirs.txt'), 'theirs');
  const takenByFile = join(where.places, 'taken-file');
  mkdirSync(takenByFile);
  writeFileSync(join(takenByFile, 'recipes'), 'a file');
  const cases: Case[] = [
    { name: 'relative', location: 'Projects', sentence: LOCATION_WORDS.notAbsolute('Projects') },
    { name: 'NUL', location: `${where.places}/a\0b`, sentence: LOCATION_WORDS.nul() },
    { name: '~other', location: '~someone/Projects', sentence: LOCATION_WORDS.otherHome('~someone/Projects') },
    { name: 'does not exist', location: join(where.places, 'nope'), sentence: LOCATION_WORDS.doesNotExist(join(where.places, 'nope')) },
    { name: 'a file', location: file, sentence: LOCATION_WORDS.notADirectory(file) },
    { name: 'inside the root', location: where.root.root, sentence: LOCATION_WORDS.insideRoot(where.root.root) },
    { name: 'inside the root through a link', location: intoRoot, sentence: LOCATION_WORDS.insideRoot(intoRoot) },
    {
      name: 'inside another chosen workspace',
      location: join(other, 'other', 'src'),
      sentence: LOCATION_WORDS.insideWorkspace(join(other, 'other', 'src'), 'other'),
      watch: join(other, 'other'),
    },
    {
      name: 'inside another default workspace',
      location: join(where.root.app('third').source, 'src'),
      sentence: LOCATION_WORDS.insideWorkspace(join(where.root.app('third').source, 'src'), 'third'),
    },
    { name: 'target exists as a folder', location: taken, sentence: LOCATION_WORDS.targetExists(join(taken, 'recipes')), conflict: true, watch: taken },
    {
      name: 'target exists as a file',
      location: takenByFile,
      sentence: LOCATION_WORDS.targetExists(join(takenByFile, 'recipes')),
      conflict: true,
      watch: takenByFile,
    },
  ];
  if (permissionsHold) {
    const locked = join(where.places, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    restoreModes.push({ path: locked, mode: 0o700 });
    cases.push({
      name: 'not writable',
      location: locked,
      sentence: LOCATION_WORDS.notWritable(locked, process.platform === 'darwin' ? 'darwin' : 'other'),
      watch: locked,
    });
  }
  // Only where the volume folds case: there, `Recipes` is `recipes`.
  const cased = join(where.places, 'cased');
  mkdirSync(join(cased, 'RECIPES'), { recursive: true });
  if (existsSync(join(cased, 'recipes'))) {
    cases.push({ name: 'target differs only by case', location: cased, sentence: LOCATION_WORDS.targetExists(join(cased, 'recipes')), conflict: true, watch: cased });
  }
  return cases;
}

describe('refusals at creation', () => {
  test('7. each refusal says its sentence, keeps the id free and writes nothing', async () => {
    const where = makeWorld();
    const cases = await refusalCases(where);
    for (const one of cases) {
      const before = one.watch === undefined ? null : contents(one.watch);
      const placesBefore = readdirSync(where.places).sort();
      const refused = await refusal(create(where, 'recipes', one.location));
      expect(`${one.name}: ${refused.message}`).toBe(`${one.name}: ${one.sentence}`);
      expect(`${one.name}: ${refused.code}`).toBe(`${one.name}: ${one.conflict === true ? 'conflict' : 'invalid_input'}`);
      expect(`${one.name}: ${String(existsSync(where.root.app('recipes').dir))}`).toBe(`${one.name}: false`);
      expect(readdirSync(where.places).sort()).toEqual(placesBefore);
      if (one.watch !== undefined) expect(contents(one.watch)).toEqual(before ?? {});
    }
  }, 240_000);

  test('8. losing the race after the check: a conflict, the id free, no pointer ever, their folder untouched', async () => {
    const where = makeWorld();
    const target = join(where.places, 'recipes');
    const refused = await refusal(
      create(where, 'recipes', where.places, {
        // Somebody else makes the target between the check and the write,
        // which is what `writeStarter`'s own `mkdirSync` then finds.
        writeStarter: (_template, at) => {
          mkdirSync(at);
          writeFileSync(join(at, 'theirs.txt'), 'theirs');
          throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${at}'`), { code: 'EEXIST' });
        },
      }),
    );
    expect(refused.code).toBe('conflict');
    expect(refused.message).toBe(LOCATION_WORDS.targetExists(target));
    // The application directory is gone, which proves no pointer was written:
    // its removal is a non-recursive `rmdirSync`, and a pointer inside would
    // have made it fail.
    expect(existsSync(where.root.app('recipes').dir)).toBe(false);
    expect(contents(target)).toEqual({ 'theirs.txt': 'theirs' });
  });

  test('9. a disk that filled half-way: the pointer names what was written, and nothing is deleted', async () => {
    const where = makeWorld();
    const target = join(where.places, 'recipes');
    const created = await create(where, 'recipes', where.places, {
      writeStarter: (_template, at) => {
        mkdirSync(at);
        writeFileSync(join(at, 'autoapp.json'), '{}');
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      },
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.problems).toEqual([{ stage: 'spec', message: LOCATION_WORDS.diskFull(target) }]);
    const app = where.root.app('recipes');
    expect(JSON.parse(readFileSync(app.location, 'utf8'))).toEqual({ version: 1, source: target });
    expect(contents(target)).toEqual({ 'autoapp.json': '{}' });
  });

  test('10. two creations of one id at once: one wins, the other wrote nothing anywhere', async () => {
    const where = makeWorld();
    // The first call runs to its first `await` before the second starts, so
    // each order makes the other one the loser: with a folder, and without.
    const [chosenFirst, defaultSecond] = await Promise.allSettled([create(where, 'recipes', where.places), create(where, 'recipes')]);
    expect(chosenFirst.status === 'fulfilled' && chosenFirst.value.ok).toBe(true);
    expect(defaultSecond.status).toBe('rejected');
    expect(existsSync(join(where.root.root, 'apps', 'recipes', 'source'))).toBe(false);

    const [defaultFirst, chosenSecond] = await Promise.allSettled([create(where, 'second'), create(where, 'second', where.places)]);
    expect(defaultFirst.status === 'fulfilled' && defaultFirst.value.ok).toBe(true);
    expect(chosenSecond.status).toBe('rejected');
    expect(existsSync(join(where.places, 'second'))).toBe(false);
    expect(existsSync(where.root.app('second').location)).toBe(false);
    expect(readdirSync(where.places)).toEqual(['recipes']);
  }, 180_000);
});

// ── Afterwards: make it, then break it ──────────────────────────────────────

const PLAN: TaskInput = {
  title: 'Build the label part',
  words: 'label',
  priority: 'medium',
  labels: ['acceptance'],
  blockedBy: [],
  estimatedLines: 20,
  locks: [],
  risk: 'normal',
  stub: false,
  summary: 'A part of the request that a person can accept or reject on its own.',
  criteria: [
    { text: 'items.list returns the items', failure: false },
    { text: 'An empty list reads as empty, never as an error', failure: true },
  ],
  reasoning: 'low',
};

describe.skipIf(!available)('a workspace that has gone', () => {
  test('11. is said everywhere, never stops it opening, and is never recreated', async () => {
    const where = makeWorld();
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    expect((await create(where, 'second')).ok).toBe(true);
    const target = join(where.places, 'recipes');
    renameSync(target, join(where.places, 'moved'));
    const sentence = LOCATION_WORDS.missing(target, 'Recipe tracker');
    const app = launcherApp(where);

    const rows = await appsList(app);
    expect(rows.find((row) => row.appId === 'recipes')?.workspace.state).toBe('missing');
    expect(rows.find((row) => row.appId === 'second')?.workspace.state).toBe('present');

    // It opens: a release is self-contained.
    expect(await app.invoke('launcher.appOpen', { appId: 'recipes' }, asPerson('r-open'))).toEqual({ opened: true });
    const child = where.supervisor.children.find((one) => one.appId === 'recipes');
    expect(child).toBeDefined();
    expect((await child?.health())?.state).toBe('serving');
    await app.invoke('launcher.appStop', { appId: 'recipes' }, asPerson('r-stop'));

    const built = await buildCandidate({ layout: where.root, appId: 'recipes' });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.problems).toEqual([{ stage: 'spec', message: sentence }]);
      expect(JSON.stringify(built.problems)).not.toContain('ENOENT');
    }
    await expect(callTool(where, 'source.read', { appId: 'recipes', path: 'autoapp.json' })).rejects.toThrow(sentence);

    // A backlog run stops before any model is asked anything, and nothing is counted.
    const intents = openIntents(join(where.root.root, 'launcher'));
    try {
      const intent = intents.createIntent({ appId: 'recipes', request: 'Change the label.' });
      intents.replaceAnalysis(intent.id, { restated: 'Change the label.', fits: 'Builds on items.list.', conflicts: [], outOfReach: [], assumptions: [], questions: [] });
      intents.addTask(intent.id, PLAN, { deferReferences: true });
      expect(intents.submit(intent.id)).toEqual([]);
      let turns = 0;
      const ai = {
        // A provider is configured, so the run starts; the model is never reached.
        registry: { currentConfig: () => Promise.resolve({ provider: 'fake', modelId: 'fake-1' }) },
        turn: () => {
          turns += 1;
          return Promise.resolve({ status: 'failed', events: [] });
        },
      } as unknown as Ai;
      const executor = createExecutor({ intents, ai: () => ai, states: where.states, layout: where.root, logger: quiet, mapping: () => ({ light: null, standard: null, deep: null }) });
      await executor.start(intent.id, 'the test');
      await executor.idle();
      expect(turns).toBe(0);
      const detail = intents.get(intent.id);
      expect(detail?.intent.stopReason).toBe(sentence);
      const task = detail?.tasks[0];
      expect(task?.stored).toBe('in-queue');
      expect(task?.attempts).toBe(0);
      expect(task?.events.some((event) => event.to === 'failed' || event.to === 'interrupted')).toBe(false);
      // The run's end is said, in the sentence; no failure, no provider error.
      expect(executor.recent().map((event) => event.kind)).toEqual(['run-ended']);
      expect(executor.recent()[0]?.text).toContain(sentence);
    } finally {
      intents.close();
    }

    const oriented = orientation({ layout: where.root, appId: 'recipes', states: where.states, apps: listApps(where.root, where.supervisor, where.journal) });
    expect(oriented.text).toContain(sentence);

    // After all of that, nothing recreated it.
    expect(existsSync(target)).toBe(false);
  }, 180_000);

  test('12. renamed back, it is present on the very next call and builds, with no restart', async () => {
    const where = makeWorld();
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    const target = join(where.places, 'recipes');
    const app = launcherApp(where);
    renameSync(target, join(where.places, 'moved'));
    expect((await appsList(app))[0]?.workspace.state).toBe('missing');
    renameSync(join(where.places, 'moved'), target);
    expect((await appsList(app))[0]?.workspace.state).toBe('present');
    expect((await buildCandidate({ layout: where.root, appId: 'recipes' })).ok).toBe(true);
  }, 120_000);
});

describe('what a workspace can turn into', () => {
  test('13. a file is not-a-directory; a folder with no permission is denied', async () => {
    const where = makeWorld();
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    const target = join(where.places, 'recipes');
    renameSync(target, join(where.places, 'moved'));
    writeFileSync(target, 'a file');
    expect(sourceState(where.root, 'recipes').state).toBe('not-a-directory');
    expect(sourceProblem(where.root, 'recipes')).toBe(LOCATION_WORDS.notADirectoryState(target));
    rmSync(target);
    renameSync(join(where.places, 'moved'), target);
    if (!permissionsHold) return;
    chmodSync(target, 0o000);
    restoreModes.push({ path: target, mode: 0o755 });
    expect(sourceState(where.root, 'recipes').state).toBe('denied');
    expect(sourceProblem(where.root, 'recipes')).toBe(LOCATION_WORDS.denied(target));
  }, 120_000);

  test('14. a pointer that cannot be believed is unreadable, lists, and never builds the default path', async () => {
    const where = makeWorld();
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    expect((await create(where, 'second')).ok).toBe(true);
    const app = where.root.app('recipes');
    // A whole, buildable workspace at the default path, so a build that fell
    // back to it would succeed and the assertion below would see it.
    const defaultPath = join(app.dir, 'source');
    renameSync(join(where.places, 'recipes'), defaultPath);
    const pointers = [
      'not json',
      JSON.stringify({ version: 2, source: join(where.places, 'recipes') }),
      JSON.stringify({ version: 1, source: 'relative/recipes' }),
      JSON.stringify({ version: 1, source: join(where.root.root, 'elsewhere') }),
      '',
    ];
    for (const pointer of pointers) {
      writeFileSync(app.location, pointer);
      const fresh = where.root.app('recipes');
      expect(`${pointer}: ${fresh.sourceLocation.kind}`).toBe(`${pointer}: unreadable`);
      expect(listApps(where.root, where.supervisor, where.journal).map((row) => [row.appId, row.workspace?.state])).toEqual([
        ['recipes', 'unreadable'],
        ['second', 'present'],
      ]);
      const built = await buildCandidate({ layout: where.root, appId: 'recipes' });
      expect(built.ok).toBe(false);
      if (!built.ok) {
        expect(built.problems).toHaveLength(1);
        expect(built.problems[0]?.message).toStartWith('The file that says where recipes’s workspace is cannot be read (');
        expect(built.problems[0]?.message).toEndWith('). Use Locate, or broapp-autoapp locate, to say where it is.');
      }
    }
  }, 180_000);

  test('15. locate: accepted for the moved folder, refused for every wrong one, and atomic', async () => {
    const where = makeWorld();
    const others = join(where.places, 'others');
    mkdirSync(others);
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    expect((await create(where, 'other', others)).ok).toBe(true);
    expect((await create(where, 'second')).ok).toBe(true);
    const app = launcherApp(where);
    const moved = join(where.places, 'moved');
    renameSync(join(where.places, 'recipes'), moved);

    expect(await app.invoke('launcher.appLocate', { appId: 'recipes', sourceDir: moved }, asPerson())).toEqual({ dir: moved });
    expect(sourceState(where.root, 'recipes').state).toBe('present');
    expect((await buildCandidate({ layout: where.root, appId: 'recipes' })).ok).toBe(true);

    const pointer = readFileSync(where.root.app('recipes').location, 'utf8');
    const empty = join(where.places, 'empty');
    mkdirSync(empty);
    const someoneElse = join(where.places, 'someone');
    mkdirSync(someoneElse);
    writeFileSync(join(someoneElse, 'autoapp.json'), JSON.stringify({ appId: 'someone' }));
    const cases: [string, string, string][] = [
      ['recipes', empty, LOCATION_WORDS.locateWrong(empty, 'recipes')],
      ['recipes', someoneElse, LOCATION_WORDS.locateWrongOwner(someoneElse, 'recipes', 'someone')],
      ['recipes', where.root.root, LOCATION_WORDS.insideRoot(where.root.root)],
      ['recipes', join(others, 'other'), LOCATION_WORDS.insideWorkspace(join(others, 'other'), 'other')],
      ['second', moved, LOCATION_WORDS.locateDefault('second')],
    ];
    for (const [appId, dir, sentence] of cases) {
      const refused = await refusal(app.invoke('launcher.appLocate', { appId, sourceDir: dir }, asPerson()));
      expect(refused.message).toBe(sentence);
      expect(readFileSync(where.root.app('recipes').location, 'utf8')).toBe(pointer);
    }
    expect(existsSync(where.root.app('second').location)).toBe(false);

    // A rename that fails leaves the old pointer whole, and no temporary file.
    renameSync(moved, join(where.places, 'again'));
    expect(() =>
      locateApplication(where.root, 'recipes', join(where.places, 'again'), {
        rename: () => {
          throw new Error('EIO: the rename failed');
        },
      }),
    ).toThrow(/EIO/);
    expect(readFileSync(where.root.app('recipes').location, 'utf8')).toBe(pointer);
    expect(readdirSync(where.root.app('recipes').dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  }, 240_000);
});

describe('removal', () => {
  async function remove(where: World, appId: string): ReturnType<typeof removeApplication> {
    return await removeApplication(
      {
        layout: where.root,
        supervisor: where.supervisor,
        states: where.states,
        journal: where.journal,
        logger: { warn: (line) => where.warnings.push(line), error: () => undefined },
      },
      appId,
    );
  }

  test('16. a chosen workspace is left where it is, byte for byte, and said', async () => {
    const where = makeWorld();
    const kept = join(where.places, 'kept');
    mkdirSync(kept);
    expect((await create(where, 'recipes', kept)).ok).toBe(true);
    expect((await create(where, 'gone', where.places)).ok).toBe(true);
    const target = join(kept, 'recipes');
    const before = contents(target);

    const receipt = await remove(where, 'recipes');
    expect(receipt.workspaceLeftAt).toBe(target);
    expect(receipt.hadSource).toBe(true);
    const trashed = join(where.root.root, receipt.trashPath);
    expect(JSON.parse(readFileSync(join(trashed, 'location.json'), 'utf8'))).toEqual({ version: 1, source: target });
    expect(contents(target)).toEqual(before);
    expect(where.warnings.at(-1)).toContain(LOCATION_WORDS.removalLeft(target));

    // Already missing: removal still succeeds and says so.
    renameSync(join(where.places, 'gone'), join(where.places, 'elsewhere'));
    const missing = await remove(where, 'gone');
    expect(missing.workspaceLeftAt).toBe(join(where.places, 'gone'));
    expect(missing.hadSource).toBe(false);
    expect(where.warnings.at(-1)).toContain(LOCATION_WORDS.removalMissing(join(where.places, 'gone')));

    // Moved back by hand, it is an application with its workspace again.
    renameSync(trashed, where.root.app('recipes').dir);
    expect(listApps(where.root, where.supervisor, where.journal).find((row) => row.appId === 'recipes')?.workspace).toEqual({
      chosen: true,
      dir: target,
      state: 'present',
    });
  }, 180_000);

  test('17. after removal, the same id at the same place is target-exists; elsewhere, or the default, succeeds', async () => {
    const where = makeWorld();
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    await remove(where, 'recipes');
    const refused = await refusal(create(where, 'recipes', where.places));
    expect(refused.message).toBe(LOCATION_WORDS.targetExists(join(where.places, 'recipes')));
    expect(existsSync(where.root.app('recipes').dir)).toBe(false);

    const another = join(where.places, 'another');
    mkdirSync(another);
    expect((await create(where, 'recipes', another)).ok).toBe(true);
    await remove(where, 'recipes');
    expect((await create(where, 'recipes')).ok).toBe(true);
    expect(where.root.app('recipes').sourceLocation).toEqual({ kind: 'default' });
  }, 240_000);
});

describe.skipIf(!available)('a restart', () => {
  test('18. with a chosen workspace missing, the launcher recovers and serves it', async () => {
    const where = makeWorld();
    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    addServing(where.root, 'recipes');
    renameSync(join(where.places, 'recipes'), join(where.places, 'moved'));
    await recover({ layout: where.root, journal: where.journal, supervisor: where.supervisor, logger: quiet });
    const restored = await restoreServing({ layout: where.root, supervisor: where.supervisor, logger: quiet });
    expect(restored).toEqual(['recipes']);
    expect(where.supervisor.children.some((child) => child.appId === 'recipes' && child.mode === 'live')).toBe(true);
    expect(existsSync(join(where.places, 'recipes'))).toBe(false);
  }, 180_000);
});

// ── The boundary ────────────────────────────────────────────────────────────

describe('who may choose', () => {
  test('19. apps.create has no location and refuses one; apps.list carries the state; the approval shows the location', async () => {
    const where = makeWorld();
    const tools = engineerTools({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      states: where.states,
      logger: quiet,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      install: installedOk,
      initGit: noGit,
    });
    const schema = tools['apps.create']?.inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).not.toContain('location');
    expect(schema.additionalProperties).toBe(false);
    const refused = await refusal(callTool(where, 'apps.create', { appId: 'recipes', name: 'Recipes', location: where.places }));
    expect(refused.message).toContain('apps.create takes no location');
    expect(existsSync(join(where.root.root, 'apps'))).toBe(false);
    expect(readdirSync(where.places)).toEqual([]);

    expect((await create(where, 'recipes', where.places)).ok).toBe(true);
    renameSync(join(where.places, 'recipes'), join(where.places, 'moved'));
    const listed = (await callTool(where, 'apps.list', undefined)) as { apps: { appId: string; workspace?: unknown }[] };
    expect(listed.apps[0]?.workspace).toEqual({ state: 'missing', dir: join(where.places, 'recipes') });

    // On channel `ai`, the route asks, and the question carries the folder in full.
    const approvals = createPendingApprovals(quiet);
    const app = launcherApp(where);
    const location = join(where.places, 'a folder the person should see');
    const asking = app.invoke(
      'launcher.appCreate',
      { appId: 'fromai', name: 'From AI', location },
      { requestId: 'mcp-1', channel: 'ai', caller: 'mcp:test', approver: approvals },
    );
    while (approvals.pending.length === 0) await Bun.sleep(5);
    const question = approvals.pending[0];
    expect((question?.input as { location?: string }).location).toBe(location);
    if (question !== undefined) {
      approvals.answer({ requestId: question.requestId, approved: false, releaseId: question.releaseId, argumentsHash: question.argumentsHash });
    }
    await expect(asking).rejects.toThrow();
    expect(existsSync(where.root.app('fromai').dir)).toBe(false);
  }, 120_000);

  test('20. launcher.locationCheck agrees with launcher.appCreate for every refusal', async () => {
    const where = makeWorld();
    const app = launcherApp(where);
    const cases = await refusalCases(where);
    for (const one of cases) {
      const checked = (await app.invoke('launcher.locationCheck', { appId: 'recipes', location: one.location }, asPerson())) as {
        ok: boolean;
        target: string | null;
        problem: string | null;
      };
      const created = await refusal(app.invoke('launcher.appCreate', { appId: 'recipes', name: 'Recipes', location: one.location }, asPerson()));
      expect(`${one.name}: ${String(checked.ok)} ${String(checked.problem)}`).toBe(`${one.name}: false ${created.message}`);
      expect(checked.target).toBeNull();
    }
    const fine = await app.invoke('launcher.locationCheck', { appId: 'recipes', location: where.places }, asPerson());
    expect(fine).toEqual({ ok: true, target: join(where.places, 'recipes'), problem: null });
    expect(existsSync(join(where.places, 'recipes'))).toBe(false);
  }, 240_000);
});

describe.skipIf(!available)('the command line', () => {
  test('21. create --at, a bad --at, locate, and remove', async () => {
    const where = makeWorld();
    const data = join(where.directory, 'cli');
    const env = {
      ...process.env,
      BROAPP_DATA_DIR: data,
      NODE_ENV: 'test',
      AUTOAPP_TEST_NO_BROWSER: '1',
      AUTOAPP_TEST_NO_NETWORK: '1',
    };
    /** Spawned, not `spawnSync`, as 12i's report explains. */
    const run = async (...args: string[]): Promise<{ code: number; out: string; err: string }> => {
      const child = Bun.spawn({ cmd: [LAUNCHER, ...args], env, stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, out, err };
    };
    const target = join(where.places, 'cli-app');

    const created = await run('create', 'cli-app', '--name', 'From the command line', '--at', where.places);
    expect(created.code).toBe(0);
    expect(created.out).toContain(LOCATION_WORDS.created(target));
    expect(existsSync(join(target, 'autoapp.json'))).toBe(true);

    const bad = await run('create', 'cli-bad', '--at', join(where.places, 'nope'));
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain(LOCATION_WORDS.doesNotExist(join(where.places, 'nope')));
    expect(existsSync(join(data, 'autoapp', 'apps', 'cli-bad'))).toBe(false);

    renameSync(target, join(where.places, 'moved'));
    const wrong = await run('locate', 'cli-app', where.places);
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain(LOCATION_WORDS.locateWrong(where.places, 'cli-app'));
    const located = await run('locate', 'cli-app', join(where.places, 'moved'));
    expect(located.code).toBe(0);

    const removed = await run('remove', 'cli-app', '--yes');
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(LOCATION_WORDS.removalLeft(join(where.places, 'moved')));
    expect(existsSync(join(where.places, 'moved', 'autoapp.json'))).toBe(true);
  }, 240_000);
});

// ── The page ────────────────────────────────────────────────────────────────

describe('the page, unedited', () => {
  test('22. renders a chosen, missing application, and reads a receipt with workspaceLeftAt', () => {
    const route = launcherContract.operations['launcher.appsList'];
    const listed = route.output.parse({
      apps: [
        {
          appId: 'recipes',
          name: 'Recipe tracker',
          currentRelease: 'a'.repeat(32),
          serving: false,
          pid: null,
          schemaVersion: null,
          activationPending: false,
          workspace: { chosen: true, dir: '/Volumes/Gone/recipes', state: 'missing' },
        },
      ],
      selected: null,
    });
    const html = renderToString(
      createElement(BroappProvider, {
        contract: launcherContract,
        children: createElement(AppsTable, {
          apps: listed.apps,
          selected: null,
          onSelect: () => undefined,
          onOpen: () => undefined,
          onStop: () => undefined,
          onCreated: () => undefined,
          onRemoved: () => undefined,
        }),
      }),
    );
    expect(html).toContain('<td>Recipe tracker</td>');

    const receipt = launcherContract.operations['launcher.appRemove'].output.parse({
      appId: 'recipes',
      trashPath: 'trash/recipes-2026-09-21T00-00-00.000Z',
      releases: 1,
      hadSource: true,
      dataBytes: 0,
      snapshots: 0,
      dataPrev: 0,
      previewStopped: false,
      workspaceLeftAt: '/Users/you/Projects/recipes',
    });
    // What `AppsTable` reads out of a receipt is still there, as it was.
    expect({ appId: receipt.appId, trashPath: receipt.trashPath }).toEqual({ appId: 'recipes', trashPath: 'trash/recipes-2026-09-21T00-00-00.000Z' });

    // The shapes a page built before 19a knows are subsets of the new ones.
    const keys = (schema: { toJsonSchema(): Record<string, unknown> }): string[] =>
      Object.keys((schema.toJsonSchema()['properties'] ?? {}) as Record<string, unknown>);
    const summary = (route.output.toJsonSchema()['properties'] as { apps: { items: { properties: Record<string, unknown> } } }).apps.items;
    for (const old of ['appId', 'name', 'currentRelease', 'serving', 'pid', 'schemaVersion', 'activationPending']) {
      expect(Object.keys(summary.properties)).toContain(old);
    }
    for (const old of ['appId', 'trashPath', 'releases', 'hadSource', 'dataBytes', 'snapshots', 'dataPrev', 'previewStopped']) {
      expect(keys(launcherContract.operations['launcher.appRemove'].output)).toContain(old);
    }
    for (const old of ['appId', 'name', 'description', 'template']) {
      expect(keys(launcherContract.operations['launcher.appCreate'].input)).toContain(old);
    }
    const required = (launcherContract.operations['launcher.appCreate'].input.toJsonSchema()['required'] ?? []) as string[];
    expect(required.sort()).toEqual(['appId', 'name']);
  });
});

// ── Nothing recreates a chosen folder ───────────────────────────────────────

describe('the source', () => {
  test('writeStarter is still the only thing that makes a workspace, and it refuses one that exists', () => {
    const where = makeWorld();
    const target = join(where.places, 'x');
    mkdirSync(target);
    expect(() =>
      writeStarter(TEMPLATES.starter, target, { appId: 'x', name: 'x', description: '', broappVersion: '^0', autoappVersion: '^0' }),
    ).toThrow(/EEXIST/);
  });
});
