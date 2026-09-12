/**
 * Creating an application from the starter inside the launcher.
 *
 * Two properties run through the file. Nothing here reaches the network or
 * needs git: `install` and `initGit` are injected, which is also what the
 * route and the tool take them as options for. And nothing that fails deletes
 * anything — a half-created workspace is somebody's work, and the assertions
 * say so by listing the directory before and after.
 *
 * The run root is `tests/.autoapp-run/create-*`, inside this repository rather
 * than under `mkdtemp` in the system temporary directory, which departs from
 * the common rule. The reason is the one `scripts/autoapp-smoke.ts` gives at
 * its own `root`: a created workspace depends on `broapp` and `broapp-autoapp`,
 * its install is stubbed out here, and the only way its build resolves them is
 * by walking up into this repository's own `node_modules`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { createFakeAdapter } from 'broapp/ai/host';
import { createGate, createPendingApprovals } from 'broapp/host';
import type { Envelope, Gate } from 'broapp/host';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import {
  createApplication,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  listApps,
  openJournal,
  SOURCE,
  STARTER_MARKERS,
  writeStarter,
  type Journal,
  type StarterTemplate,
  type Supervisor,
  type Templates,
} from 'broapp-autoapp/launcher';
import {
  createCandidateStates,
  engineerTools,
  runAcceptance,
  startPreview,
} from 'broapp-autoapp/engineer';
import { layout, readCurrent, readGrants, readRelease, type Layout } from 'broapp-autoapp/spec';

import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { BLANK, BLANK_DIR, STARTER, STARTER_DIR, STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { harness, type Harness } from './harness.ts';

const failure = await ensureLauncher();
if (failure !== null) {
  console.warn(`[autoapp-create] skipped: the launcher would not build\n${failure}`);
}
const available = failure === null;

const quiet = { warn: () => undefined, error: () => undefined };

/** Inside the repository, so a created workspace can resolve `broapp`. */
const runRoot = join(import.meta.dir, '.autoapp-run');

/** An install that succeeded without going anywhere. */
const installedOk = () => Promise.resolve({ ok: true, detail: '' });
/** One that did not, the way a machine with no network reports it. */
const installFailed = () =>
  Promise.resolve({ ok: false, detail: 'failed to resolve: the network is unavailable' });
/** No git, so a test never writes into anybody's history. */
const noGit = (): boolean => false;

interface World {
  readonly root: Layout;
  readonly directory: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly store: RunStore;
  readonly gate: Gate;
}

let world: World | null = null;
let live: Harness | null = null;
let openedUrls: string[] = [];

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

/** An empty launcher root: no applications at all, which is the case at issue. */
function makeWorld(): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'create-'));
  const root = layout(directory);
  const store = createRunStore(join(directory, 'launcher'), quiet);
  const built: World = {
    root,
    directory,
    journal: openJournal(root.journal),
    supervisor: createSupervisor({ execPath: LAUNCHER, logger: quiet }),
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

/** Both templates, with one of the starter's files replaced by a bad one. */
function templatesWith(path: string, contents: string): Templates {
  return { ...TEMPLATES, starter: { files: { ...STARTER.files, [path]: contents } } };
}

/** Everything under a directory, sorted, for a before-and-after comparison. */
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

describe('the starter template', () => {
  test('packs, and carries everything a build reads', () => {
    const paths = Object.keys(STARTER.files);
    for (const required of Object.values(SOURCE)) expect(paths).toContain(required);
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('src/host/db.ts');
    expect(paths).toContain('src/ui/styles.css');
    expect(paths).toContain('PRODUCT.md');
    // Renamed on the way out: npm rewrites a packaged `.gitignore`.
    expect(paths).toContain('.gitignore');
    expect(paths).not.toContain('_gitignore');
  });

  test('carries each marker in the file that has to have it', () => {
    const file = (path: string): string => STARTER.files[path] ?? '';
    expect(file('autoapp.json')).toContain('__APP_ID__');
    expect(file('autoapp.json')).toContain('__APP_NAME__');
    expect(file('package.json')).toContain('__APP_ID__');
    expect(file('package.json')).toContain('__APP_DESCRIPTION__');
    expect(file('package.json')).toContain('__BROAPP_VERSION__');
    expect(file('package.json')).toContain('__AUTOAPP_VERSION__');
    expect(file('src/ui/index.html')).toContain('__APP_NAME__');
    // And never inside TypeScript, where a name containing a quote would
    // produce a file that does not parse.
    for (const [path, contents] of Object.entries(STARTER.files)) {
      if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;
      for (const marker of STARTER_MARKERS) expect(`${path}: ${contents}`).not.toContain(marker);
    }
  });

  test('refuses a tree with somebody else’s build in it', () => {
    // The check is on the directory in git, so it is asserted against a
    // directory made here rather than by breaking the real one. The run root
    // is made first: `afterEach` removes it when it empties, and this test can
    // be the first in the file to run, so nothing else has necessarily made it.
    mkdirSync(runRoot, { recursive: true });
    const scratch = mkdtempSync(join(runRoot, 'pack-'));
    try {
      mkdirSync(join(scratch, 'node_modules'), { recursive: true });
      // Imported lazily so the module's own top-level pack is not repeated.
      const { packTemplate } = require('../packages/broapp-autoapp/scripts/build-template.ts') as {
        packTemplate: (directory: string) => StarterTemplate;
      };
      expect(() => packTemplate(scratch)).toThrow(/node_modules/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      if (existsSync(runRoot) && readdirSync(runRoot).length === 0) {
        rmSync(runRoot, { recursive: true, force: true });
      }
    }
  });
});

describe('the blank template', () => {
  test('packs, and carries everything a build reads', () => {
    const paths = Object.keys(BLANK.files);
    for (const required of Object.values(SOURCE)) expect(paths).toContain(required);
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('PRODUCT.md');
    expect(paths).toContain('.gitignore');
    // No database: a blank application has no migrations and nothing to keep.
    expect(paths).not.toContain('src/host/db.ts');
    expect(existsSync(join(BLANK_DIR, 'autoapp.json'))).toBe(true);
  });

  test('claims nothing: no operations, no migrations, one view example', () => {
    const manifest = JSON.parse(BLANK.files['autoapp.json'] ?? '{}') as {
      schemaVersion: number;
      migrations: unknown[];
      capabilities: unknown[];
      acceptance: { steps: { view?: { page: string } }[] }[];
    };
    // Zero is what the migrations reach, which is what `parseSpec` insists on.
    expect(manifest.schemaVersion).toBe(0);
    expect(manifest.migrations).toEqual([]);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.acceptance).toHaveLength(1);
    expect(manifest.acceptance[0]?.steps[0]?.view?.page).toBe('home');
    const contract = BLANK.files['src/shared/contract.ts'] ?? '';
    expect(contract).toContain('operations: {}');
    expect(contract).toContain('streams: {}');
  });

  test('is titled with the name, and survives a name that would break a file', () => {
    const where = makeWorld();
    const target = join(where.directory, 'workspace');
    writeStarter(BLANK, target, {
      appId: 'recipes',
      // The two characters that would break a TypeScript string literal.
      name: 'A "difficult" \\ name',
      description: '',
      broappVersion: '^0.3.0',
      autoappVersion: '^0.1.0',
    });
    const views = readFileSync(join(target, 'src', 'shared', 'views.ts'), 'utf8');
    for (const marker of STARTER_MARKERS) expect(views).not.toContain(marker);
    // Encoded for the literal it sits in, so the module still parses — and the
    // name comes back exactly as it was typed.
    expect(views).toContain('title: "A \\"difficult\\" \\\\ name"');
  });
});

describe('writeStarter', () => {
  test('leaves no marker, and puts the name where it can do no harm', () => {
    const where = makeWorld();
    const target = join(where.directory, 'workspace');
    const written = writeStarter(STARTER, target, {
      appId: 'recipes',
      // A quote and a backslash: the two characters that would break a file.
      name: 'A "difficult" \\ name',
      description: 'Quoted "too"',
      broappVersion: '^0.3.0',
      autoappVersion: '^0.1.0',
    });

    expect(written.length).toBe(Object.keys(STARTER.files).length);
    for (const relative of written) {
      const text = readFileSync(join(target, ...relative.split('/')), 'utf8');
      for (const marker of STARTER_MARKERS) expect(`${relative}: ${text}`).not.toContain(marker);
    }
    // The manifest still parses, and the name survived exactly as typed.
    const manifest = JSON.parse(readFileSync(join(target, 'autoapp.json'), 'utf8')) as {
      appId: string;
      name: string;
    };
    expect(manifest.appId).toBe('recipes');
    expect(manifest.name).toBe('A "difficult" \\ name');
  });

  test('writes a PRODUCT.md with the three questions and no marker', () => {
    const where = makeWorld();
    const target = join(where.directory, 'workspace');
    writeStarter(STARTER, target, {
      appId: 'recipes',
      name: 'Recipes',
      description: 'One line.',
      broappVersion: '^0.3.0',
      autoappVersion: '^0.1.0',
    });

    const text = readFileSync(join(target, 'PRODUCT.md'), 'utf8');
    // The three questions, and nothing for the person to delete first: the
    // engineer may read this file and may not write it, so a placeholder left
    // in it would be a placeholder for ever.
    expect(text).toContain('Who uses this, and when?');
    expect(text).toContain('What do they come to do?');
    expect(text).toContain('What tone do they expect?');
    for (const marker of STARTER_MARKERS) expect(text).not.toContain(marker);
  });

  test('refuses a target that already exists', () => {
    const where = makeWorld();
    const target = join(where.directory, 'workspace');
    mkdirSync(target);
    expect(() =>
      writeStarter(STARTER, target, {
        appId: 'recipes',
        name: 'Recipes',
        description: '',
        broappVersion: '^0.3.0',
        autoappVersion: '^0.1.0',
      }),
    ).toThrow();
  });
});

describe('createApplication', () => {
  test('builds, grants nothing, and becomes what the application runs', async () => {
    const where = makeWorld();
    const created = await createApplication({
      layout: where.root,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      appId: 'recipes',
      name: 'Recipe tracker',
      description: 'What to cook',
      install: installedOk,
      initGit: noGit,
      logger: quiet,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.releaseId).toMatch(/^[0-9a-f]{32}$/);
    expect(created.installed).toBe(true);
    expect(readCurrent(where.root, 'recipes')).toBe(created.releaseId);

    const grants = readGrants(where.root, 'recipes');
    expect(grants?.capabilities).toEqual([]);
    expect(grants?.releaseId).toBe(created.releaseId);

    // The name reaches the list, which reads it out of the built release.
    const rows = listApps(where.root, where.supervisor, where.journal);
    expect(rows.map((row) => [row.appId, row.name])).toEqual([['recipes', 'Recipe tracker']]);
    expect(rows[0]?.currentRelease).toBe(created.releaseId);
  }, 120_000);

  test('refuses a bad id without making anything', async () => {
    const where = makeWorld();
    await expect(
      createApplication({
        layout: where.root,
        templates: TEMPLATES,
        versions: STARTER_VERSIONS,
        appId: 'No',
        name: 'No',
        install: installedOk,
        initGit: noGit,
        logger: quiet,
      }),
    ).rejects.toThrow(/lowercase letters/);
    expect(existsSync(join(where.directory, 'apps'))).toBe(false);
  });

  test('a second creation of the same id is a conflict and changes nothing', async () => {
    const where = makeWorld();
    const first = await createApplication({
      layout: where.root,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      appId: 'recipes',
      name: 'Recipe tracker',
      install: installedOk,
      initGit: noGit,
      logger: quiet,
    });
    expect(first.ok).toBe(true);

    const before = listing(join(where.directory, 'apps'));
    await expect(
      createApplication({
        layout: where.root,
        templates: TEMPLATES,
        versions: STARTER_VERSIONS,
        appId: 'recipes',
        name: 'Something else',
        install: installedOk,
        initGit: noGit,
        logger: quiet,
      }),
    ).rejects.toThrow(/already exists/);
    expect(listing(join(where.directory, 'apps'))).toEqual(before);
  }, 120_000);

  test('an install that failed still leaves a workspace, and says so', async () => {
    const where = makeWorld();
    const created = await createApplication({
      layout: where.root,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      appId: 'recipes',
      name: 'Recipe tracker',
      install: installFailed,
      initGit: noGit,
      logger: quiet,
    });

    // The build passes anyway here, because this repository's `node_modules`
    // is above the run root — which is exactly the state a person is in when
    // their network came back before they pressed the button again.
    expect(created.installed).toBe(false);
    expect(created.notes.some((note) => note.includes('could not install'))).toBe(true);
    expect(existsSync(join(where.root.app('recipes').source, 'autoapp.json'))).toBe(true);
    expect(created.ok).toBe(true);
  }, 120_000);

  test('a workspace that will not build returns its problems rather than throwing', async () => {
    const where = makeWorld();
    const created = await createApplication({
      layout: where.root,
      templates: templatesWith('src/shared/contract.ts', 'export const contract = {\n'),
      versions: STARTER_VERSIONS,
      appId: 'recipes',
      name: 'Recipe tracker',
      install: installFailed,
      initGit: noGit,
      logger: quiet,
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.installed).toBe(false);
    expect(created.problems.length).toBeGreaterThan(0);
    expect(readCurrent(where.root, 'recipes')).toBeNull();
    // Nothing was deleted: the workspace is there for the engineer to fix.
    expect(existsSync(join(where.root.app('recipes').source, 'autoapp.json'))).toBe(true);
  }, 120_000);

  test('a starter that asks for a capability is refused', async () => {
    const where = makeWorld();
    const manifest = JSON.parse(STARTER.files['autoapp.json'] ?? '{}') as Record<string, unknown>;
    manifest['capabilities'] = [
      { kind: 'network', hosts: ['example.com'], reason: 'nobody asked for this' },
    ];
    const created = await createApplication({
      layout: where.root,
      templates: templatesWith('autoapp.json', JSON.stringify(manifest, null, 2)),
      versions: STARTER_VERSIONS,
      appId: 'recipes',
      name: 'Recipe tracker',
      install: installedOk,
      initGit: noGit,
      logger: quiet,
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.problems.map((problem) => problem.stage)).toContain('spec');
    expect(created.problems[0]?.message).toMatch(/may not ask for a capability/);
    expect(readCurrent(where.root, 'recipes')).toBeNull();
  }, 120_000);
});

describe.skipIf(!available)('createApplication, from the blank', () => {
  test('builds, is current, and its one example passes on a preview', async () => {
    const where = makeWorld();
    const created = await createApplication({
      layout: where.root,
      templates: TEMPLATES,
      template: 'blank',
      versions: STARTER_VERSIONS,
      appId: 'recipes',
      name: 'Recipe tracker',
      install: installedOk,
      initGit: noGit,
      logger: quiet,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(readCurrent(where.root, 'recipes')).toBe(created.releaseId);

    // A release with no operations is a release like any other: the child
    // starts, serves its page, and answers the view step from the
    // specification it carries.
    const spec = readRelease(where.root, 'recipes', created.releaseId);
    expect(Object.keys(spec.contract.operations)).toEqual([]);
    expect(spec.manifest.schemaVersion).toBe(0);
    expect(spec.views.pages[0]?.title).toBe('Recipe tracker');

    const states = createCandidateStates(where.root, quiet);
    states.update('recipes', { releaseId: created.releaseId });
    await startPreview(
      { layout: where.root, supervisor: where.supervisor, states },
      'recipes',
      created.releaseId,
      { runId: 'r', callId: 'c' },
    );
    const child = states.get('recipes').preview;
    expect(child).not.toBeNull();
    if (child === null) return;
    expect(child.schemaVersion).toBe(0);
    const results = await runAcceptance(child, spec.acceptance, spec.views);
    expect(results.map((one) => [one.id, one.passed])).toEqual([['home-exists', true]]);
  }, 180_000);

  test('the default is still the items list', async () => {
    const where = makeWorld();
    const created = await createApplication({
      layout: where.root,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      appId: 'recipes',
      name: 'Recipe tracker',
      install: installedOk,
      initGit: noGit,
      logger: quiet,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const spec = readRelease(where.root, 'recipes', created.releaseId);
    expect(Object.keys(spec.contract.operations)).toContain('items.list');
  }, 120_000);
});

describe.skipIf(!available)('the route and the tool', () => {
  /** The launcher's tab over a real bridge, with a model that reaches nothing. */
  async function startTab(where: World): Promise<Harness> {
    openedUrls = [];
    const tab = createLauncherTab({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      dataDir: join(where.directory, 'launcher'),
      store: where.store,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      install: installedOk,
      initGit: noGit,
      providers: [createFakeAdapter({ script: [] })],
      fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), {
        preconnect: () => undefined,
      }) as typeof fetch,
      logger: quiet,
      openBrowser: async (url) => {
        openedUrls.push(url);
        return true;
      },
    });
    live = await harness((bridge) => tab.mount(bridge));
    return live;
  }

  test('launcher.appCreate makes one and opens it, once', async () => {
    const where = makeWorld();
    const test = await startTab(where);
    const client = await test.connect(launcherContract);

    const created = await client.call('launcher.appCreate', {
      appId: 'recipes',
      name: 'Recipe tracker',
      description: 'What to cook',
    });
    expect(created.ok).toBe(true);
    expect(created.problems).toEqual([]);
    expect(created.releaseId).toMatch(/^[0-9a-f]{32}$/);
    expect(created.opened).toBe(true);
    expect(openedUrls).toHaveLength(1);

    const listed = await client.call('launcher.appsList', undefined);
    expect(listed.apps.map((app) => app.appId)).toEqual(['recipes']);
    expect(listed.apps[0]?.serving).toBe(true);

    await client.call('launcher.appStop', { appId: 'recipes' });
    await client.close();
  }, 180_000);

  test('apps.create asks first, and creates nothing when it is refused', async () => {
    const where = makeWorld();
    const tools = engineerTools({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      states: createCandidateStates(),
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      install: installedOk,
      initGit: noGit,
      logger: quiet,
    });
    const tool = tools['apps.create'];
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const approvals = createPendingApprovals(quiet);
    const envelope: Envelope = {
      requestId: 'run-1:apps.create-1',
      channel: 'ai',
      caller: 'ai:test',
      approver: approvals,
    };
    const running = tool.execute({ appId: 'recipes', name: 'Recipes' }, envelope, new AbortController().signal);
    while (approvals.pending.length === 0) await Bun.sleep(5);
    const question = approvals.pending[0];
    expect(question?.route).toBe('apps.create');
    if (question === undefined) return;
    approvals.answer({
      requestId: question.requestId,
      approved: false,
      releaseId: question.releaseId,
      argumentsHash: question.argumentsHash,
    });

    await expect(running).rejects.toThrow();
    // Refused before anything ran: not even the directory exists.
    expect(existsSync(join(where.directory, 'apps'))).toBe(false);
  }, 60_000);

  test('apps.create with template "blank" writes the blank, not the starter', async () => {
    // The tool took `template` in its schema and, once, never read it: every
    // creation through the engineer was the starter whatever was asked. This
    // goes through the tool, not createApplication, which is where that hid.
    const where = makeWorld();
    const tools = engineerTools({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      states: createCandidateStates(),
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      install: installedOk,
      initGit: noGit,
      logger: quiet,
    });
    const tool = tools['apps.create'];
    if (tool === undefined) throw new Error('no apps.create tool');
    const approvals = createPendingApprovals(quiet);
    const envelope: Envelope = {
      requestId: 'run-1:apps.create-2',
      channel: 'ai',
      caller: 'ai:test',
      approver: approvals,
    };
    const running = tool.execute(
      { appId: 'empty', name: 'Empty', template: 'blank' },
      envelope,
      new AbortController().signal,
    );
    while (approvals.pending.length === 0) await Bun.sleep(5);
    const question = approvals.pending[0];
    if (question === undefined) throw new Error('nothing to answer');
    approvals.answer({
      requestId: question.requestId,
      approved: true,
      releaseId: question.releaseId,
      argumentsHash: question.argumentsHash,
    });
    const created = (await running) as { ok: boolean };
    expect(created.ok).toBe(true);
    const manifest = JSON.parse(readFileSync(join(where.root.app('empty').source, 'autoapp.json'), 'utf8')) as {
      migrations: unknown[];
    };
    expect(manifest.migrations).toEqual([]);
  }, 180_000);
});

describe('one implementation of the steps after the source is on disk', () => {
  test('only workspace.ts spawns an install', () => {
    const launcherSrc = join(
      import.meta.dir,
      '..',
      'packages',
      'broapp-autoapp',
      'src',
      'launcher',
    );
    const spawning: string[] = [];
    for (const entry of readdirSync(launcherSrc)) {
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(join(launcherSrc, entry), 'utf8');
      // A spawn, not the word: `PrepareOptions['install']` is a type index and
      // not a second implementation of anything.
      const occurrences = text.match(/cmd:\s*\[[^\]]*'install'/g)?.length ?? 0;
      if (occurrences > 0) spawning.push(`${entry}:${String(occurrences)}`);
    }
    // Import and create take the same steps, so there is one install in the
    // launcher and `main.ts` no longer has one of its own.
    expect(spawning).toEqual(['workspace.ts:1']);
  });

  test('the starter on disk is what the launcher would carry', () => {
    // The template in git, not a copy: a starter that has drifted from the
    // packed artefact is a button that writes something nobody reviewed.
    expect(existsSync(join(STARTER_DIR, 'autoapp.json'))).toBe(true);
    expect(Object.keys(STARTER.files).length).toBeGreaterThan(8);
  });
});
