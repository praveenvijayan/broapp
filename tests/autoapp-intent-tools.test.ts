/**
 * The engineer's planning tools: `intent.open`, `intent.task`, `intent.submit`.
 *
 * Two worlds. Most cases call the tools straight through the launcher's gate
 * with an envelope from the AI channel, over a built copy of the fixture; the
 * cases about a turn — what the person typed, what a turn may do after it
 * planned, what the next turn is handed — run whole turns through the
 * launcher's tab with the fake adapter scripted to make the calls, as a real
 * model would.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { aiContract } from 'broapp/ai';
import { createFakeAdapter, type FakeStep } from 'broapp/ai/host';
import type { BroappClient } from 'broapp/client';
import { createGate, createPendingApprovals } from 'broapp/host';
import type { Envelope, Gate, HostLogger } from 'broapp/host';
import { mergeContracts } from 'broapp/shared';
import { createRunStore } from 'broapp-autoapp/host';
import {
  ENGINEER_INSTRUCTIONS,
  INSTRUCTION_SECTIONS,
  PLANNING_REFUSAL,
  QUESTIONS_REFUSAL,
  UNGROUNDED,
  groundedIn,
  intentTools,
  isBlank,
  specReference,
  type IntentTools,
} from 'broapp-autoapp/engineer';
import { LABELS, openIntents, type IntentStore } from 'broapp-autoapp/intent';
import { BACKLOG_DOCUMENT_CHARS, backlogDocument, createEventLog, createEvidence, openKnowledge, type Knowledge } from 'broapp-autoapp/knowledge';
import {
  buildCandidate,
  createApplication,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  type LauncherTab,
} from 'broapp-autoapp/launcher';
import { layout, readCurrent, readRelease, setCurrent, type AppSpec, type Layout } from 'broapp-autoapp/spec';

import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { harness, type Harness } from './harness.ts';

const quiet: HostLogger = { warn: () => undefined, error: () => undefined };
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
/** Inside the repository, so a workspace can resolve `broapp` when it is built. */
const runRoot = join(import.meta.dir, '.autoapp-run');

const scratch: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
let live: Harness | null = null;

/** Built once: `items` from the fixture, and `empty` from the blank template. */
let built: string | null = null;

beforeAll(async () => {
  mkdirSync(runRoot, { recursive: true });
  built = mkdtempSync(join(runRoot, 'intent-tools-built-'));
  const root = layout(built);
  mkdirSync(root.app('items').dir, { recursive: true });
  cpSync(fixture, root.app('items').source, { recursive: true });
  const items = await buildCandidate({ layout: root, appId: 'items', logger: quiet });
  if (!items.ok) throw new Error(`the fixture did not build: ${JSON.stringify(items.problems)}`);
  setCurrent(root, 'items', items.releaseId);
  const empty = await createApplication({
    layout: root,
    templates: TEMPLATES,
    template: 'blank',
    versions: STARTER_VERSIONS,
    appId: 'empty',
    name: 'Empty',
    install: () => Promise.resolve({ ok: true, detail: '' }),
    initGit: () => false,
    logger: quiet,
  });
  if (!empty.ok) throw new Error(`the blank did not build: ${JSON.stringify(empty.problems)}`);
}, 180_000);

afterAll(() => {
  if (built !== null) rmSync(built, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) rmSync(runRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await live?.stop();
  live = null;
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Carry on; the next close may be the one that matters.
    }
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A launcher root holding a copy of both built applications. */
function freshRoot(): { root: Layout; directory: string; dataDir: string } {
  if (built === null) throw new Error('nothing was built');
  const directory = mkdtempSync(join(runRoot, 'intent-tools-'));
  scratch.push(directory);
  cpSync(join(built, 'apps'), join(directory, 'apps'), { recursive: true });
  return { root: layout(directory), directory, dataDir: join(directory, 'launcher') };
}

// ── Straight through the gate ───────────────────────────────────────────────

interface Direct {
  readonly root: Layout;
  readonly intents: IntentStore;
  readonly gate: Gate;
  readonly planning: IntentTools;
}

function direct(): Direct {
  const { root, dataDir } = freshRoot();
  const intents = openIntents(dataDir);
  const store = createRunStore(dataDir, quiet);
  const gate = createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, recorder: store.recorder(), logger: quiet });
  closers.push(() => intents.close(), () => store.close());
  const knowledge = openKnowledge(dataDir);
  closers.push(() => knowledge.close());
  const planning = intentTools({
    layout: root,
    gate,
    intents,
    logger: quiet,
    // No turn record: a direct call has no tab that saw the person type.
    knowledge: { log: createEventLog(knowledge, { source: 'launcher', tee: quiet }) },
  });
  return { root, intents, gate, planning };
}

let calls = 0;
/** Call one of the three as the AI channel would, in turn `run-1` unless told otherwise. */
async function call(where: Direct, name: string, input: unknown, runId = 'run-1'): Promise<Record<string, unknown>> {
  const tool = where.planning.tools[name];
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  calls += 1;
  const envelope: Envelope = {
    requestId: `${runId}:call-${String(calls)}`,
    channel: 'ai',
    caller: 'ai:test',
    approver: createPendingApprovals(quiet),
  };
  return (await tool.execute(input, envelope, new AbortController().signal)) as Record<string, unknown>;
}

/** An analysis of a request against `items`, with whatever a case changes. */
function analysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: 'items',
    restated: 'Tag each item, and filter the items table by one tag.',
    fits: 'Builds on items.list and items.add, and on the items-table component.',
    conflicts: [],
    outOfReach: [],
    assumptions: ['A tag is one lowercase word.'],
    questions: [],
    ...overrides,
  };
}

/** A task as the model sends it, valid unless a case says otherwise. */
function task(intentId: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId,
    words: 'add-tags',
    title: 'Add a tags column to the items table',
    priority: 'medium',
    labels: ['contract', 'views'],
    blockedBy: [],
    estimatedLines: 80,
    summary: 'Each item carries tags, and the table shows them beside its label.',
    criteria: [
      { text: 'items.list returns each item with its tags', failure: false },
      { text: 'An item with no tags shows an empty cell, never an error', failure: true },
    ],
    reasoning: 'medium',
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (cause) {
    const error = cause as { code?: unknown; message?: unknown };
    return { code: String(error.code), message: String(error.message) };
  }
  throw new Error('it was not refused');
}

describe('groundedIn', () => {
  const spec = {
    contract: { operations: { 'items.list': {}, 'items.add': {} }, streams: { 'items.watch': {} } },
    views: {
      specVersion: 1,
      home: 'items',
      pages: [
        {
          id: 'items',
          title: 'Items',
          children: [{ id: 'overview', kind: 'section', children: [{ id: 'items-table', kind: 'table' }] }],
        },
      ],
    },
  } as unknown as Pick<AppSpec, 'contract' | 'views'>;

  test('finds routes, pages and nested components as whole words, and nothing inside a longer name', () => {
    expect(groundedIn('It builds on items.list.', spec)).toEqual(['items.list']);
    expect(groundedIn('The items page', spec)).toEqual(['items']);
    expect(groundedIn('The `items-table` component, inside overview', spec).sort()).toEqual(['items-table', 'overview']);
    expect(groundedIn('A watch over items.watch', spec)).toContain('items.watch');
    // Part of a longer identifier is not the identifier.
    expect(groundedIn('The old-items-table and itemsx and items.listing', spec)).toEqual([]);
    expect(groundedIn('Something new that has nothing to do with this.', spec)).toEqual([]);
  });

  test('a specification with no routes is blank', () => {
    expect(isBlank(spec)).toBe(false);
    expect(isBlank({ contract: { operations: {}, streams: {} } })).toBe(true);
  });
});

// ── 2. The grounding check ──────────────────────────────────────────────────

describe('intent.open', () => {
  test('refuses a fits that names nothing, passes one that names a real route, and skips a blank application', async () => {
    const where = direct();
    const refused = await refusal(call(where, 'intent.open', analysis({ fits: 'It builds on the tagging system that exists.' })));
    expect(refused).toEqual({ code: 'invalid_input', message: UNGROUNDED });
    expect(where.intents.list({ appId: 'items' })).toEqual([]);

    const opened = await call(where, 'intent.open', analysis({ fits: 'Builds on items.list, which returns every item.' }));
    expect(opened).toMatchObject({ status: 'draft', waitingForAnswers: false });
    expect(where.intents.list({ appId: 'items' })).toHaveLength(1);

    // The blank has an empty contract: there is nothing yet to build on.
    const spec = readRelease(where.root, 'empty', readCurrent(where.root, 'empty') ?? '');
    expect(isBlank(spec)).toBe(true);
    const blank = await call(where, 'intent.open', analysis({ appId: 'empty', fits: 'Nothing yet: the page is empty and so is the contract.' }));
    expect(blank).toMatchObject({ status: 'draft' });
  }, 60_000);

  // ── 3. One draft per application ───────────────────────────────────────────

  test('a second open replaces the analysis and keeps the tasks; it is refused while an intent runs', async () => {
    const where = direct();
    const first = await call(where, 'intent.open', analysis());
    const id = first['intentId'] as number;
    expect((await call(where, 'intent.task', task(id)))['ok']).toBe(true);

    const second = await call(where, 'intent.open', analysis({ restated: 'Tag items; a filter by tag comes later on.' }));
    expect(second['intentId']).toBe(id);
    expect(where.intents.list({ appId: 'items' })).toHaveLength(1);
    const detail = where.intents.get(id);
    expect(detail?.intent.restated).toBe('Tag items; a filter by tag comes later on.');
    expect(detail?.tasks).toHaveLength(1);

    where.intents.db.query('UPDATE intents SET status = ? WHERE id = ?').run('running', id);
    const refused = await refusal(call(where, 'intent.open', analysis()));
    expect(refused.code).toBe('conflict');
    expect(refused.message).toMatch(/running/);
  }, 60_000);

  test('without a turn record the restatement is stored as the request, and it says so', async () => {
    const where = direct();
    const opened = await call(where, 'intent.open', analysis());
    expect(opened['note']).toMatch(/restatement is stored as the request/);
    expect(where.intents.get(opened['intentId'] as number)?.intent.request).toBe(analysis()['restated'] as string);
  }, 60_000);
});

// ── 4. Questions hold the split ─────────────────────────────────────────────

describe('open questions', () => {
  test('stop intent.task and intent.submit until an open with none', async () => {
    const where = direct();
    const opened = await call(where, 'intent.open', analysis({ questions: ['Should a tag be free text, or chosen from a list?'] }));
    expect(opened['waitingForAnswers']).toBe(true);
    const id = opened['intentId'];
    expect(await refusal(call(where, 'intent.task', task(id)))).toEqual({ code: 'conflict', message: QUESTIONS_REFUSAL });
    expect(await refusal(call(where, 'intent.submit', { intentId: id }))).toEqual({ code: 'conflict', message: QUESTIONS_REFUSAL });

    const answered = await call(where, 'intent.open', analysis({ assumptions: ['A tag is free text, as the person said.'] }));
    expect(answered).toMatchObject({ intentId: id, waitingForAnswers: false });
    expect((await call(where, 'intent.task', task(id)))['ok']).toBe(true);
    expect((await call(where, 'intent.submit', { intentId: id }))['ok']).toBe(true);
  }, 60_000);
});

// ── 5. intent.task ──────────────────────────────────────────────────────────

describe('intent.task', () => {
  test('a plan problem is ok: false with the field named, and nothing stored; then host-assigned slug, tier and ids; replaces keeps the slug', async () => {
    const where = direct();
    const id = (await call(where, 'intent.open', analysis()))['intentId'] as number;

    const wrong = await call(where, 'intent.task', task(id, { estimatedLines: 900, priority: 'urgent' }));
    expect(wrong['ok']).toBe(false);
    const fields = (wrong['problems'] as { field: string; message: string }[]).map((problem) => problem.field);
    expect(fields).toContain('estimatedLines');
    expect(fields).toContain('priority');
    expect(wrong['next']).toBe('Fix these fields and call intent.task again.');
    expect(where.intents.get(id)?.tasks).toHaveLength(0);

    const stored = await call(where, 'intent.task', task(id, { labels: ['migration', 'contract'] }));
    expect(stored).toMatchObject({
      ok: true,
      slug: '0001-add-tags',
      tier: 'deep',
      exampleIds: ['0001-add-tags-c1', '0001-add-tags-c2'],
      model: 'the model chosen in Settings',
    });
    expect(stored['tierReasons']).toContain('It changes a migration.');

    const rewritten = await call(
      where,
      'intent.task',
      task(id, { replaces: '0001-add-tags', words: 'ignored-on-replace', labels: ['views'], estimatedLines: 30, reasoning: 'low' }),
    );
    expect(rewritten).toMatchObject({ ok: true, slug: '0001-add-tags', tier: 'light' });
    const tasks = where.intents.get(id)?.tasks ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.labels).toEqual(['views']);

    // An optional text sent empty is absent: the by-hand run's model sent
    // `replaces: ""` with a new task, and was told "" was not a task.
    const added = await call(where, 'intent.task', task(id, { words: 'tag-list', title: 'List every tag in use', replaces: '', repaidBy: '' }));
    expect(added).toMatchObject({ ok: true, slug: '0002-tag-list' });
  }, 60_000);
});

// ── 6. intent.submit ────────────────────────────────────────────────────────

describe('intent.submit', () => {
  test('names a dangling blockedBy, a cycle, and an empty intent', async () => {
    const where = direct();
    const id = (await call(where, 'intent.open', analysis()))['intentId'] as number;

    const empty = await call(where, 'intent.submit', { intentId: id });
    expect(empty['ok']).toBe(false);
    expect(empty['problems']).toEqual([expect.objectContaining({ field: 'tasks', message: expect.stringMatching(/no tasks/) })]);

    // A task may name one not planned yet; submit is where that is checked.
    const waits = await call(where, 'intent.task', task(id, { words: 'filter-by-tag', title: 'Filter the table by one tag', blockedBy: ['0009-never-planned'] }));
    expect(waits['ok']).toBe(true);
    const dangling = await call(where, 'intent.submit', { intentId: id });
    expect(dangling['ok']).toBe(false);
    expect(dangling['problems']).toEqual([
      { field: 'blockedBy', message: '0001-filter-by-tag is blocked by 0009-never-planned, which is not a task of this application.' },
    ]);
    expect(where.intents.get(id)?.intent.submittedAt).toBeNull();

    // A cycle cannot be written through the tools, whose every task is checked
    // against the graph as it is added; a row changed by hand is what submit's
    // own check is for.
    await call(where, 'intent.task', task(id, { replaces: '0001-filter-by-tag', words: 'filter-by-tag', title: 'Filter the table by one tag' }));
    const other = await call(where, 'intent.task', task(id, { words: 'tag-list', title: 'List every tag in use', blockedBy: ['0001-filter-by-tag'] }));
    where.intents.db.query('UPDATE tasks SET blocked_by = ? WHERE slug = ?').run(JSON.stringify([other['slug']]), '0001-filter-by-tag');
    const cycle = await call(where, 'intent.submit', { intentId: id });
    expect(cycle['ok']).toBe(false);
    expect(JSON.stringify(cycle['problems'])).toMatch(/cycle: 0001-filter-by-tag → 0002-tag-list → 0001-filter-by-tag/);

    where.intents.db.query('UPDATE tasks SET blocked_by = ? WHERE slug = ?').run('[]', '0001-filter-by-tag');
    const submitted = await call(where, 'intent.submit', { intentId: id });
    expect(submitted).toMatchObject({
      ok: true,
      tasks: [
        { slug: '0001-filter-by-tag', blockedBy: [] },
        { slug: '0002-tag-list', blockedBy: ['0001-filter-by-tag'] },
      ],
      next: 'Tell the person the plan is in the Backlog panel, in one or two sentences. Do not list the tasks in the chat. Do not start any of them.',
    });
    expect(where.intents.get(id)?.intent.submittedAt).not.toBeNull();
  }, 60_000);
});

// ── 7. Only a draft ─────────────────────────────────────────────────────────

describe('once the intent is not a draft', () => {
  test('all three refuse with conflict', async () => {
    const where = direct();
    const id = (await call(where, 'intent.open', analysis()))['intentId'] as number;
    await call(where, 'intent.task', task(id));

    for (const status of ['stopped', 'withdrawn', 'done'] as const) {
      where.intents.db.query('UPDATE intents SET status = ? WHERE id = ?').run(status, id);
      expect((await refusal(call(where, 'intent.task', task(id, { words: 'another' })))).code).toBe('conflict');
      expect((await refusal(call(where, 'intent.submit', { intentId: id }))).code).toBe('conflict');
    }
    // `intent.open` names an application, not an intent: while one runs, it is refused.
    where.intents.db.query('UPDATE intents SET status = ? WHERE id = ?').run('running', id);
    expect((await refusal(call(where, 'intent.open', analysis()))).code).toBe('conflict');
    expect((await refusal(call(where, 'intent.task', task(id, { words: 'another' })))).code).toBe('conflict');
    expect((await refusal(call(where, 'intent.submit', { intentId: id }))).code).toBe('conflict');
  }, 60_000);
});

// ── Through the launcher's tab, turn by turn ────────────────────────────────

const launcherAndAi = mergeContracts(launcherContract, aiContract);
type LauncherClient = BroappClient<typeof launcherAndAi>;

interface TabWorld {
  readonly root: Layout;
  readonly intents: IntentStore;
  readonly knowledge: Knowledge;
  readonly tab: LauncherTab;
}

function tabWorld(script: readonly FakeStep[]): TabWorld {
  const { root, dataDir } = freshRoot();
  const intents = openIntents(dataDir);
  const knowledge = openKnowledge(dataDir);
  const log = createEventLog(knowledge, { source: 'launcher', tee: quiet });
  const store = createRunStore(dataDir, quiet);
  const journal = openJournal(root.journal);
  const supervisor = createSupervisor({ logger: quiet });
  const gate = createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, recorder: store.recorder(), logger: quiet });
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
    openBrowser: () => Promise.resolve(true),
    knowledge: { store: knowledge, log, evidence: createEvidence(knowledge, log) },
    intents,
    distil: false,
  });
  closers.push(
    () => supervisor.stopAll(5_000),
    () => journal.close(),
    () => store.close(),
    () => intents.close(),
    () => tab.ai.close(),
    () => knowledge.close(),
  );
  return { root, intents, knowledge, tab };
}

async function connect(tab: LauncherTab): Promise<LauncherClient> {
  live = await harness((bridge) => tab.mount(bridge));
  const client = await live.connect(launcherAndAi);
  closers.push(() => client.close());
  await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
  return client;
}

interface Seen {
  readonly type: string;
  readonly tool?: string;
  readonly output?: unknown;
  readonly callId?: string;
}

/** One turn, approving whatever it asks, to its end; every event it emitted. */
async function turn(client: LauncherClient, knowledge: Knowledge, runId: string, message: string): Promise<Seen[]> {
  const seen: Seen[] = [];
  let finished = false;
  const asked = new Set<string>();
  await client.subscribe(
    'ai.chat',
    { runId, message, refs: [], history: [] },
    {
      onEvent: (event) => {
        const one = event as Seen;
        seen.push(one);
        if (one.type === 'confirm' && one.callId !== undefined && !asked.has(one.callId)) {
          asked.add(one.callId);
          void client.call('ai.chatConfirm', { runId, callId: one.callId, approve: true });
        }
        if (one.type === 'done' || one.type === 'error') finished = true;
      },
      onError: () => {
        finished = true;
      },
    },
  );
  const deadline = Date.now() + 20_000;
  while (!finished && Date.now() < deadline) await Bun.sleep(10);
  // The turn's end hooks run after `done`; wait for the one that writes its row.
  while (Date.now() < deadline) {
    const row = knowledge.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = 'run' AND run_id = ?").get(runId);
    if ((row?.n ?? 0) > 0) break;
    await Bun.sleep(10);
  }
  return seen;
}

function tool(name: string, input: unknown, then: readonly FakeStep[] = [{ kind: 'text', chunks: ['done'] }]): FakeStep {
  return { kind: 'tool', name, input, then };
}

function results(seen: readonly Seen[], name: string): unknown[] {
  return seen.filter((event) => event.type === 'tool-result' && event.tool === name).map((event) => event.output);
}

/** What a turn was given, ref by ref, from its `contexts` row. */
function delivered(knowledge: Knowledge, runId: string): Map<string, string> {
  const row = knowledge.db.query<{ included: string }, [string]>('SELECT included FROM contexts WHERE run_id = ?').get(runId);
  const entries = JSON.parse(row?.included ?? '[]') as { ref: string; blob: string }[];
  return new Map(entries.map((entry) => [entry.ref, knowledge.getBlob(entry.blob) ?? '']));
}

describe('in a turn', () => {
  // ── 1. The request is what the person typed ────────────────────────────────

  test('intent.open stores the typed message as the request, not the restatement', async () => {
    const typed = 'In items, add tags, a filter by tag, and a count of items per tag.';
    const world = tabWorld([tool('intent.open', analysis())]);
    const client = await connect(world.tab);
    await turn(client, world.knowledge, 'run-typed', typed);
    const [intent] = world.intents.list({ appId: 'items' });
    const stored = world.intents.get(intent?.id ?? 0)?.intent;
    expect(stored?.request).toBe(typed);
    expect(stored?.restated).toBe(analysis()['restated'] as string);
    expect(stored?.proposedByRun).toBe('run-typed');
    expect(stored?.hubModel).toBe('fake-1');
  }, 60_000);

  // ── 8. Drafting asks nobody ────────────────────────────────────────────────

  test('none of the three asks a question on channel ai, and each accepted call is logged', async () => {
    const world = tabWorld([
      tool('intent.open', analysis(), [
        tool('intent.task', task(1), [tool('intent.submit', { intentId: 1 }, [{ kind: 'text', chunks: ['The plan is in the Backlog panel.'] }])]),
      ]),
    ]);
    const client = await connect(world.tab);
    const seen = await turn(client, world.knowledge, 'run-quiet', 'In items, add tags and a filter by tag.');
    expect(seen.filter((event) => event.type === 'confirm')).toEqual([]);
    expect(results(seen, 'intent.submit')).toEqual([expect.objectContaining({ ok: true })]);
    const messages = world.knowledge.db
      .query<{ message: string; level: string }, []>("SELECT message, level FROM events WHERE kind = 'log' ORDER BY id")
      .all()
      .filter((row) => /^(intent|task) /.test(row.message));
    expect(messages).toEqual([
      { message: 'intent 1 opened for items', level: 'info' },
      { message: 'task 0001-add-tags proposed (standard)', level: 'info' },
      { message: 'intent 1 submitted with 1 tasks', level: 'info' },
    ]);
  }, 60_000);

  // ── 9. A turn that plans cannot edit ───────────────────────────────────────

  test('source.edit is refused in the turn that planned, and not in the next', async () => {
    const edit = {
      appId: 'items',
      message: 'rename the label column',
      hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }],
    };
    const world = tabWorld([tool('intent.open', analysis(), [tool('source.edit', edit)]), tool('source.edit', edit)]);
    const client = await connect(world.tab);

    const planned = await turn(client, world.knowledge, 'run-plan', 'In items, add tags and a filter by tag.');
    expect(results(planned, 'source.edit')).toEqual([{ error: PLANNING_REFUSAL }]);
    // Refused before anybody was asked: nothing ran, so there was nothing to decide.
    expect(planned.filter((event) => event.type === 'confirm')).toEqual([]);
    const views = join(world.root.app('items').source, 'src', 'shared', 'views.ts');
    expect(readFileSync(views, 'utf8')).toContain("header: 'Label'");

    const next = await turn(client, world.knowledge, 'run-next', 'Now rename the Label column in items.');
    expect(results(next, 'source.edit')).toEqual([expect.objectContaining({ changed: ['src/shared/views.ts'] })]);
    expect(readFileSync(views, 'utf8')).toContain("header: 'What it is'");
  }, 60_000);

  // ── 10. The next turn is handed the backlog ────────────────────────────────

  test('the next turn is given intent:<appId>, one line per task, and the context row records it', async () => {
    const world = tabWorld([
      tool('intent.open', analysis(), [
        tool('intent.task', task(1), [
          tool('intent.task', task(1, { words: 'filter-by-tag', title: 'Filter the table by one tag', blockedBy: ['0001-add-tags'] })),
        ]),
      ]),
      { kind: 'text', chunks: ['The backlog has two tasks.'] },
    ]);
    const client = await connect(world.tab);

    await turn(client, world.knowledge, 'run-first', 'In items, add tags and a filter by tag.');
    // Before the intent existed, the turn was given no backlog.
    expect([...delivered(world.knowledge, 'run-first').keys()]).not.toContain('intent:items');

    await turn(client, world.knowledge, 'run-second', 'How is the items backlog going?');
    const documents = delivered(world.knowledge, 'run-second');
    const refs = [...documents.keys()];
    expect(refs).toContain('intent:items');
    // After the orientation, before the evidence.
    expect(refs.indexOf('intent:items')).toBe(refs.indexOf('digest:items') + 1);
    const text = documents.get('intent:items') ?? '';
    expect(text).toContain('Intent 1 (draft, being written)');
    expect(text).toContain('- 0001-add-tags · proposed · standard · Add a tags column to the items table');
    expect(text).toContain('- 0002-filter-by-tag · proposed · standard · Filter the table by one tag');
    expect(text.length).toBeLessThanOrEqual(BACKLOG_DOCUMENT_CHARS);

    // An application with no live intent gets none: the same intent, withdrawn.
    world.intents.withdraw(1);
    expect(backlogDocument(world.intents, 'items')).toBeNull();
    expect(backlogDocument(world.intents, 'empty')).toBeNull();
  }, 60_000);
});

// ── 11. The words the model is given ────────────────────────────────────────

describe('what the engineer is told', () => {
  test('the instructions keep their five headings and name the three tools; the intents topic names every label', () => {
    for (const section of INSTRUCTION_SECTIONS) expect(ENGINEER_INSTRUCTIONS).toContain(section);
    for (const name of ['intent.open', 'intent.task', 'intent.submit']) expect(ENGINEER_INSTRUCTIONS).toContain(`\`${name}\``);
    expect(ENGINEER_INSTRUCTIONS.split('\n').length).toBeLessThanOrEqual(72);
    const topic = specReference('intents');
    for (const label of LABELS) expect(topic).toContain(`\`${label}\``);
    expect(topic).toMatch(/^# intents /);
  });
});
