/**
 * The backlog: intents, tasks as plans, tiers, and the panel that shows them.
 *
 * The plan format, its validator and the tier rule are pure and tested on
 * their own. The store is tested over a fresh directory. The routes are tested
 * over a real bridge, through the launcher's tab, the way the panel reaches
 * them; and the panel is drawn from what those routes return.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiContract } from 'broapp/ai';
import { createFakeAdapter } from 'broapp/ai/host';
import type { BroappClient } from 'broapp/client';
import { createGate } from 'broapp/host';
import type { HostLogger } from 'broapp/host';
import { mergeContracts } from 'broapp/shared';
import { createRunStore } from 'broapp-autoapp/host';
import { createCandidateStates, engineerTools } from 'broapp-autoapp/engineer';
import {
  INTENT_STATUSES,
  LAST_CRITERION,
  MAX_TASKS_PER_INTENT,
  TASK_MOVES,
  TASK_STATUSES,
  isAllowedMove,
  modelFor,
  openIntents,
  readTierModels,
  renderPlan,
  tierOf,
  validateGraph,
  validateTask,
  type IntentStore,
  type RenderableTask,
  type StoredTaskStatus,
  type TaskInput,
} from 'broapp-autoapp/intent';
import {
  INTENT_STATUS_NAMES,
  TASK_STATUS_NAMES,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  type LauncherTab,
} from 'broapp-autoapp/launcher';
import { layout, type Layout } from 'broapp-autoapp/spec';

import { BACKLOG_EMPTY, IntentPanel, TierModelsBlock, inheritedModel } from '../packages/broapp-autoapp/src/launcher/ui/IntentPanel.tsx';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { harness, type Harness } from './harness.ts';

const quiet: HostLogger = { warn: () => undefined, error: () => undefined };
const scratch: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
let live: Harness | null = null;

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

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  scratch.push(directory);
  return directory;
}

function openStore(): IntentStore {
  const store = openIntents(join(tempDir(), 'launcher'));
  closers.push(() => store.close());
  return store;
}

/** A valid task, with whatever a case changes. */
function taskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    title: 'Add a tags column to the items table',
    priority: 'medium',
    labels: ['views'],
    blockedBy: [],
    estimatedLines: 40,
    locks: [],
    risk: 'normal',
    stub: false,
    summary: 'Show each item’s tags beside its label, so a person can scan by tag.',
    criteria: [
      { text: 'The items table has a Tags column', failure: false },
      { text: 'An item with no tags shows an empty cell, never an error', failure: true },
    ],
    reasoning: 'low',
    ...overrides,
  };
}

function fieldsOf(problems: readonly { field: string }[]): string[] {
  return problems.map((problem) => problem.field);
}

// ── 1. validateTask ─────────────────────────────────────────────────────────

describe('validateTask', () => {
  const siblings = [
    { slug: '0001-add-tags', stored: 'proposed' as const },
    { slug: '0002-gone', stored: 'removed' as const },
  ];

  test('a valid task has no problems', () => {
    expect(validateTask(taskInput(), siblings)).toEqual([]);
  });

  test('names the field for each refusal', () => {
    const cases: [Partial<TaskInput>, string, RegExp][] = [
      [{ labels: ['views', 'database' as never] }, 'labels', /database/],
      [{ estimatedLines: 401 }, 'estimated_lines', /401/],
      [{ stub: true }, 'repaid_by', /stub needs repaid_by/],
      [{ repaidBy: '0001-add-tags' }, 'repaid_by', /only for a stub/],
      [{ criteria: [{ text: 'One thing happens', failure: true }] }, 'criteria', /1 entries/],
      [
        { criteria: [{ text: 'One', failure: false }, { text: 'Two', failure: false }] },
        'criteria',
        /what the person sees when it goes wrong/,
      ],
      [{ blockedBy: ['0099-nothing'] }, 'blocked_by', /0099-nothing/],
      [{ blockedBy: ['0002-gone'] }, 'blocked_by', /0002-gone/],
      [{ title: 'Add tags.' }, 'title', /full stop/],
      [{ summary: 'Too short' }, 'summary', /20 to 400/],
      [{ locks: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'locks', /at most 5/],
      [{ testNotes: ['1', '2', '3', '4', '5', '6', '7'] }, 'test_notes', /at most 6/],
    ];
    for (const [overrides, field, message] of cases) {
      const problems = validateTask(taskInput(overrides), siblings);
      expect(fieldsOf(problems)).toContain(field);
      expect(problems.find((problem) => problem.field === field)?.message).toMatch(message);
    }
  });

  test('a task may not block itself', () => {
    const problems = validateTask(taskInput({ blockedBy: ['0001-add-tags'] }), siblings, '0001-add-tags');
    expect(problems).toEqual([{ field: 'blocked_by', message: 'blocked_by names this task itself (0001-add-tags).' }]);
  });

  test('no_failure_path stands in for a failure criterion, within its limits', () => {
    const none = [{ text: 'One', failure: false }, { text: 'Two', failure: false }];
    expect(validateTask(taskInput({ criteria: none, noFailurePath: 'It only renames a heading nobody acts on.' }), siblings)).toEqual([]);
    expect(fieldsOf(validateTask(taskInput({ criteria: none, noFailurePath: 'short' }), siblings))).toEqual(['no_failure_path']);
  });
});

// ── 2. validateGraph ────────────────────────────────────────────────────────

describe('validateGraph', () => {
  test('refuses a three-task cycle and names all three', () => {
    const problems = validateGraph([
      { slug: '0001-a', intentId: 1, blockedBy: ['0003-c'], stored: 'proposed' },
      { slug: '0002-b', intentId: 1, blockedBy: ['0001-a'], stored: 'proposed' },
      { slug: '0003-c', intentId: 1, blockedBy: ['0002-b'], stored: 'proposed' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('blocked_by');
    for (const slug of ['0001-a', '0002-b', '0003-c']) expect(problems[0]?.message).toContain(slug);
  });

  test('refuses a thirteenth live task in one intent, and not a removed one', () => {
    const tasks = Array.from({ length: MAX_TASKS_PER_INTENT }, (_, index) => ({
      slug: `${String(index + 1).padStart(4, '0')}-t`,
      intentId: 1,
      blockedBy: [],
      stored: 'proposed' as StoredTaskStatus,
    }));
    expect(validateGraph(tasks)).toEqual([]);
    expect(validateGraph([...tasks, { slug: '0013-t', intentId: 1, blockedBy: [], stored: 'removed' }])).toEqual([]);
    const problems = validateGraph([...tasks, { slug: '0013-t', intentId: 1, blockedBy: [], stored: 'proposed' }]);
    expect(fieldsOf(problems)).toEqual(['tasks']);
    expect(problems[0]?.message).toContain('13 live tasks');
  });
});

// ── 3. renderPlan ───────────────────────────────────────────────────────────

describe('renderPlan', () => {
  const full: RenderableTask = {
    slug: '0007-add-tags',
    title: 'Add tags to items',
    priority: 'high',
    labels: ['contract', 'migration', 'views'],
    blockedBy: ['0005-add-tag-table', '0006-seed-tags'],
    estimatedLines: 120,
    locks: ['src/shared/contract.ts'],
    risk: 'high',
    stub: true,
    repaidBy: '0009-real-tag-search',
    summary: 'Items carry tags. A person filters the table by one.',
    criteria: [
      { id: 'c1', text: 'An item can be given a tag from its form', failure: false },
      { id: 'c2', text: 'A tag over 40 characters is refused with a sentence saying so', failure: true, passed: true },
    ],
    noFailurePath: null,
    nonFunctional: ['The items page still loads under 200 ms with 1,000 items'],
    testNotes: ['Seed three items with overlapping tags'],
    runbook: ['Open the items page', 'Add the tag urgent to one item'],
  };

  test('a full task renders byte for byte, with the host-written last criterion', () => {
    expect(renderPlan(full)).toBe(
      [
        '---',
        'title: Add tags to items',
        'priority: high',
        'labels: [contract, migration, views]',
        'blocked_by: [0005-add-tag-table, 0006-seed-tags]',
        'estimated_lines: 120',
        'locks: [src/shared/contract.ts]',
        'risk: high',
        'stub: true',
        'repaid_by: 0009-real-tag-search',
        '---',
        '',
        'Items carry tags. A person filters the table by one.',
        '',
        '## Acceptance criteria',
        '- [ ] An item can be given a tag from its form',
        '- [x] A tag over 40 characters is refused with a sentence saying so',
        '- [ ] Every criterion above has exactly one test named after it',
        '',
        '## Non-functional',
        '- The items page still loads under 200 ms with 1,000 items',
        '',
        '## Test notes',
        '- Seed three items with overlapping tags',
        '',
        '## Human runbook',
        '- Open the items page',
        '- Add the tag urgent to one item',
        '',
      ].join('\n'),
    );
  });

  test('a minimal task has no optional sections, and a reason in place of a failure criterion', () => {
    const minimal: RenderableTask = {
      ...full,
      blockedBy: [],
      locks: [],
      stub: false,
      repaidBy: null,
      criteria: full.criteria.map((criterion) => ({ ...criterion, failure: false, passed: false })),
      noFailurePath: 'It renames a heading and nothing can fail.',
      nonFunctional: [],
      testNotes: [],
      runbook: [],
    };
    const text = renderPlan(minimal);
    expect(text).not.toContain('repaid_by');
    expect(text).not.toContain('## Non-functional');
    expect(text).not.toContain('## Test notes');
    expect(text).not.toContain('## Human runbook');
    expect(text).toContain('blocked_by: []\n');
    expect(text.endsWith(`- [ ] No failure path: It renames a heading and nothing can fail.\n- [ ] ${LAST_CRITERION}\n`)).toBe(true);
  });
});

// ── 4. tierOf ───────────────────────────────────────────────────────────────

describe('tierOf', () => {
  const base = { risk: 'normal', labels: ['views'], reasoning: 'low', estimatedLines: 40, blockedBy: [] } as const;

  test('one case per deep rule, each with its sentence', () => {
    const cases: [Partial<Parameters<typeof tierOf>[0]>, string][] = [
      [{ risk: 'high' }, 'It is marked high risk.'],
      [{ labels: ['migration'] }, 'It changes a migration.'],
      [{ reasoning: 'high' }, 'It needs deep reasoning.'],
      [{ estimatedLines: 201 }, 'It is estimated at more than 200 lines.'],
      [{ blockedBy: ['0001-a', '0002-b'] }, 'It waits on two or more other tasks.'],
    ];
    for (const [overrides, reason] of cases) {
      expect(tierOf({ ...base, ...overrides })).toEqual({ tier: 'deep', reasons: [reason] });
    }
  });

  test('light when small, low reasoning, and only views, theme or copy; standard otherwise', () => {
    expect(tierOf({ ...base, labels: ['views', 'theme', 'copy'] })).toEqual({
      tier: 'light',
      reasons: ['It is 60 lines or fewer, needs little reasoning, and touches only views, theme or copy.'],
    });
    expect(tierOf({ ...base, estimatedLines: 61 }).tier).toBe('standard');
    expect(tierOf({ ...base, reasoning: 'medium' }).tier).toBe('standard');
    expect(tierOf({ ...base, labels: ['views', 'host'] })).toEqual({
      tier: 'standard',
      reasons: ['It is neither small enough to be light nor risky enough to be deep.'],
    });
  });

  test('a task matching a deep rule and every light rule is deep', () => {
    expect(tierOf({ ...base, risk: 'high' }).tier).toBe('deep');
  });
});

// ── 5–9. The store ─────────────────────────────────────────────────────────

describe('the intent store', () => {
  test('slugs number per application across intents, and start again for another', () => {
    const store = openStore();
    const first = store.createIntent({ appId: 'items', request: 'tags, then archive' });
    const second = store.createIntent({ appId: 'items', request: 'a colour per tag' });
    const other = store.createIntent({ appId: 'notes', request: 'pin a note' });
    expect(store.addTask(first.id, taskInput()).slug).toBe('0001-add-a-tags-column-to-the');
    expect(store.addTask(second.id, taskInput({ words: 'colour-per-tag' })).slug).toBe('0002-colour-per-tag');
    expect(store.addTask(other.id, taskInput({ words: 'pin-a-note' })).slug).toBe('0001-pin-a-note');
    expect(() => store.addTask(first.id, taskInput({ words: 'Not Words' }))).toThrow(/words/);
  });

  test('a task is given its tier and reasons by the host', () => {
    const store = openStore();
    const intent = store.createIntent({ appId: 'items', request: 'tags' });
    const task = store.addTask(intent.id, taskInput({ labels: ['migration', 'contract'] }));
    expect(task.tier).toBe('deep');
    expect(task.tierReasons).toEqual(['It changes a migration.']);
    expect(task.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2']);
  });

  test('moveTask refuses every move not in the table, and records one event per move', () => {
    const store = openStore();
    // The shortest way from `proposed` to every status, over allowed moves.
    const paths = new Map<StoredTaskStatus, StoredTaskStatus[]>([['proposed', []]]);
    const queue: StoredTaskStatus[] = ['proposed'];
    while (queue.length > 0) {
      const from = queue.shift() as StoredTaskStatus;
      for (const [a, b] of TASK_MOVES) {
        if (a !== from || paths.has(b)) continue;
        paths.set(b, [...(paths.get(from) ?? []), b]);
        queue.push(b);
      }
    }
    expect([...paths.keys()].sort()).toEqual([...TASK_STATUSES].sort());

    let refused = 0;
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const allowed = isAllowedMove(from, to);
        const intent = store.createIntent({ appId: 'items', request: `${from} to ${to}` });
        const task = store.addTask(intent.id, taskInput());
        for (const step of paths.get(from) ?? []) store.moveTask(task.id, step, 'getting there');
        const before = store.get(intent.id)?.tasks[0]?.events.length ?? 0;
        if (allowed) {
          expect(store.moveTask(task.id, to, 'the move').stored).toBe(to);
          expect(store.get(intent.id)?.tasks[0]?.events.length).toBe(before + 1);
        } else {
          expect(() => store.moveTask(task.id, to, 'the move')).toThrow(`cannot move from ${from} to ${to}`);
          expect(store.get(intent.id)?.tasks[0]?.events.length).toBe(before);
          refused += 1;
        }
      }
    }
    expect(refused).toBe(TASK_STATUSES.length ** 2 - TASK_MOVES.length);
    for (const done of ['completed', 'removed'] as const) {
      expect(TASK_MOVES.some(([from]) => from === done)).toBe(false);
    }
  });

  test('blocked is derived from the blockers, and never stored', () => {
    const store = openStore();
    const intent = store.createIntent({ appId: 'items', request: 'two steps' });
    const first = store.addTask(intent.id, taskInput({ words: 'first' }));
    const second = store.addTask(intent.id, taskInput({ words: 'second', blockedBy: [first.slug] }));
    store.moveTask(first.id, 'in-queue', 'submitted');
    store.moveTask(second.id, 'in-queue', 'submitted');
    expect(store.task(second.id)).toMatchObject({ status: 'blocked', stored: 'in-queue', waitingOn: [first.slug] });
    expect(store.list({ appId: 'items' })[0]?.counts).toMatchObject({ blocked: 1, 'in-queue': 1 });
    store.moveTask(first.id, 'in-progress', 'started');
    store.moveTask(first.id, 'completed', 'passed');
    expect(store.task(second.id)).toMatchObject({ status: 'in-queue', waitingOn: [] });
    const stored = store.db.query<{ status: string }, []>('SELECT status FROM tasks').all();
    expect(stored.some((row) => row.status === 'blocked')).toBe(false);
    expect(() => store.db.exec(`UPDATE tasks SET status = 'blocked' WHERE id = ${String(second.id)}`)).toThrow();
  });

  test('the history cannot be rewritten', () => {
    const store = openStore();
    const intent = store.createIntent({ appId: 'items', request: 'one' });
    store.addTask(intent.id, taskInput());
    expect(() => store.db.exec("UPDATE task_events SET note = 'changed'")).toThrow(/appended to/);
    expect(() => store.db.exec('DELETE FROM task_events')).toThrow(/appended to/);
  });

  test('removeTask refuses while another task depends on it, and names the dependant', () => {
    const store = openStore();
    const intent = store.createIntent({ appId: 'items', request: 'two steps' });
    const first = store.addTask(intent.id, taskInput({ words: 'first' }));
    const second = store.addTask(intent.id, taskInput({ words: 'second', blockedBy: [first.slug] }));
    const stub = store.addTask(intent.id, taskInput({ words: 'stub', stub: true, repaidBy: second.slug }));
    expect(() => store.removeTask(first.id)).toThrow(`${first.slug} cannot be removed: ${second.slug} depends on it.`);
    expect(() => store.removeTask(second.id)).toThrow(stub.slug);
    store.removeTask(stub.id);
    store.removeTask(second.id);
    expect(store.removeTask(first.id).stored).toBe('removed');
  });

  test('runOrder puts blockers first, then priority, then slug', () => {
    const store = openStore();
    const intent = store.createIntent({ appId: 'items', request: 'five parts' });
    const low = store.addTask(intent.id, taskInput({ words: 'low', priority: 'low' }));
    const medium = store.addTask(intent.id, taskInput({ words: 'medium' }));
    const waits = store.addTask(intent.id, taskInput({ words: 'waits', priority: 'high', blockedBy: [medium.slug] }));
    const high = store.addTask(intent.id, taskInput({ words: 'high', priority: 'high' }));
    const later = store.addTask(intent.id, taskInput({ words: 'also-high', priority: 'high' }));
    expect(store.runOrder(intent.id).map((task) => task.slug)).toEqual([
      high.slug,
      later.slug,
      medium.slug,
      waits.slug,
      low.slug,
    ]);
    expect(store.get(intent.id)?.tasks.map((task) => task.slug)).toEqual(store.runOrder(intent.id).map((task) => task.slug));
  });

  test('withdraw removes every task not completed, through the allowed moves', () => {
    const store = openStore();
    const intent = store.createIntent({ appId: 'items', request: 'three parts' });
    const done = store.addTask(intent.id, taskInput({ words: 'done' }));
    const failed = store.addTask(intent.id, taskInput({ words: 'failed' }));
    const proposed = store.addTask(intent.id, taskInput({ words: 'proposed' }));
    for (const step of ['in-queue', 'in-progress', 'completed'] as const) store.moveTask(done.id, step, 'ran');
    for (const step of ['in-queue', 'in-progress', 'failed'] as const) store.moveTask(failed.id, step, 'ran');
    expect(store.withdraw(intent.id).status).toBe('withdrawn');
    expect(store.task(done.id)?.stored).toBe('completed');
    expect(store.task(failed.id)?.stored).toBe('removed');
    expect(store.task(proposed.id)?.stored).toBe('removed');
    // The failed task went straight to `removed`: one event for the
    // withdrawal, and none for a queue it never waited in.
    const history = store.get(intent.id)?.tasks.find((task) => task.id === failed.id)?.events ?? [];
    expect(history.filter((event) => event.note === 'the intent was withdrawn').map((event) => [event.from, event.to])).toEqual([
      ['failed', 'removed'],
    ]);
    expect(() => store.withdraw(intent.id)).toThrow(/only a draft or a stopped intent/);
  });

  test('modelFor: the override wins, a null mapping gives null, the mapping applies by tier', () => {
    const mapping = { light: 'small-1', standard: null, deep: 'large-1' };
    expect(modelFor({ modelOverride: 'chosen-1', tier: 'deep' }, mapping)).toBe('chosen-1');
    expect(modelFor({ modelOverride: null, tier: 'standard' }, mapping)).toBeNull();
    expect(modelFor({ modelOverride: null, tier: 'light' }, mapping)).toBe('small-1');
    expect(modelFor({ modelOverride: null, tier: 'deep' }, mapping)).toBe('large-1');
  });
});

// ── 10–11. The launcher tab ─────────────────────────────────────────────────

const launcherAndAi = mergeContracts(launcherContract, aiContract);
type LauncherClient = BroappClient<typeof launcherAndAi>;

const noNetwork = Object.assign(() => Promise.reject(new Error('no network in tests')), {
  preconnect: () => undefined,
}) as typeof fetch;

interface TabWorld {
  readonly root: Layout;
  readonly dataDir: string;
  readonly intents: IntentStore;
}

function makeTab(withIntents: boolean): { world: TabWorld; tab: LauncherTab } {
  const directory = tempDir();
  const root = layout(directory);
  const dataDir = join(directory, 'launcher');
  const intents = openIntents(dataDir);
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
    providers: [createFakeAdapter()],
    fetch: noNetwork,
    logger: quiet,
    openBrowser: () => Promise.resolve(true),
    ...(withIntents ? { intents } : {}),
  });
  closers.push(
    () => supervisor.stopAll(5_000),
    () => journal.close(),
    () => store.close(),
    () => intents.close(),
    () => tab.ai.close(),
  );
  return { world: { root, dataDir, intents }, tab };
}

async function openTab(tab: LauncherTab): Promise<LauncherClient> {
  live = await harness((bridge) => tab.mount(bridge));
  const client = await live.connect(launcherAndAi);
  closers.push(() => client.close());
  return client;
}

/** An intent with two tasks, the second waiting on the first, both queued. */
function plannedIntent(intents: IntentStore): { id: number; first: number; second: number; slugs: [string, string] } {
  const intent = intents.createIntent({ appId: 'items', request: 'Add tags to items, then filter the table by one.' });
  intents.replaceAnalysis(intent.id, {
    restated: 'Tags on items, and a filter by tag.',
    fits: 'The items table and its form.',
    conflicts: [],
    outOfReach: ['Tag colours'],
    assumptions: ['A tag is one word'],
    questions: [],
  });
  const first = intents.addTask(intent.id, taskInput({ words: 'add-tags' }));
  const second = intents.addTask(intent.id, taskInput({ words: 'filter-by-tag', title: 'Filter the table by one tag', blockedBy: [first.slug] }));
  intents.moveTask(first.id, 'in-queue', 'submitted');
  intents.moveTask(second.id, 'in-queue', 'submitted');
  return { id: intent.id, first: first.id, second: second.id, slugs: [first.slug, second.slug] };
}

describe('the launcher tab', () => {
  test('the contract spells the statuses as the store does', () => {
    expect([...INTENT_STATUS_NAMES]).toEqual([...INTENT_STATUSES]);
    expect([...TASK_STATUS_NAMES]).toEqual([...TASK_STATUSES]);
  });

  test('the four reads return what was stored, and each write works for a person', async () => {
    const { world, tab } = makeTab(true);
    const planned = plannedIntent(world.intents);
    const client = await openTab(tab);

    const { intents } = await client.call('launcher.intentsList', { appId: 'items' });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ id: planned.id, appId: 'items', status: 'draft', restated: 'Tags on items, and a filter by tag.' });
    expect(intents[0]?.counts).toMatchObject({ 'in-queue': 1, blocked: 1, proposed: 0 });
    expect((await client.call('launcher.intentsList', { appId: 'notes' })).intents).toEqual([]);

    const detail = await client.call('launcher.intentGet', { id: planned.id });
    expect(detail.intent).toMatchObject({ request: 'Add tags to items, then filter the table by one.', outOfReach: ['Tag colours'] });
    expect(detail.tasks.map((task) => [task.slug, task.status, task.model])).toEqual([
      [planned.slugs[0], 'in-queue', null],
      [planned.slugs[1], 'blocked', null],
    ]);
    expect(detail.tasks[0]?.events.map((event) => event.to)).toEqual(['proposed', 'in-queue']);

    const { markdown } = await client.call('launcher.intentPlan', { taskId: planned.first });
    const stored = world.intents.task(planned.first);
    if (stored === null) throw new Error('the task is gone');
    expect(markdown).toBe(renderPlan(stored));
    expect(await client.call('launcher.intentModelsGet', undefined)).toEqual({ light: null, standard: null, deep: null });

    // Writes, each on channel `user`, the channel a tab's own call arrives on.
    expect(await client.call('launcher.intentModelsSet', { light: 'fake-1', standard: null, deep: null })).toEqual({
      light: 'fake-1',
      standard: null,
      deep: null,
    });
    expect(readTierModels(world.dataDir).light).toBe('fake-1');
    expect((await client.call('launcher.intentGet', { id: planned.id })).tasks[0]?.model).toBe('fake-1');

    expect(await client.call('launcher.intentTaskModel', { taskId: planned.second, modelId: 'fake-2' })).toEqual({ model: 'fake-2' });
    expect(await client.call('launcher.intentTaskModel', { taskId: planned.second, modelId: null })).toEqual({ model: 'fake-1' });

    await expect(client.call('launcher.intentTaskRemove', { taskId: planned.first })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining(planned.slugs[1]) as unknown as string,
    });
    expect(await client.call('launcher.intentTaskRemove', { taskId: planned.second })).toEqual({ status: 'removed' });

    world.intents.moveTask(planned.first, 'in-progress', 'started');
    await expect(client.call('launcher.intentTaskModel', { taskId: planned.first, modelId: 'fake-2' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(client.call('launcher.intentWithdraw', { id: planned.id })).rejects.toMatchObject({ code: 'conflict' });
    world.intents.moveTask(planned.first, 'interrupted', 'stopped');
    expect(await client.call('launcher.intentWithdraw', { id: planned.id })).toEqual({ status: 'withdrawn' });
    expect(world.intents.task(planned.first)?.stored).toBe('removed');
  }, 60_000);

  test('no engineer tool names the backlog', () => {
    const directory = tempDir();
    const root = layout(directory);
    const journal = openJournal(root.journal);
    closers.push(() => journal.close());
    const tools = engineerTools({
      layout: root,
      supervisor: createSupervisor({ logger: quiet }),
      journal,
      gate: createGate({ appId: 'launcher', releaseId: 'launcher', logger: quiet }),
      states: createCandidateStates(root, quiet),
      logger: quiet,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
    });
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => name.startsWith('intent.') || name.includes('launcher.intent'))).toEqual([]);
    for (const tool of Object.values(tools)) expect(tool.description).not.toContain('launcher.intent');
  });

  test('a tab without the store answers unavailable on every intent route', async () => {
    const { tab } = makeTab(false);
    const client = await openTab(tab);
    const calls: (() => Promise<unknown>)[] = [
      () => client.call('launcher.intentsList', {}),
      () => client.call('launcher.intentGet', { id: 1 }),
      () => client.call('launcher.intentPlan', { taskId: 1 }),
      () => client.call('launcher.intentModelsGet', undefined),
      () => client.call('launcher.intentTaskModel', { taskId: 1, modelId: null }),
      () => client.call('launcher.intentTaskRemove', { taskId: 1 }),
      () => client.call('launcher.intentWithdraw', { id: 1 }),
      () => client.call('launcher.intentModelsSet', { light: null, standard: null, deep: null }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'unavailable', message: 'This launcher keeps no backlog.' });
    }
  }, 60_000);

  test('IntentPanel draws the empty sentence, a blocked task, and the refusal', async () => {
    const empty = renderToString(createElement(IntentPanel, { appId: 'items', onClose: () => undefined, snapshot: { intents: [] } }));
    expect(empty).toContain(BACKLOG_EMPTY);
    expect(empty).toContain('aria-label="Backlog"');

    const none = renderToString(createElement(IntentPanel, { appId: null, onClose: () => undefined }));
    expect(none).toContain('Choose an application to see its backlog.');

    // Drawn from what the routes return, so the panel and the contract agree.
    const { world, tab } = makeTab(true);
    const planned = plannedIntent(world.intents);
    const client = await openTab(tab);
    const { intents } = await client.call('launcher.intentsList', { appId: 'items' });
    const opened = await client.call('launcher.intentGet', { id: planned.id });
    const markup = renderToString(createElement(IntentPanel, { appId: 'items', onClose: () => undefined, snapshot: { intents, opened } }));
    expect(markup).toContain('blocked by');
    expect(markup).toContain(`blocked by ${planned.slugs[0]}`);
    expect(markup).toContain(planned.slugs[1]);
    expect(markup).toContain('Out of reach');
    expect(markup).not.toContain('Conflicts');
    expect(markup).toContain('Settings model');
    expect(markup).toContain(`aria-label="Model for ${planned.slugs[1]}"`);

    const refused = renderToString(
      createElement(IntentPanel, { appId: 'items', onClose: () => undefined, error: 'This launcher keeps no backlog.' }),
    );
    expect(refused).toContain('This launcher keeps no backlog.');
    expect(refused).toContain('role="alert"');
  }, 60_000);

  test('an empty model choice names the model it runs on', () => {
    const model = (modelId: string, label: string) =>
      ({ modelId, label, capabilities: { tools: true } }) as Parameters<typeof inheritedModel>[2][number];
    const models = [model('big-1', 'Big One'), model('small-1', 'Small One')];
    expect(inheritedModel(null, null, models)).toBe('Settings model');
    expect(inheritedModel(null, 'big-1', models)).toBe('Settings: Big One');
    expect(inheritedModel({ name: 'deep', model: null }, 'big-1', models)).toBe('Settings: Big One');
    expect(inheritedModel({ name: 'deep', model: 'small-1' }, 'big-1', models)).toBe('deep tier: Small One');
    // A model the list has not got is still named, by its id.
    expect(inheritedModel(null, 'gone-9', models)).toBe('Settings: gone-9');

    const markup = renderToString(
      createElement(TierModelsBlock, {
        value: { light: null, standard: null, deep: null },
        models,
        settingsModel: 'big-1',
        unreadable: false,
        error: null,
        onChange: () => undefined,
      }),
    );
    expect(markup).toContain('Settings: Big One');
    expect(markup).not.toContain('>Settings model<');
  });
});
