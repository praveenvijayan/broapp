/**
 * The person's standing approval: *Work without asking* (prompt 20a).
 *
 * The rule and the file first, as pure functions; then the routes; then the
 * launcher's tab over a real bridge with a scripted model, as
 * `autoapp-engineer.test.ts` drives it, so the questions a chat turn's
 * `candidate.cycle` asks go through the real gate, the real stand-in, the run
 * store and the launcher's log.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiContract } from 'broapp/ai';
import { createFakeAdapter } from 'broapp/ai/host';
import type { FakeStep } from 'broapp/ai/host';
import { createGate } from 'broapp/host';
import { BroappProvider } from 'broapp/react';
import { mergeContracts, type OperationOutput } from 'broapp/shared';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import { standingAnswer } from 'broapp-autoapp/intent';
import { createEventLog, createEvidence, openKnowledge, type EventLog, type Knowledge } from 'broapp-autoapp/knowledge';
import {
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  type Journal,
  type LauncherTab,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout, type Layout } from 'broapp-autoapp/spec';

import { INTENT_APPROVES, STANDING_WEB, standingCovers } from '../packages/broapp-autoapp/src/engineer/standing.ts';
import type { WebBrowser } from '../packages/broapp-autoapp/src/engineer/web.ts';
import { clearStanding, readStanding, writeStanding } from '../packages/broapp-autoapp/src/launcher/standing.ts';
import { STANDING_WORDS } from '../packages/broapp-autoapp/src/launcher/standing-words.ts';
import { OverviewScreen } from '../packages/broapp-autoapp/src/launcher/ui/OverviewScreen.tsx';
import { StandingLine, StandingSwitch, standingOfferFor } from '../packages/broapp-autoapp/src/launcher/ui/StandingSettings.tsx';
import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { harness, until, type Harness } from './harness.ts';

const failure = await ensureLauncher();
if (failure !== null) console.warn(`[autoapp-standing] skipped: the launcher would not build\n${failure}`);
const available = failure === null;

const quiet = { warn: () => undefined, error: () => undefined };
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
/** Inside the repository, so a workspace can resolve `broapp`. */
const runRoot = join(import.meta.dir, '.autoapp-run');
const merged = mergeContracts(launcherContract, aiContract);

const scratch: string[] = [];
let live: Harness | null = null;
let world: World | null = null;

afterEach(async () => {
  await live?.stop();
  live = null;
  const current = world;
  world = null;
  if (current !== null) {
    current.tab.ai.close();
    await current.supervisor.stopAll(5_000).catch(() => undefined);
    current.journal.close();
    current.store.close();
    current.knowledge.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) rmSync(runRoot, { recursive: true, force: true });
});

function temporaryRoot(): Layout {
  const directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  scratch.push(directory);
  return layout(directory);
}

describe('20a: the rule', () => {
  test('standingCovers: a listed tool naming an application, any application', () => {
    for (const tool of INTENT_APPROVES) {
      expect(standingCovers(tool, { appId: 'items' })).toBe(true);
      expect(standingCovers(tool, { appId: 'books' })).toBe(true);
      // Naming no application, nobody could say which one it is about.
      expect(standingCovers(tool, {})).toBe(false);
      expect(standingCovers(tool, { appId: '' })).toBe(false);
      expect(standingCovers(tool, { appId: 7 })).toBe(false);
      expect(standingCovers(tool, null)).toBe(false);
    }
    for (const tool of ['release.activate', 'apps.create', 'intent.start', 'launcher.standingSet', 'preview.try', 'spec.read']) {
      expect(standingCovers(tool, { appId: 'items' })).toBe(false);
    }
  });

  test('standingCovers: the two web tools, which name no application', () => {
    expect(standingCovers('web.search', { query: 'bun webview' })).toBe(true);
    expect(standingCovers('web.read', { url: 'https://example.com/' })).toBe(true);
    expect(standingCovers('web.read', {})).toBe(true);
    // The person's switch only: a backlog run's answer puts them to the person.
    expect(standingAnswer('items', { tool: 'web.search', input: { query: 'bun webview' } })).toBe('defer');
    expect(standingAnswer('items', { tool: 'web.read', input: { url: 'https://example.com/' } })).toBe('defer');
  });

  test('the lists are closed: nothing on them can widen them', () => {
    expect([...INTENT_APPROVES].sort()).toEqual(
      ['candidate.build', 'candidate.cycle', 'candidate.preview', 'preview.stop', 'source.change', 'source.edit'].sort(),
    );
    expect([...STANDING_WEB].sort()).toEqual(['web.read', 'web.search']);
    expect(INTENT_APPROVES.some((tool) => tool.startsWith('launcher.'))).toBe(false);
    // No engineer tool reaches the routes: nothing under engineer/ names them.
    const engineer = join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'engineer');
    for (const file of readdirSync(engineer)) {
      expect(readFileSync(join(engineer, file), 'utf8')).not.toMatch(/standing(Set|Get)/);
    }
  });

  test('the executor still exports the rule it had, unchanged', () => {
    expect(standingAnswer('items', { tool: 'candidate.cycle', input: { appId: 'items' } })).toBe(true);
    expect(standingAnswer('items', { tool: 'candidate.cycle', input: { appId: 'books' } })).toBe('defer');
    expect(standingAnswer('items', { tool: 'release.activate', input: { appId: 'items' } })).toBe(false);
  });

  test('only the launcher tab, its routes, the overview and the command line read the file', () => {
    const src = join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src');
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name.name) && readFileSync(path, 'utf8').includes('readStanding(')) {
          readers.push(path.slice(src.length + 1));
        }
      }
    };
    walk(src);
    // Not the child (mcp, workflow), not the executor, not an application's own tab.
    expect(readers.sort()).toEqual(['launcher/app.ts', 'launcher/main.ts', 'launcher/overview.ts', 'launcher/standing.ts', 'launcher/tab.ts']);
  });
});

describe('20a: the file', () => {
  test('absent is off, and says nothing', () => {
    const root = temporaryRoot();
    const warned: string[] = [];
    expect(readStanding(root, { warn: (line) => warned.push(line) })).toEqual({ standing: false, since: null });
    expect(warned).toEqual([]);
  });

  test('unreadable, not JSON, another version, or not true: off, with one warning a read', () => {
    const root = temporaryRoot();
    const cases: [string, () => void][] = [
      ['unreadable', () => mkdirSync(root.standing)],
      ['not JSON', () => writeFileSync(root.standing, '{ on')],
      ['not an object', () => writeFileSync(root.standing, '[true]')],
      ['version 2', () => writeFileSync(root.standing, JSON.stringify({ version: 2, standing: true, since: 1 }))],
      ['standing false', () => writeFileSync(root.standing, JSON.stringify({ version: 1, standing: false, since: 1 }))],
      ['standing "yes"', () => writeFileSync(root.standing, JSON.stringify({ version: 1, standing: 'yes', since: 1 }))],
    ];
    for (const [name, make] of cases) {
      rmSync(root.standing, { recursive: true, force: true });
      make();
      const warned: string[] = [];
      expect({ name, read: readStanding(root, { warn: (line) => warned.push(line) }) }).toEqual({
        name,
        read: { standing: false, since: null },
      });
      expect({ name, warnings: warned.length }).toEqual({ name, warnings: 1 });
    }
  });

  test('on is written whole; on again keeps its since; off removes the file', () => {
    const root = temporaryRoot();
    expect(writeStanding(root, 1_000)).toEqual({ standing: true, since: 1_000 });
    expect(JSON.parse(readFileSync(root.standing, 'utf8'))).toEqual({ version: 1, standing: true, since: 1_000 });
    expect(readStanding(root)).toEqual({ standing: true, since: 1_000 });
    expect(writeStanding(root, 2_000)).toEqual({ standing: true, since: 1_000 });
    expect(existsSync(`${root.standing}.tmp`)).toBe(false);
    expect(clearStanding(root)).toEqual({ standing: false, since: null });
    expect(existsSync(root.standing)).toBe(false);
    // Off twice is off: nothing to remove is not a failure.
    expect(clearStanding(root)).toEqual({ standing: false, since: null });
  });

  test('the layout names it beside the journal and the control file', () => {
    const root = temporaryRoot();
    expect(root.standing).toBe(join(root.root, 'standing.json'));
  });
});

/** Everything one launcher-tab test built. */
interface World {
  readonly directory: string;
  readonly root: Layout;
  readonly tab: LauncherTab;
  readonly store: RunStore;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly knowledge: Knowledge;
  readonly log: EventLog;
}

/** Copy the fixture in as an application, under its own id. */
function addApp(root: Layout, appId: string): void {
  const app = root.app(appId);
  mkdirSync(app.dir, { recursive: true });
  cpSync(fixture, app.source, { recursive: true });
  const manifest = join(app.source, 'autoapp.json');
  const spec = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifest, `${JSON.stringify({ ...spec, appId, name: appId }, null, 2)}\n`);
}

/** A browser that answers from memory and remembers what it was asked; nothing opens a socket. */
function fakeBrowser(): WebBrowser & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    search: (query) => {
      calls.push(`search ${query}`);
      return Promise.resolve([{ title: `About ${query}`, url: 'https://example.com/1', snippet: query }]);
    },
    read: (url) => {
      calls.push(`read ${url}`);
      return Promise.resolve({ url, title: 'One', text: 'A page.', links: [] });
    },
  };
}

/** The launcher's tab over a real bridge, two applications, a scripted model. */
async function start(script: readonly FakeStep[], browser?: WebBrowser): Promise<World> {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'standing-'));
  const root = layout(directory);
  addApp(root, 'items');
  addApp(root, 'books');
  const dataDir = join(directory, 'launcher');
  const knowledge = openKnowledge(dataDir);
  const log = createEventLog(knowledge, { source: 'launcher', tee: quiet });
  const evidence = createEvidence(knowledge, log);
  const store = createRunStore(dataDir, quiet);
  const gate = createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, recorder: store.recorder(), logger: quiet });
  const journal = openJournal(root.journal);
  const supervisor = createSupervisor({ execPath: LAUNCHER, logger: quiet });
  const tab = createLauncherTab({
    layout: root,
    supervisor,
    journal,
    gate,
    dataDir,
    store,
    templates: TEMPLATES,
    versions: STARTER_VERSIONS,
    install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
    initGit: () => false,
    providers: [createFakeAdapter({ script })],
    fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), { preconnect: () => undefined }) as typeof fetch,
    logger: quiet,
    confirmTimeoutMs: 5_000,
    openBrowser: () => Promise.resolve(true),
    knowledge: { store: knowledge, log, evidence },
    ...(browser === undefined ? {} : { browser }),
  });
  live = await harness((bridge) => tab.mount(bridge));
  const built: World = { directory, root, tab, store, journal, supervisor, knowledge, log };
  world = built;
  const client = await live.connect(merged);
  await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
  await client.close();
  return built;
}

interface Seen {
  readonly type: string;
  readonly tool?: string;
  readonly callId?: string;
  readonly denied?: boolean;
}

/**
 * One chat turn. Every `confirm` event is answered by `answer`, as a person
 * would click; `onEvent` sees each event first.
 */
async function chat(runId: string, answer: (event: Seen) => boolean, onEvent?: (event: Seen) => void): Promise<Seen[]> {
  if (live === null) throw new Error('no harness');
  const client = await live.connect(merged);
  const events: Seen[] = [];
  let finished = false;
  await client.subscribe(
    'ai.chat',
    { runId, message: 'change it', refs: [], history: [] },
    {
      onEvent: (event) => {
        const seen = event as Seen;
        events.push(seen);
        onEvent?.(seen);
        if (seen.type === 'confirm') {
          void client.call('ai.chatConfirm', { runId, callId: seen.callId ?? '', approve: answer(seen) });
        }
        if (seen.type === 'done' || seen.type === 'error') finished = true;
      },
      onError: () => {
        finished = true;
      },
    },
  );
  await until(() => finished, 110_000, 'the turn to finish');
  await client.close();
  return events;
}

/** The gate's decisions for one run, by route, in order. */
function decisions(store: RunStore, runId: string): { route: string; decision: string; requestId: string }[] {
  return (store.getRun(runId)?.steps ?? []).map((step) => ({ route: step.route, decision: step.decision, requestId: step.requestId }));
}

/** The launcher's log events the standing approval wrote, oldest first, read from the store as they were written. */
function approvals(knowledge: Knowledge): { message: string; appId: string | null; runId: string | null; callId: string | null }[] {
  return knowledge.db
    .query<{ message: string; app_id: string | null; run_id: string | null; call_id: string | null }, []>(
      "SELECT message, app_id, run_id, call_id FROM events WHERE kind = 'log' AND message LIKE 'the standing approval approved %' ORDER BY id",
    )
    .all()
    .map((row) => ({ message: row.message, appId: row.app_id, runId: row.run_id, callId: row.call_id }));
}

const cycle = (appId: string, then: readonly FakeStep[]): FakeStep => ({
  kind: 'tool',
  name: 'candidate.cycle',
  input: { appId, message: 'Verify', hunks: [] },
  then,
});

describe.skipIf(!available)('20a: the stand-in in the launcher tab', () => {
  test('on: a cycle on either application asks nobody, the gate records confirmed, and the log says who answered', async () => {
    const w = await start([cycle('items', [cycle('books', [{ kind: 'text', chunks: ['built both'] }])])]);
    writeStanding(w.root);
    const events = await chat('run-standing-on', () => {
      throw new Error('nobody should have been asked');
    });
    expect(events.filter((event) => event.type === 'confirm')).toEqual([]);
    expect(events.some((event) => event.denied === true)).toBe(false);

    const asked = decisions(w.store, 'run-standing-on').filter((step) => step.decision !== 'allowed');
    // The patch, its build and its preview, for each application. A step is
    // recorded when it ends, so the cycle's own row follows its steps'.
    expect(asked.map((step) => `${step.route} ${step.decision}`).sort()).toEqual(
      [
        'candidate.cycle confirmed',
        'candidate.build confirmed',
        'candidate.preview confirmed',
        'candidate.cycle confirmed',
        'candidate.build confirmed',
        'candidate.preview confirmed',
      ].sort(),
    );
    expect(asked.filter((step) => step.route === 'candidate.build').every((step) => /^run-standing-on:.+\.build$/.test(step.requestId))).toBe(true);

    const logged = approvals(w.knowledge);
    expect(logged.map((row) => row.message)).toEqual([
      STANDING_WORDS.approved('candidate.cycle', 'items'),
      STANDING_WORDS.approved('candidate.build', 'items'),
      STANDING_WORDS.approved('candidate.preview', 'items'),
      STANDING_WORDS.approved('candidate.cycle', 'books'),
      STANDING_WORDS.approved('candidate.build', 'books'),
      STANDING_WORDS.approved('candidate.preview', 'books'),
    ]);
    expect(logged.every((row) => row.runId === 'run-standing-on')).toBe(true);
    expect(logged.map((row) => row.appId)).toEqual(['items', 'items', 'items', 'books', 'books', 'books']);
    expect(logged[1]?.callId ?? '').toMatch(/\.build$/);
  }, 120_000);

  test('on: a web search and a page read ask nobody, the browser is reached, and the log names the tool alone', async () => {
    const browser = fakeBrowser();
    const w = await start(
      [
        {
          kind: 'tool',
          name: 'web.search',
          input: { query: 'bun webview' },
          then: [{ kind: 'tool', name: 'web.read', input: { url: 'https://example.com/1' }, then: [{ kind: 'text', chunks: ['read it'] }] }],
        },
      ],
      browser,
    );
    writeStanding(w.root);
    const events = await chat('run-standing-web', () => {
      throw new Error('nobody should have been asked');
    });
    expect(events.filter((event) => event.type === 'confirm')).toEqual([]);
    expect(events.some((event) => event.denied === true)).toBe(false);
    expect(browser.calls).toEqual(['search bun webview', 'read https://example.com/1']);
    expect(decisions(w.store, 'run-standing-web').map((step) => [step.route, step.decision])).toEqual([
      ['web.search', 'confirmed'],
      ['web.read', 'confirmed'],
    ]);
    const logged = approvals(w.knowledge);
    expect(logged.map((row) => row.message)).toEqual([STANDING_WORDS.approved('web.search', null), STANDING_WORDS.approved('web.read', null)]);
    expect(logged.map((row) => row.appId)).toEqual([null, null]);
    expect(logged.every((row) => row.runId === 'run-standing-web')).toBe(true);
  }, 120_000);

  test('off: a web search is put to the person, and the browser is not reached when they decline', async () => {
    const browser = fakeBrowser();
    const w = await start([{ kind: 'tool', name: 'web.search', input: { query: 'bun webview' }, then: [{ kind: 'text', chunks: ['asked'] }] }], browser);
    clearStanding(w.root);
    const events = await chat('run-standing-web-off', () => false);
    expect(events.filter((event) => event.type === 'confirm').map((event) => event.tool)).toEqual(['web.search']);
    expect(browser.calls).toEqual([]);
    expect(decisions(w.store, 'run-standing-web-off').map((step) => [step.route, step.decision])).toEqual([['web.search', 'denied']]);
    expect(approvals(w.knowledge)).toEqual([]);
  }, 120_000);

  test('on: activation, creation, and a listed tool naming no application are put to the person', async () => {
    const w = await start([
      {
        kind: 'tool',
        name: 'release.activate',
        input: { appId: 'items', releaseId: 'a'.repeat(32) },
        then: [
          {
            kind: 'tool',
            name: 'apps.create',
            input: { appId: 'newone', name: 'New one' },
            then: [
              {
                kind: 'tool',
                name: 'source.edit',
                input: { message: 'no application named', hunks: [] },
                then: [{ kind: 'text', chunks: ['asked'] }],
              },
            ],
          },
        ],
      },
    ]);
    writeStanding(w.root);
    const events = await chat('run-standing-asks', () => false);
    const confirms = events.filter((event) => event.type === 'confirm').map((event) => event.tool);
    expect(confirms).toEqual(['release.activate', 'apps.create', 'source.edit']);
    // Put to the person, not refused on their behalf: the person's No is what declined them.
    expect(decisions(w.store, 'run-standing-asks').map((step) => [step.route, step.decision])).toEqual([
      ['release.activate', 'denied'],
      ['apps.create', 'denied'],
      ['source.edit', 'denied'],
    ]);
    expect(approvals(w.knowledge)).toEqual([]);
  }, 120_000);

  test('off: today, event for event — the person is asked the patch, the build and the preview', async () => {
    const w = await start([cycle('items', [{ kind: 'text', chunks: ['built'] }])]);
    const events = await chat('run-standing-off', () => true);
    expect(events.filter((event) => event.type === 'confirm').map((event) => event.tool)).toEqual([
      'candidate.cycle',
      'candidate.build',
      'candidate.preview',
    ]);
    expect(decisions(w.store, 'run-standing-off').filter((step) => step.decision !== 'allowed').map((step) => step.decision)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
    ]);
    expect(approvals(w.knowledge)).toEqual([]);
    expect(existsSync(w.root.standing)).toBe(false);
  }, 120_000);

  test('the file removed between two questions changes the answer, without a restart', async () => {
    const edit = (find: string, replace: string, then: readonly FakeStep[]): FakeStep => ({
      kind: 'tool',
      name: 'source.edit',
      input: { appId: 'items', message: 'rename', hunks: [{ path: 'src/shared/views.ts', find, replace }] },
      then,
    });
    const w = await start([
      edit("header: 'Label'", "header: 'What it is'", [edit("header: 'What it is'", "header: 'Thing'", [{ kind: 'text', chunks: ['done'] }])]),
    ]);
    writeStanding(w.root);
    const events = await chat(
      'run-standing-flip',
      () => false,
      (event) => {
        // The first edit's result is in: the person turns the switch off.
        if (event.type === 'tool-result') clearStanding(w.root);
      },
    );
    expect(events.filter((event) => event.type === 'confirm').map((event) => event.tool)).toEqual(['source.edit']);
    expect(decisions(w.store, 'run-standing-flip').map((step) => step.decision)).toEqual(['confirmed', 'denied']);
    expect(approvals(w.knowledge)).toHaveLength(1);
    expect(readFileSync(join(w.root.app('items').source, 'src', 'shared', 'views.ts'), 'utf8')).toContain("header: 'What it is'");
  }, 120_000);

  test('a backlog turn is answered by its own rule, with the file present: another application is deferred', async () => {
    const w = await start([
      {
        kind: 'tool',
        name: 'candidate.build',
        input: { appId: 'books' },
        then: [{ kind: 'text', chunks: ['asked'] }],
      },
    ]);
    writeStanding(w.root);
    const deferred: string[] = [];
    let confirmed: string | null = null;
    const turn = w.tab.ai.turn(
      { runId: 'intent-1-0001-x-a1', message: 'build it' },
      {
        // The executor's own stand-in, for a run on `items`.
        answer: (question) => {
          const decision = standingAnswer('items', question);
          if (decision === 'defer') deferred.push(question.tool);
          return decision;
        },
        onEvent: (event) => {
          if (event.type === 'confirm') confirmed = event.callId ?? null;
        },
      },
    );
    // The person's switch is on, and it still does not answer a backlog turn's
    // question: it waits in the approval table for the Backlog panel.
    await until(() => deferred.length === 1 && confirmed !== null, 10_000, 'the question to be deferred');
    await Bun.sleep(100);
    expect(decisions(w.store, 'intent-1-0001-x-a1')).toEqual([]);
    const client = await (live as Harness).connect(merged);
    const answered = (await client.call('ai.chatConfirm', { runId: 'intent-1-0001-x-a1', callId: confirmed ?? '', approve: false })).accepted;
    await client.close();
    const result = await turn;
    expect(answered).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(deferred).toEqual(['candidate.build']);
    expect(decisions(w.store, 'intent-1-0001-x-a1').map((step) => step.decision)).toEqual(['denied']);
    expect(approvals(w.knowledge)).toEqual([]);
  }, 60_000);
});

describe.skipIf(!available)('20a: the routes', () => {
  test('standingGet and standingSet, from a person; refused from anybody else; the overview says it', async () => {
    const w = await start([]);
    const client = await (live as Harness).connect(merged);
    expect(await client.call('launcher.standingGet', undefined)).toEqual({ standing: false, since: null });
    expect((await client.call('launcher.overview', undefined)).standing).toBeUndefined();

    const on = await client.call('launcher.standingSet', { standing: true });
    expect(on.standing).toBe(true);
    expect(typeof on.since).toBe('number');
    expect(await client.call('launcher.standingGet', undefined)).toEqual(on);
    expect((await client.call('launcher.overview', undefined)).standing).toBe(true);
    expect(existsSync(w.root.standing)).toBe(true);

    for (const channel of ['ai', 'mcp', 'workflow'] as const) {
      await expect(
        // An approver that says yes, so the gate lets the call through to the
        // route: what is under test is the route's own refusal.
        w.tab.app.invoke(
          'launcher.standingSet',
          { standing: false },
          { requestId: `standing-${channel}`, channel, caller: channel, approver: { ask: () => Promise.resolve(true) } },
        ),
      ).rejects.toThrow(STANDING_WORDS.onlyAPerson);
    }
    expect(readStanding(w.root).standing).toBe(true);

    expect(await client.call('launcher.standingSet', { standing: false })).toEqual({ standing: false, since: null });
    expect(existsSync(w.root.standing)).toBe(false);
    expect((await client.call('launcher.overview', undefined)).standing).toBeUndefined();
    await client.close();

    const turned = w.log
      .recent({ limit: 50 })
      .filter((row) => row.message.startsWith('the person turned'))
      .map((row) => row.message)
      .reverse();
    expect(turned).toEqual([STANDING_WORDS.turned(true), STANDING_WORDS.turned(false)]);
  }, 60_000);
});

describe('20a: the launcher page', () => {
  const html = (element: Parameters<typeof renderToString>[0]): string => renderToString(element).replaceAll('<!-- -->', '');

  test('the Settings switch: a switch with its label and hint, off and on; disabled while writing; a refusal in words', () => {
    const off = html(createElement(StandingSwitch, { standing: false, pending: false, error: null, onChange: () => undefined }));
    expect(off).toContain(STANDING_WORDS.sectionTitle);
    expect(off).toContain(STANDING_WORDS.switchLabel);
    expect(off).toContain(STANDING_WORDS.hint);
    expect(off).toMatch(/<input[^>]*role="switch"/);
    expect(off).toMatch(/<input[^>]*aria-describedby="launcher-standing-hint"/);
    expect(off).not.toMatch(/<input[^>]*checked/);
    expect(off).not.toMatch(/<input[^>]*disabled/);
    // The label names the control, so a screen reader says what it switches.
    expect(off).toMatch(/<label[^>]*for="launcher-standing"/);

    const on = html(createElement(StandingSwitch, { standing: true, pending: false, error: null, onChange: () => undefined }));
    expect(on).toMatch(/<input[^>]*checked/);

    const writing = html(createElement(StandingSwitch, { standing: false, pending: true, error: null, onChange: () => undefined }));
    expect(writing).toMatch(/<input[^>]*disabled/);
    // Not moved ahead of the disk while the write is on its way.
    expect(writing).not.toMatch(/<input[^>]*checked/);

    const unread = html(createElement(StandingSwitch, { standing: null, pending: false, error: null, onChange: () => undefined }));
    expect(unread).toMatch(/<input[^>]*disabled/);

    const refused = html(
      createElement(StandingSwitch, { standing: false, pending: false, error: STANDING_WORDS.notSaved('disk full'), onChange: () => undefined }),
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('Working without asking could not be changed: disk full');
  });

  test('the top bar: the line and Ask again, a real button', () => {
    const line = html(createElement(StandingLine, { pending: false, onAskAgain: () => undefined }));
    expect(line).toContain(STANDING_WORDS.topBarLine);
    expect(line).toMatch(/<button[^>]*type="button"[^>]*>Ask again<\/button>/);
    expect(html(createElement(StandingLine, { pending: true, onAskAgain: () => undefined }))).toMatch(/<button[^>]*disabled/);
  });

  test('the card is offered the third button for a covered question while the switch is off, and never otherwise', async () => {
    let turnedOn = 0;
    const turnOn = (): Promise<void> => {
      turnedOn += 1;
      return Promise.resolve();
    };
    const offer = standingOfferFor(false, { tool: 'candidate.build', input: { appId: 'items', hunks: [] } }, turnOn);
    expect(offer?.label).toBe(STANDING_WORDS.cardLabel);
    await offer?.grant();
    expect(turnedOn).toBe(1);
    expect(standingOfferFor(true, { tool: 'candidate.build', input: { appId: 'items' } }, turnOn)).toBeNull();
    expect(standingOfferFor(false, { tool: 'release.activate', input: { appId: 'items' } }, turnOn)).toBeNull();
    expect(standingOfferFor(false, { tool: 'apps.create', input: { appId: 'items' } }, turnOn)).toBeNull();
    expect(standingOfferFor(false, { tool: 'source.edit', input: {} }, turnOn)).toBeNull();
  });

  test('the Overview: one muted line while it is on, nothing while it is off, and no attention item', () => {
    type OverviewData = OperationOutput<typeof launcherContract, 'launcher.overview'>;
    const nothing = { inputTokens: 0, outputTokens: 0, cost: 0, atLeast: false, unpricedTokens: 0 };
    const base: OverviewData = {
      needsYou: [],
      running: null,
      spend: { task: null, run: null, today: nothing, budgetDay: null, todayByModel: [] },
      backlog: [],
      apps: [],
      recent: [],
    };
    const draw = (overview: OverviewData): string =>
      html(
        createElement(BroappProvider, {
          contract: launcherContract,
          children: createElement(OverviewScreen, {
            overview,
            stale: false,
            alerts: { permission: 'default', sound: false, onTurnOn: () => undefined, onSound: () => undefined, onTestSound: () => undefined },
            now: Date.UTC(2026, 8, 22, 12),
            onOpenTarget: () => undefined,
            onOpenBacklog: () => undefined,
            onOpenPreview: () => undefined,
            onOpenApp: () => undefined,
            onViewAll: () => undefined,
          }),
        }),
      );
    const on = draw({ ...base, standing: true });
    expect(on).toContain(`<p class="launcher__ov-standing">${STANDING_WORDS.overviewLine}</p>`);
    expect(on).toContain('Nothing needs you');
    expect(draw(base)).not.toContain(STANDING_WORDS.overviewLine);
    expect(draw({ ...base, standing: false })).not.toContain(STANDING_WORDS.overviewLine);
  });
});

describe('20a: the command line', () => {
  const main = join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'launcher', 'main.ts');
  const run = (dataDir: string, ...args: string[]): { code: number; out: string } => {
    const done = Bun.spawnSync(['bun', main, ...args], { env: { ...process.env, BROAPP_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe' });
    return { code: done.exitCode, out: `${done.stdout.toString()}${done.stderr.toString()}`.trim() };
  };

  test('standing, standing on, standing off, and status’s line', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'autoapp-'));
    scratch.push(dataDir);
    expect(run(dataDir, 'standing')).toEqual({ code: 0, out: 'off' });
    const on = run(dataDir, 'standing', 'on');
    expect(on.code).toBe(0);
    expect(on.out).toMatch(/^on since \d{4}-\d\d-\d\dT/);
    expect(run(dataDir, 'standing')).toEqual(on);
    const status = run(dataDir, 'status');
    expect(status.code).toBe(0);
    expect(status.out).toContain(`standing: ${on.out}`);
    expect(run(dataDir, 'standing', 'off')).toEqual({ code: 0, out: 'off' });
    // Off, `status` says what it said before the switch existed.
    expect(run(dataDir, 'status')).toEqual({ code: 0, out: 'No launcher is running over this root.' });
    expect(run(dataDir, 'standing', 'maybe')).toEqual({ code: 1, out: 'usage: broapp-autoapp standing [on|off]' });
  }, 30_000);
});
