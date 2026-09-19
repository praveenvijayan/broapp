/**
 * 17a: what a run costs and where it is.
 *
 * The usage table and the rows every turn leaves, prices and what they make of
 * the rows, the stage a builder's turn is in, what needs the person, what is
 * left, `launcher.overview` itself, and the alerts a page raises from two
 * reads of it. The parts that need a builder's turn — a builder's row carrying
 * its task, `RunProgress` through a scripted builder, the overview with a run
 * going — are in `autoapp-intent-run.test.ts`, where that world is.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAdapter, type FakeStep, type ProviderAdapter } from 'broapp/ai/host';
import { createGate } from 'broapp/host';
import type { Envelope, HostLogger } from 'broapp/host';
import { fromTransportError } from 'broapp/shared';
import { createRunStore } from 'broapp-autoapp/host';
import {
  estimateFor,
  MAX_PRICED_MODELS,
  openIntents,
  PRICES_FILE,
  readPrices,
  recordUsage,
  spendOf,
  stageOf,
  startOfToday,
  usageToday,
  writePrices,
  type IntentStore,
  type StageEvent,
  type TaskInput,
  type UsageRow,
} from 'broapp-autoapp/intent';
import {
  createLauncherTab,
  createSupervisor,
  needsYouOf,
  openJournal,
  RUN_STAGE_NAMES,
  type CandidateView,
  type LauncherTab,
} from 'broapp-autoapp/launcher';
import {
  ALERT_TONES,
  alertsBetween,
  announce,
  announceOverview,
  requestAlerts,
  type OverviewAlerts,
  type PendingSurface,
  type ToneKind,
} from 'broapp-autoapp/react';
import { layout } from 'broapp-autoapp/spec';

import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';

const quiet: HostLogger = { warn: () => undefined, error: () => undefined };

const scratch: string[] = [];
const closers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Carry on; the next close may be the one that matters.
    }
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fresh(): string {
  const directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  scratch.push(directory);
  return directory;
}

function store(dataDir = join(fresh(), 'launcher')): IntentStore {
  const intents = openIntents(dataDir);
  closers.push(() => intents.close());
  return intents;
}

function row(overrides: Partial<UsageRow> & Pick<UsageRow, 'runId'>): UsageRow {
  return {
    appId: 'items',
    taskId: null,
    modelId: 'model-a',
    inputTokens: 1_000,
    outputTokens: 100,
    partial: false,
    steps: 3,
    ms: 60_000,
    endedAt: Date.now(),
    ...overrides,
  };
}

/** A plan that passes the validator. */
function plan(words: string): TaskInput {
  return {
    title: `Build the ${words.replaceAll('-', ' ')} part`,
    words,
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
}

/** A submitted intent for `appId` with one task per word, and their ids. */
function intentWith(intents: IntentStore, words: readonly string[], appId = 'items'): { id: number; taskIds: number[] } {
  const intent = intents.createIntent({ appId, request: 'Do these things.' });
  intents.replaceAnalysis(intent.id, {
    restated: 'Do these things.',
    fits: 'Builds on items.list.',
    conflicts: [],
    outOfReach: [],
    assumptions: [],
    questions: [],
  });
  const taskIds = words.map((word) => intents.addTask(intent.id, plan(word), { deferReferences: true }).id);
  expect(intents.submit(intent.id)).toEqual([]);
  return { id: intent.id, taskIds };
}

/** Walk a task to completed, as a run would, under `runId`. */
function complete(intents: IntentStore, taskId: number, runId: string): void {
  intents.moveTask(taskId, 'in-queue', 'queued');
  intents.moveTask(taskId, 'in-progress', 'started', runId);
  intents.moveTask(taskId, 'completed', 'done', runId);
}

// ── A launcher tab over an empty root, on the fake provider ──────────────────

const THREE_STEPS: readonly FakeStep[] = [
  {
    kind: 'tool',
    name: 'apps.list',
    input: {},
    then: [{ kind: 'tool', name: 'apps.list', input: {}, then: [{ kind: 'text', chunks: ['Looked ', 'twice.'] }] }],
  },
];

interface Tab {
  readonly root: string;
  readonly dataDir: string;
  readonly intents: IntentStore;
  readonly tab: LauncherTab;
  readonly errors: string[];
}

function tabOver(options: { script?: readonly FakeStep[]; chunkDelayMs?: number; failFrom?: number } = {}): Tab {
  const root = fresh();
  const dataDir = join(root, 'launcher');
  const intents = openIntents(dataDir);
  const runs = createRunStore(dataDir, quiet);
  const where = layout(root);
  const journal = openJournal(where.journal);
  const supervisor = createSupervisor({ logger: quiet });
  const gate = createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, recorder: runs.recorder(), logger: quiet });
  const fake = createFakeAdapter({
    script: options.script ?? THREE_STEPS,
    ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
  });
  let calls = 0;
  const adapter: ProviderAdapter = {
    ...fake,
    model: (config, modelId) => {
      const model = fake.model(config, modelId);
      const failFrom = options.failFrom;
      if (failFrom === undefined || typeof model !== 'object') return model;
      return new Proxy(model, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (property !== 'doStream' || typeof value !== 'function') return value;
          return (...args: unknown[]): unknown => {
            calls += 1;
            if (calls >= failFrom) return Promise.reject(new Error('the provider went away'));
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
  const errors: string[] = [];
  const logger: HostLogger = { warn: () => undefined, error: (line: string) => void errors.push(line) };
  const tab = createLauncherTab({
    layout: where,
    supervisor,
    journal,
    gate,
    dataDir,
    store: runs,
    templates: TEMPLATES,
    versions: STARTER_VERSIONS,
    providers: [adapter],
    fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), { preconnect: () => undefined }) as typeof fetch,
    logger,
    intents,
    install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
    initGit: () => false,
  });
  closers.push(
    () => supervisor.stopAll(5_000),
    () => journal.close(),
    () => runs.close(),
    () => intents.close(),
    () => tab.ai.close(),
  );
  return { root, dataDir, intents, tab, errors };
}

const person: Envelope = { requestId: 'overview-test', channel: 'user', caller: 'tab' };

async function usageRows(intents: IntentStore): Promise<Record<string, unknown>[]> {
  await Bun.sleep(0);
  return intents.db.query<Record<string, unknown>, []>('SELECT * FROM usage ORDER BY ended_at, run_id').all();
}

// ── 1–3. The usage table, and the row every turn leaves ─────────────────────

describe('17a: every turn leaves a usage row', () => {
  // 1.
  test('a store written before the migration opens, and its usage table is there and empty', () => {
    const dataDir = join(fresh(), 'launcher');
    const first = openIntents(dataDir);
    intentWith(first, ['only-part']);
    first.close();
    // As a store written before 17a: no `usage`, and `user_version` 3.
    const raw = new Database(join(dataDir, 'intents.sqlite'));
    raw.exec('DROP TABLE usage');
    raw.exec('PRAGMA user_version = 3');
    raw.close();

    const intents = store(dataDir);
    expect(intents.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage').get()?.n).toBe(0);
    expect(intents.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(4);
    const indexes = intents.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage' AND name NOT LIKE 'sqlite_%'")
      .all();
    expect(indexes.map((index) => index.name).sort()).toEqual(['usage_ended', 'usage_task']);
    expect(intents.list()).toHaveLength(1);
  });

  // 2.
  test('a finished chat turn writes its totals, not partial, with no task and the model it ran on', async () => {
    const world = tabOver();
    await world.tab.ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
    const result = await world.tab.ai.turn({ runId: 'chat-1', message: 'what is here?' }, { answer: () => true });
    expect(result.status).toBe('succeeded');
    const [only, ...rest] = await usageRows(world.intents);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      run_id: 'chat-1',
      task_id: null,
      model_id: 'fake-1',
      input_tokens: 33,
      output_tokens: 21,
      partial: 0,
      steps: 2,
    });
  });

  test('a turn cut short writes its subtotal, partial', async () => {
    const world = tabOver({ chunkDelayMs: 40 });
    await world.tab.ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
    const stop = new AbortController();
    const result = await world.tab.ai.turn(
      { runId: 'chat-2', message: 'look twice' },
      {
        answer: () => true,
        signal: stop.signal,
        onEvent: (event) => {
          if (event.type === 'text') stop.abort();
        },
      },
    );
    expect(result.status).toBe('cancelled');
    expect(await usageRows(world.intents)).toEqual([
      expect.objectContaining({ run_id: 'chat-2', input_tokens: 22, output_tokens: 14, partial: 1, task_id: null }),
    ]);
  });

  test('a turn with no usage at all writes zeros, partial: it happened, and its cost is unknown', async () => {
    const world = tabOver({ failFrom: 1 });
    await world.tab.ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
    const result = await world.tab.ai.turn({ runId: 'chat-3', message: 'go' }, { answer: () => true });
    expect(result.status).toBe('failed');
    expect(await usageRows(world.intents)).toEqual([
      expect.objectContaining({ run_id: 'chat-3', input_tokens: 0, output_tokens: 0, partial: 1, model_id: 'fake-1' }),
    ]);
  });

  // 3.
  test('a write that fails is logged, and the turn’s result is what it would have been', async () => {
    const kept = tabOver();
    await kept.tab.ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
    const before = await kept.tab.ai.turn({ runId: 'chat-4', message: 'go' }, { answer: () => true });
    const broken = tabOver();
    await broken.tab.ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
    broken.intents.db.exec('DROP TABLE usage');
    const after = await broken.tab.ai.turn({ runId: 'chat-4', message: 'go' }, { answer: () => true });
    expect(after.status).toBe(before.status);
    expect(after.events).toEqual(before.events);
    expect(broken.errors.some((line) => line.includes('could not keep what turn chat-4 used'))).toBe(true);
    expect(kept.errors).toEqual([]);
  });
});

// ── 5–7. Prices, spend and today ─────────────────────────────────────────────

describe('17a: prices are the person’s', () => {
  // 5.
  test('a missing, an unreadable and a malformed file each price nothing', () => {
    const dataDir = fresh();
    const parts = [{ modelId: 'model-a', inputTokens: 1_000_000, outputTokens: 0, partial: false }];
    expect(spendOf(parts, readPrices(dataDir)).cost).toBeNull();
    writeFileSync(join(dataDir, PRICES_FILE), '{ not json');
    expect(spendOf(parts, readPrices(dataDir)).cost).toBeNull();
    writeFileSync(join(dataDir, PRICES_FILE), JSON.stringify([{ 'model-a': { input: 1, output: 1 } }]));
    expect(spendOf(parts, readPrices(dataDir)).cost).toBeNull();
    // A priced model whose entry is not a price is not priced.
    writeFileSync(join(dataDir, PRICES_FILE), JSON.stringify({ 'model-a': { input: -1, output: 2 } }));
    expect(spendOf(parts, readPrices(dataDir)).cost).toBeNull();
  });

  test('a priced model costs tokens × price / 1e6, and changing the file changes what history cost', () => {
    const intents = store();
    recordUsage(intents, row({ runId: 'r1', modelId: 'model-a', inputTokens: 2_000_000, outputTokens: 500_000 }));
    writePrices(intents.dataDir, [{ modelId: 'model-a', input: 3, output: 15 }], 10);
    const now = Date.now();
    expect(spendOf(usageToday(intents, now), readPrices(intents.dataDir))).toEqual({
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      cost: 2 * 3 + 0.5 * 15,
      atLeast: false,
      unpricedTokens: 0,
    });
    expect(readPrices(intents.dataDir).budgetDay).toBe(10);
    writePrices(intents.dataDir, [{ modelId: 'model-a', input: 1, output: 1 }], null);
    expect(spendOf(usageToday(intents, now), readPrices(intents.dataDir)).cost).toBe(2.5);
    expect(readPrices(intents.dataDir).budgetDay).toBeNull();
  });

  test('pricesSet refuses a negative, a NaN and a 201st model, and a channel that is not a person', async () => {
    const world = tabOver();
    const refused = async (models: { modelId: string; input: number; output: number }[], envelope = person): Promise<string | undefined> =>
      await world.tab.app.invoke('launcher.pricesSet', { models, budgetDay: null }, envelope).then(
        () => undefined,
        (cause: unknown) => fromTransportError(cause).code,
      );
    expect(await refused([{ modelId: 'model-a', input: -1, output: 1 }])).toBe('invalid_input');
    const many = Array.from({ length: MAX_PRICED_MODELS + 1 }, (_, index) => ({ modelId: `model-${String(index)}`, input: 1, output: 1 }));
    expect(await refused(many)).toBe('invalid_input');
    expect(await refused([{ modelId: 'model-a', input: 1, output: 1 }], { ...person, channel: 'ai', approver: { ask: () => Promise.resolve(true) } })).toBe(
      'rejected',
    );
    // NaN cannot cross the wire as JSON; the function the route calls refuses it.
    expect(() => writePrices(world.dataDir, [{ modelId: 'model-a', input: Number.NaN, output: 1 }], null)).toThrow(/zero or more/);
    expect(() => writePrices(world.dataDir, [], Number.POSITIVE_INFINITY)).toThrow(/daily budget/);
    // Nothing was written by any refusal.
    expect(readPrices(world.dataDir).models).toEqual({});
    const saved = await world.tab.app.invoke('launcher.pricesSet', { models: [{ modelId: 'model-a', input: 3, output: 15 }], budgetDay: 5 }, person);
    expect(saved).toEqual({ models: [{ modelId: 'model-a', input: 3, output: 15 }], budgetDay: 5 });
    expect(await world.tab.app.invoke('launcher.pricesGet', undefined, person)).toEqual(saved);
  });

  // 6.
  test('a total with a partial row is a floor; one with an unpriced model says what it left out; one with nothing priced has no cost', () => {
    const prices = { models: { 'model-a': { input: 1, output: 1 } }, budgetDay: null };
    const partial = spendOf([{ modelId: 'model-a', inputTokens: 1_000_000, outputTokens: 0, partial: true }], prices);
    expect(partial).toMatchObject({ cost: 1, atLeast: true });
    const mixed = spendOf(
      [
        { modelId: 'model-a', inputTokens: 1_000_000, outputTokens: 0, partial: false },
        { modelId: 'local-27b', inputTokens: 400, outputTokens: 100, partial: false },
      ],
      prices,
    );
    expect(mixed).toMatchObject({ cost: 1, unpricedTokens: 500, atLeast: false });
    const none = spendOf([{ modelId: 'local-27b', inputTokens: 400, outputTokens: 100, partial: false }], prices);
    expect(none.cost).toBeNull();
    expect(none.cost).not.toBe(0);
    // A model with no id is never priced.
    expect(spendOf([{ modelId: null, inputTokens: 10, outputTokens: 0, partial: false }], prices).cost).toBeNull();
  });

  // 7.
  test('today excludes 23:59 yesterday and includes 00:00 today, by the machine’s own midnight', () => {
    const intents = store();
    const noon = new Date(2026, 8, 19, 12, 0, 0).getTime();
    const midnight = startOfToday(noon);
    expect(midnight).toBe(new Date(2026, 8, 19, 0, 0, 0, 0).getTime());
    recordUsage(intents, row({ runId: 'late', endedAt: midnight - 60_000, inputTokens: 7 }));
    recordUsage(intents, row({ runId: 'early', endedAt: midnight, inputTokens: 11 }));
    const today = usageToday(intents, noon);
    expect(today.reduce((sum, part) => sum + part.inputTokens, 0)).toBe(11);
  });
});

// ── 8. The stage ──────────────────────────────────────────────────────────────

describe('17a: the stage a builder’s turn is in', () => {
  const call = (tool: string): StageEvent => ({ type: 'tool-call', tool });
  const result = (tool: string, output: unknown, denied?: boolean): StageEvent => ({ type: 'tool-result', tool, output, ...(denied === undefined ? {} : { denied }) });
  const ask = (tool: string): StageEvent => ({ type: 'confirm', tool });

  test('the stage names are the contract’s', () => {
    const stages = new Set(RUN_STAGE_NAMES);
    for (const stage of ['reading', 'editing', 'building', 'checking'] as const) expect(stages.has(stage)).toBe(true);
    expect(RUN_STAGE_NAMES).toHaveLength(4);
  });

  test('nothing called, then reads, then an edit, then a cycle that builds and checks', () => {
    const events: StageEvent[] = [];
    expect(stageOf(events)).toBe('reading');
    events.push(call('source.read'), result('source.read', { text: 'a' }), call('spec.read'), result('spec.read', {}));
    expect(stageOf(events)).toBe('reading');
    events.push(call('source.edit'), result('source.edit', { changed: ['src/a.ts'] }));
    expect(stageOf(events)).toBe('editing');
    events.push(call('candidate.cycle'), ask('candidate.cycle'), ask('candidate.build'));
    expect(stageOf(events)).toBe('building');
    events.push(ask('candidate.preview'));
    expect(stageOf(events)).toBe('checking');
    events.push(result('candidate.cycle', { applied: { changed: [] }, build: { ok: true }, preview: { started: true }, check: { passed: 2 } }));
    expect(stageOf(events)).toBe('checking');
  });

  test('a failed build then an edit is editing again', () => {
    const events: StageEvent[] = [
      call('candidate.cycle'),
      result('candidate.cycle', { applied: { changed: ['src/a.ts'] }, build: { ok: false, problems: [] } }),
    ];
    expect(stageOf(events)).toBe('editing');
    events.push(call('candidate.build'));
    expect(stageOf(events)).toBe('building');
    events.push(result('candidate.build', { ok: false, problems: [] }), call('source.edit'), result('source.edit', { changed: ['src/b.ts'] }));
    expect(stageOf(events)).toBe('editing');
  });

  test('a refused edit, a declined edit and a cycle refused before its patch do not leave reading', () => {
    const events: StageEvent[] = [
      call('source.edit'),
      result('source.edit', { error: 'not found in src/a.ts: x' }),
      call('source.change'),
      result('source.change', { denied: true, reason: 'The user declined this action.' }, true),
    ];
    expect(stageOf(events)).toBe('reading');
    events.push(call('candidate.cycle'));
    expect(stageOf(events)).toBe('building');
    events.push(result('candidate.cycle', { error: 'the input is not what this tool takes: hunks: expected an array' }));
    expect(stageOf(events)).toBe('reading');
  });

  test('a preview that would not start sends a turn back to editing', () => {
    const events: StageEvent[] = [
      call('candidate.cycle'),
      ask('candidate.build'),
      ask('candidate.preview'),
      result('candidate.cycle', { applied: { changed: ['src/a.ts'] }, build: { ok: true }, preview: { started: false, error: 'x' } }),
    ];
    expect(stageOf(events)).toBe('editing');
  });
});

// ── 10. What needs the person ─────────────────────────────────────────────────

describe('17a: what needs the person', () => {
  const checks = (releaseId: string, passed: readonly boolean[], at: number): CandidateView['checks'] => ({
    releaseId,
    previewId: `${releaseId}:1`,
    examples: [],
    results: passed.map((ok, index) => ({ id: `e${String(index)}`, title: `e${String(index)}`, passed: ok })),
    at,
  });
  const ready = (appId: string, at: number): CandidateView => ({
    appId,
    name: appId.toUpperCase(),
    releaseId: 'b'.repeat(32),
    current: 'a'.repeat(32),
    checks: checks('b'.repeat(32), [true, true], at),
  });

  test('each of the four sources alone, and together newest first; nothing else ever is', () => {
    const intents = store();
    const { taskIds } = intentWith(intents, ['asks-part', 'fails-part', 'plain-part', 'failed-bare']);
    const [asks, fails, plain, bare] = taskIds;
    if (asks === undefined || fails === undefined || plain === undefined || bare === undefined) throw new Error('four tasks');
    intents.moveTask(asks, 'in-queue', 'queued');
    intents.moveTask(asks, 'in-progress', 'started', 'run-asks');
    intents.ask(asks, 'Keep the read date?', 'the builder asked the person');
    for (const id of [fails, bare]) {
      intents.moveTask(id, 'in-queue', 'queued');
      intents.moveTask(id, 'in-progress', 'started', `run-${String(id)}`);
      intents.moveTask(id, 'failed', 'two attempts');
    }
    intents.setAdvice(fails, { diagnosis: 'x', advice: 'retry', note: 'Run it again.', at: Date.now() + 1_000 });
    intents.moveTask(plain, 'in-queue', 'queued');
    const tasks = intents.tasksIn(['needs-answer', 'failed']);
    const question = {
      runId: 'intent-1-0003-plain-part-a1',
      callId: 'call-4',
      tool: 'source.edit',
      input: { appId: 'empty' },
      askedAt: Date.now() + 2_000,
      expiresAt: Date.now() + 600_000,
      appId: 'items',
      intentId: 1,
      taskId: plain,
    };

    const alone = (input: Parameters<typeof needsYouOf>[0]) => needsYouOf(input).map((item) => item.kind);
    expect(alone({ question, tasks: [], candidates: [] })).toEqual(['question']);
    expect(alone({ question: null, tasks: tasks.filter((task) => task.id === asks), candidates: [] })).toEqual(['answer']);
    expect(alone({ question: null, tasks: tasks.filter((task) => task.id === fails), candidates: [] })).toEqual(['advice']);
    expect(alone({ question: null, tasks: [], candidates: [ready('notes', Date.now())] })).toEqual(['activate']);

    const all = needsYouOf({ question, tasks, candidates: [ready('notes', Date.now() + 500)] });
    // Newest first; the failed task with no advice, the queued task and nothing else.
    expect(all.map((item) => item.kind)).toEqual(['question', 'advice', 'activate', 'answer']);
    expect(all.every((item) => item.title.length <= 80)).toBe(true);
    expect(all.find((item) => item.kind === 'question')?.expiresAt).toBe(question.expiresAt);
    expect(all.find((item) => item.kind === 'advice')?.target).toEqual({ panel: 'backlog', appId: 'items', intentId: 1, taskId: fails, releaseId: null });
    expect(all.find((item) => item.kind === 'activate')?.target).toEqual({
      panel: 'candidate',
      appId: 'notes',
      intentId: null,
      taskId: null,
      releaseId: 'b'.repeat(32),
    });
  });

  test('an answered question leaves it; a serving candidate, a failing one and one checked on another build are never in it', () => {
    const intents = store();
    const { taskIds } = intentWith(intents, ['asks-part', 'fails-part']);
    const [asks, fails] = taskIds;
    if (asks === undefined || fails === undefined) throw new Error('two tasks');
    intents.moveTask(asks, 'in-queue', 'queued');
    intents.moveTask(asks, 'in-progress', 'started', 'run-asks');
    intents.ask(asks, 'Keep the read date?', 'asked');
    intents.moveTask(fails, 'in-queue', 'queued');
    intents.moveTask(fails, 'in-progress', 'started', 'run-fails');
    intents.moveTask(fails, 'failed', 'two attempts');
    intents.setAdvice(fails, { diagnosis: 'x', advice: 'ask', note: 'Which shelf?', at: Date.now() - 1_000 });
    expect(needsYouOf({ question: null, tasks: intents.tasksIn(['needs-answer', 'failed']), candidates: [] })).toHaveLength(2);
    intents.answer(asks, 'Yes', 'the person');
    intents.answer(fails, 'The top one', 'the person');
    expect(needsYouOf({ question: null, tasks: intents.tasksIn(['needs-answer', 'failed']), candidates: [] })).toEqual([]);

    const serving = { ...ready('notes', 1), current: 'b'.repeat(32) };
    const failing = { ...ready('notes', 1), checks: checks('b'.repeat(32), [true, false], 1) };
    const elsewhere = { ...ready('notes', 1), checks: checks('c'.repeat(32), [true], 1) };
    const unchecked = { ...ready('notes', 1), checks: null };
    expect(needsYouOf({ question: null, tasks: [], candidates: [serving, failing, elsewhere, unchecked] })).toEqual([]);
  });
});

// ── 11. What is left ──────────────────────────────────────────────────────────

describe('17a: the estimate of what is left', () => {
  test('null with one completed task, a number with two, null again when one of them is partial', () => {
    const intents = store();
    const { taskIds } = intentWith(intents, ['one-part', 'two-part', 'three-part', 'four-part']);
    const [one, two] = taskIds;
    if (one === undefined || two === undefined) throw new Error('tasks');
    complete(intents, one, 'run-one');
    recordUsage(intents, row({ runId: 'run-one', taskId: one, ms: 60_000, inputTokens: 900, outputTokens: 100 }));
    expect(estimateFor(intents, 'items', 2)).toBeNull();
    complete(intents, two, 'run-two');
    recordUsage(intents, row({ runId: 'run-two', taskId: two, ms: 120_000, inputTokens: 2_700, outputTokens: 300 }));
    expect(estimateFor(intents, 'items', 2)).toEqual({ ms: 180_000, tokens: 4_000, estimate: true });
    // Another application's tasks are never in it.
    expect(estimateFor(intents, 'notes', 2)).toBeNull();
    recordUsage(intents, row({ runId: 'advice-two', taskId: two, partial: true }));
    expect(estimateFor(intents, 'items', 2)).toBeNull();
  });

  test('a completed task that left no row is not known, so there is no estimate', () => {
    const intents = store();
    const { taskIds } = intentWith(intents, ['one-part', 'two-part', 'three-part']);
    const [one, two] = taskIds;
    if (one === undefined || two === undefined) throw new Error('tasks');
    complete(intents, one, 'run-one');
    complete(intents, two, 'run-two');
    recordUsage(intents, row({ runId: 'run-one', taskId: one }));
    expect(estimateFor(intents, 'items', 1)).toBeNull();
  });
});

// ── 12. The route ─────────────────────────────────────────────────────────────

/** Every file under a directory, with its size and modification time. */
function files(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      // SQLite's shared-memory index is touched by reads; it is not the store.
      // The launcher's run store is the gate's record of every call, reads
      // included: the gate writes it for any route, and the route writes nothing.
      else if (!entry.name.endsWith('-shm') && !entry.name.startsWith('runs.sqlite')) {
        const stat = statSync(path);
        out[path] = `${String(stat.size)}:${String(stat.mtimeMs)}`;
      }
    }
  };
  walk(directory);
  return out;
}

describe('17a: launcher.overview', () => {
  test('an empty root: empty lists, nothing running, nothing spent; and it writes nothing', async () => {
    const world = tabOver();
    mkdirSync(join(world.root, 'apps'), { recursive: true });
    const before = files(world.root);
    await Bun.sleep(20);
    const overview = await world.tab.app.invoke('launcher.overview', undefined, person);
    expect(overview).toEqual({
      needsYou: [],
      running: null,
      spend: {
        task: null,
        run: null,
        today: { inputTokens: 0, outputTokens: 0, cost: 0, atLeast: false, unpricedTokens: 0 },
        budgetDay: null,
        todayByModel: [],
      },
      backlog: [],
      apps: [],
      recent: [],
    });
    expect(files(world.root)).toEqual(before);
  });

  test('a thousand usage rows: the best of ten reads is under 50 ms', async () => {
    const world = tabOver();
    mkdirSync(join(world.root, 'apps'), { recursive: true });
    const { taskIds } = intentWith(world.intents, ['one-part', 'two-part']);
    const now = Date.now();
    world.intents.db.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        recordUsage(
          world.intents,
          row({
            runId: `run-${String(index)}`,
            taskId: index % 3 === 0 ? (taskIds[index % 2] ?? null) : null,
            modelId: `model-${String(index % 7)}`,
            endedAt: now - index * 1_000,
            partial: index % 50 === 0,
          }),
        );
      }
    })();
    writePrices(world.dataDir, [{ modelId: 'model-1', input: 3, output: 15 }], 10);
    const times: number[] = [];
    for (let read = 0; read < 10; read += 1) {
      const started = performance.now();
      await world.tab.app.invoke('launcher.overview', undefined, person);
      times.push(performance.now() - started);
    }
    const best = Math.min(...times);
    console.log(`launcher.overview over 1,000 usage rows: best ${best.toFixed(2)} ms of ten`);
    expect(best).toBeLessThan(50);
    const overview = (await world.tab.app.invoke('launcher.overview', undefined, person)) as {
      spend: { today: { cost: number | null; atLeast: boolean; unpricedTokens: number }; budgetDay: number | null };
      backlog: unknown[];
    };
    expect(overview.spend.today.atLeast).toBe(true);
    expect(overview.spend.today.cost).not.toBeNull();
    expect(overview.spend.today.unpricedTokens).toBeGreaterThan(0);
    expect(overview.spend.budgetDay).toBe(10);
  });
});

// ── 13–14. Alerts and sound ───────────────────────────────────────────────────

/** A surface that records what it was asked to do. */
function surfaceFor(options: { permission?: string; sound?: boolean; attending?: boolean; throws?: boolean } = {}): PendingSurface & {
  readonly raisedTitles: string[];
  readonly played: ToneKind[];
  readonly requests: number[];
} {
  const raisedTitles: string[] = [];
  const played: ToneKind[] = [];
  const requests: number[] = [];
  let permission = options.permission ?? 'granted';
  return {
    title: 'Autoapp',
    notify: {
      get permission() {
        return permission;
      },
      raise: (title: string) => void raisedTitles.push(title),
      request: () => {
        requests.push(Date.now());
        permission = 'granted';
        return Promise.resolve(permission);
      },
    },
    sound: {
      enabled: options.sound ?? true,
      play: (kind: ToneKind) => {
        if (options.throws === true) throw new Error('no audio here');
        played.push(kind);
      },
    },
    attending: () => options.attending ?? false,
    raised: new Set<string>(),
    raisedTitles,
    played,
    requests,
  };
}

const EMPTY: OverviewAlerts = { needsYou: [], recent: [] };

/** A read with every one of the six events in it. */
const SIX: OverviewAlerts = {
  needsYou: [
    { key: 'question:run-1:call-1', kind: 'question', title: 'The run asks to use source.edit', detail: '' },
    { key: 'advice:4:1', kind: 'advice', title: 'Notes failed', detail: '' },
  ],
  recent: [
    { key: 'intent-1-9:run-ended', kind: 'run-ended', text: 'The run stopped.' },
    { key: 'run-3:provider-error', kind: 'provider-error', text: 'The AI provider returned an error.' },
    { key: 'run-2:task-failed', kind: 'task-failed', text: 'A failed.' },
    { key: 'run-2:turn-limit', kind: 'turn-limit', text: 'The turn made no tool call for 8 minutes.' },
    { key: 'run-1:task-completed', kind: 'task-completed', text: 'B is built.' },
  ],
};

describe('17a: alerts', () => {
  // 13.
  test('each of the six events is raised once across three identical reads, and the badge counts needsYou', () => {
    const surface = surfaceFor();
    expect(announceOverview(surface, null, EMPTY)).toEqual([]);
    const first = announceOverview(surface, EMPTY, SIX);
    announceOverview(surface, SIX, SIX);
    announceOverview(surface, EMPTY, SIX);
    expect(first.map((event) => event.kind)).toEqual(['question', 'task-completed', 'turn-limit', 'task-failed', 'provider-error', 'run-ended']);
    expect(surface.raisedTitles).toHaveLength(6);
    // Two things need the person: the question and the failed task, not only the question.
    expect(surface.title).toBe('(2) Autoapp');
    announceOverview(surface, SIX, EMPTY);
    expect(surface.title).toBe('Autoapp');
  });

  test('the first read is a baseline and raises nothing', () => {
    expect(alertsBetween(null, SIX)).toEqual([]);
  });

  test('nothing is raised when permission is not granted, and nothing ever asks for it but requestAlerts', async () => {
    for (const permission of ['default', 'denied']) {
      const surface = surfaceFor({ permission, sound: false });
      announceOverview(surface, EMPTY, SIX);
      expect(surface.raisedTitles).toEqual([]);
      expect(surface.requests).toEqual([]);
    }
    const asking = surfaceFor({ permission: 'default' });
    expect(await requestAlerts(asking)).toBe('granted');
    expect(asking.requests).toHaveLength(1);
    // Once answered, the answer stands: a second click reports it and asks nothing.
    expect(await requestAlerts(asking)).toBe('granted');
    expect(asking.requests).toHaveLength(1);
    const denied = surfaceFor({ permission: 'denied' });
    expect(await requestAlerts(denied)).toBe('denied');
    expect(denied.requests).toEqual([]);
    expect(await requestAlerts({ title: 'x' })).toBe('unsupported');
  });

  test('requestAlerts is the only caller of a request in the source, and it unlocks sound', async () => {
    const source = await Bun.file(join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'react', 'pending.ts')).text();
    const callers = source.split('\n').filter((line) => /\.request\(\)/.test(line));
    expect(callers).toEqual(['    return await notify.request();']);
    let unlocked = 0;
    await requestAlerts({ title: 'x', sound: { enabled: false, play: () => undefined, unlock: () => void (unlocked += 1) } });
    expect(unlocked).toBe(1);
  });

  // 14.
  test('attention for a question, a failed task and a provider error; done for the run’s end; nothing for a completed task or a limit', () => {
    expect(ALERT_TONES).toEqual({
      question: 'attention',
      'task-failed': 'attention',
      'provider-error': 'attention',
      'run-ended': 'done',
      'task-completed': null,
      'turn-limit': null,
    });
    const surface = surfaceFor();
    announceOverview(surface, EMPTY, SIX);
    announceOverview(surface, EMPTY, SIX);
    expect(surface.played).toEqual(['attention', 'attention', 'attention', 'done']);
  });

  test('never when sound is off, never while the person is looking, a play that throws is swallowed, and sound needs no notification permission', () => {
    const off = surfaceFor({ sound: false });
    announceOverview(off, EMPTY, SIX);
    expect(off.played).toEqual([]);
    const looking = surfaceFor({ attending: true });
    announceOverview(looking, EMPTY, SIX);
    expect(looking.played).toEqual([]);
    expect(looking.raisedTitles).toHaveLength(6);
    const broken = surfaceFor({ throws: true });
    expect(() => announceOverview(broken, EMPTY, SIX)).not.toThrow();
    expect(broken.raisedTitles).toHaveLength(6);
    const blocked = surfaceFor({ permission: 'denied' });
    announceOverview(blocked, EMPTY, SIX);
    expect(blocked.raisedTitles).toEqual([]);
    expect(blocked.played).toEqual(['attention', 'attention', 'attention', 'done']);
  });

  test('announce raises one event once, whatever calls it', () => {
    const surface = surfaceFor();
    const event = { key: 'run-9:task-failed', kind: 'task-failed' as const, title: 'A task failed', body: 'x' };
    announce(surface, event);
    announce(surface, event);
    expect(surface.raisedTitles).toEqual(['A task failed']);
    expect(surface.played).toEqual(['attention']);
  });
});
