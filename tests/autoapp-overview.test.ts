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
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiContract, AiProvider } from 'broapp/ai/react';
import { createFakeAdapter, type FakeStep, type ProviderAdapter } from 'broapp/ai/host';
import { BroappProvider } from 'broapp/react';
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

import { App } from '../packages/broapp-autoapp/src/launcher/ui/App.tsx';
import { overviewInterval, startOverviewPoller } from '../packages/broapp-autoapp/src/launcher/ui/overview-poll.ts';
import {
  appAction,
  OverviewScreen,
  PRIMARY,
  type OverviewData,
  type OverviewScreenProps,
} from '../packages/broapp-autoapp/src/launcher/ui/OverviewScreen.tsx';
import { launcherContract } from '../packages/broapp-autoapp/src/launcher/contract.ts';
import type { Browser, Page } from 'playwright';

import { chromiumRuns } from '../scripts/theme-check.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
import { harness } from './harness.ts';

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

// ── 17b: the Overview screen ──────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

/** A total with nothing in it. */
const NOTHING = { inputTokens: 0, outputTokens: 0, cost: 0, atLeast: false, unpricedTokens: 0 };

const EMPTY_OVERVIEW: OverviewData = {
  needsYou: [],
  running: null,
  spend: { task: null, run: null, today: NOTHING, budgetDay: null, todayByModel: [] },
  backlog: [],
  apps: [],
  recent: [],
};

const APP_ROW = { currentRelease: 'a'.repeat(32), serving: true, pid: 1, schemaVersion: 1, activationPending: false, checks: null };

/** The mockup's data, as `launcher.overview` would give it. */
const RUNNING: NonNullable<OverviewData['running']> = {
  taskId: 4,
  runId: 'intent-1-0004-filter-by-shelf-a1',
  attempt: 1,
  startedAt: NOW - 370_000,
  lastTool: 'candidate.cycle',
  lastToolAt: NOW - 38_000,
  approvals: 3,
  stage: 'building',
  turn: 1,
  maxTurns: 4,
  maxAttempts: 2,
  quietSince: NOW - 38_000,
  idleLimitMs: 480_000,
  turnLimitMs: 1_200_000,
  filesChanged: 2,
  criteria: { passed: 1, total: 3 },
  lastRefusal: null,
  tokens: { input: 30_000, output: 11_000 },
  appId: 'reading-list',
  appName: 'Reading list',
  intentId: 1,
  taskSlug: '0004-filter-by-shelf',
  taskTitle: 'Filter by shelf',
  taskIndex: 4,
  taskCount: 6,
  modelId: 'model-a',
};

const MOCKUP: OverviewData = {
  needsYou: [
    {
      key: 'question:intent-1-0004-filter-by-shelf-a1:call-3',
      kind: 'question',
      appId: 'reading-list',
      title: 'Keep the read date?',
      detail: 'A backlog run on reading-list is waiting for you.',
      at: NOW - 60_000,
      expiresAt: NOW + 432_000,
      target: { panel: 'backlog', appId: 'reading-list', intentId: 1, taskId: 4, releaseId: null },
    },
    {
      key: 'advice:9:1',
      kind: 'advice',
      appId: 'notes',
      title: 'Task failed twice',
      detail: 'Record completion date',
      at: NOW - 120_000,
      expiresAt: null,
      target: { panel: 'backlog', appId: 'notes', intentId: 2, taskId: 9, releaseId: null },
    },
  ],
  running: RUNNING,
  spend: {
    task: { inputTokens: 30_000, outputTokens: 11_000, cost: 0.2, atLeast: true, unpricedTokens: 0 },
    run: { inputTokens: 250_000, outputTokens: 62_000, cost: 1.1, atLeast: true, unpricedTokens: 0 },
    today: { inputTokens: 1_100_000, outputTokens: 300_000, cost: 2.18, atLeast: false, unpricedTokens: 0 },
    budgetDay: 10,
    todayByModel: [{ modelId: 'model-a', inputTokens: 1_100_000, outputTokens: 300_000, cost: 2.18, atLeast: false }],
  },
  backlog: [
    { appId: 'reading-list', appName: 'Reading list', intentIds: [1], done: 3, failed: 0, running: 1, queued: 2, blocked: 0, total: 6, estimate: { ms: 35 * 60_000, tokens: 400_000, estimate: true } },
    { appId: 'notes', appName: 'Notes', intentIds: [2], done: 1, failed: 2, running: 0, queued: 0, blocked: 0, total: 3, estimate: null },
  ],
  apps: [
    { ...APP_ROW, appId: 'reading-list', name: 'Reading list', state: 'building', changedAt: NOW - 3_600_000 },
    { ...APP_ROW, appId: 'notes', name: 'Notes', state: 'needs-review', changedAt: NOW - 7_200_000 },
    { ...APP_ROW, appId: 'invoices', name: 'Invoices', serving: false, pid: null, state: 'stopped', changedAt: NOW - 3 * 86_400_000 },
  ],
  recent: [],
};

const ALERTS = { permission: 'granted', sound: false, onTurnOn: () => undefined, onSound: () => undefined, onTestSound: () => undefined };

function screen(overview: OverviewData | null, overrides: Partial<OverviewScreenProps> = {}): string {
  return renderToString(
    createElement(BroappProvider, {
      contract: launcherContract,
      children: createElement(OverviewScreen, {
        overview,
        stale: false,
        alerts: ALERTS,
        now: NOW,
        onOpenTarget: () => undefined,
        onOpenBacklog: () => undefined,
        onOpenPreview: () => undefined,
        onOpenApp: () => undefined,
        onViewAll: () => undefined,
        ...overrides,
      }),
    }),
  ).replaceAll('<!-- -->', '');
}

/** The page's words, in order, markup gone. */
function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function inOrder(text: string, expected: readonly string[]): string[] {
  const missing: string[] = [];
  let at = 0;
  for (const word of expected) {
    const found = text.indexOf(word, at);
    if (found < 0) missing.push(word);
    else at = found + word.length;
  }
  return missing;
}

describe('17b: the Overview screen', () => {
  // 1.
  test('an empty overview: nothing needs you, nothing is running, and the five regions are there', () => {
    const html = screen(EMPTY_OVERVIEW);
    for (const region of ['aria-label="Summary"', 'aria-label="Needs your attention"', 'aria-label="Running now"', 'aria-label="Applications"', '<footer']) {
      expect(html).toContain(region);
    }
    const text = words(html);
    expect(text).toContain('Nothing needs you');
    expect(text).toContain('Nothing is running');
    expect(text).toContain('Open backlog');
    expect(text).not.toContain('budget');
    expect(text).not.toContain('remaining');
  });

  // 2.
  test('the mockup’s data: every figure and word of the mockup, in its order', () => {
    const text = words(screen(MOCKUP));
    expect(
      inOrder(text, [
        'Overview',
        'Everything you need to keep work moving.',
        'Needs attention', '2', '1 question · 1 failed task',
        'Running now', '1', 'Reading list',
        'Queued tasks', '2', 'About 35 min remaining',
        'Spent today', '$2.18', 'of $10.00 budget · 22%',
        'Needs your attention', '2',
        'Keep the read date?', 'Reading list · Answer within 7m 12s', 'Answer',
        'Task failed twice', 'Notes · Record completion date', 'Review issue',
        'Running now', 'Building', 'Filter by shelf', 'Reading list · Task 4 of 6',
        'Reading', 'Editing', 'Building', 'Checking',
        '2', 'Files changed', '1 / 3', 'Checks passing', '6m 10s', 'Turn time',
        'Last activity 38 seconds ago · attempt 1 of 2 · stops if quiet for 8 minutes',
        'Open preview', 'View details', 'Stop run',
        'Applications', 'View all',
        'Reading list', '3 of 6 tasks done', 'Building', 'Open', '50%',
        'Notes', '1 of 3 tasks done', 'Needs review', 'Review', '33%',
        'Invoices', 'Last changed 3 days ago', 'Stopped', 'Start',
        'Tokens today', '1.4M', 'Current run', '≥312k', 'Current task', '≥41k', '· partial', 'View usage',
      ]),
    ).toEqual([]);
  });

  // 3.
  test('spend: no cost shows tokens and no dollar; a floor is marked; unpriced tokens are said; the budget warns at 100%', () => {
    const unpriced = screen({
      ...EMPTY_OVERVIEW,
      spend: { ...EMPTY_OVERVIEW.spend, today: { inputTokens: 1_000_000, outputTokens: 400_000, cost: null, atLeast: false, unpricedTokens: 1_400_000 }, budgetDay: 10 },
    });
    expect(words(unpriced)).toContain('1.4M tokens');
    expect(words(unpriced)).toContain('No prices set');
    expect(unpriced).not.toContain('$');
    const floor = words(screen({ ...EMPTY_OVERVIEW, spend: { ...EMPTY_OVERVIEW.spend, today: { inputTokens: 900, outputTokens: 100, cost: 0.5, atLeast: true, unpricedTokens: 0 } } }));
    expect(floor).toContain('≥$0.50 partial');
    const some = words(screen({ ...EMPTY_OVERVIEW, spend: { ...EMPTY_OVERVIEW.spend, today: { inputTokens: 1_000_000, outputTokens: 0, cost: 3, atLeast: false, unpricedTokens: 45_000 } } }));
    expect(some).toContain('45k tokens have no price');
    const over = screen({ ...EMPTY_OVERVIEW, spend: { ...EMPTY_OVERVIEW.spend, today: { inputTokens: 1, outputTokens: 0, cost: 10, atLeast: false, unpricedTokens: 0 }, budgetDay: 10 } });
    expect(over).toMatch(/class="launcher__ov-s launcher__ov-warn"[^>]*>of \$10\.00 budget <span class="launcher__ov-nowrap">· 100%/);
    const under = screen({ ...EMPTY_OVERVIEW, spend: { ...EMPTY_OVERVIEW.spend, today: { inputTokens: 1, outputTokens: 0, cost: 2, atLeast: false, unpricedTokens: 0 }, budgetDay: null } });
    expect(words(under)).not.toContain('budget');
    // Something that ran is never $0.00 by default: with nothing priced it is tokens.
    expect(words(screen({ ...EMPTY_OVERVIEW, spend: { ...EMPTY_OVERVIEW.spend, today: { inputTokens: 5, outputTokens: 0, cost: null, atLeast: true, unpricedTokens: 5 } } }))).not.toContain('$0.00');
  });

  // 4.
  test('the stepper marks the stage, the ones before it done, and moves back', () => {
    const at = (stage: NonNullable<OverviewData['running']>['stage']): string[] => {
      const html = screen({ ...MOCKUP, running: { ...RUNNING, stage } });
      const steps = /<ol aria-label="Stage"[^>]*>(.*?)<\/ol>/.exec(html)?.[1] ?? '';
      return [...steps.matchAll(/<li([^>]*)>/g)].map((match) => {
        const attributes = match[1] ?? '';
        return attributes.includes('aria-current="step"') ? 'current' : attributes.includes('--done') ? 'done' : 'ahead';
      });
    };
    expect(at('building')).toEqual(['done', 'done', 'current', 'ahead']);
    // A failed build then an edit: the next read is back at editing.
    expect(at('editing')).toEqual(['done', 'current', 'ahead', 'ahead']);
    expect(at('reading')).toEqual(['current', 'ahead', 'ahead', 'ahead']);
  });

  // 5.
  test('under a minute of quiet left, the activity line warns', () => {
    const calm = screen({ ...MOCKUP, running: { ...RUNNING, quietSince: NOW - 38_000 } });
    expect(calm).toMatch(/class="launcher__ov-quiet"[^>]*>Last activity/);
    const late = screen({ ...MOCKUP, running: { ...RUNNING, quietSince: NOW - 430_000 } });
    expect(late).toMatch(/class="launcher__ov-quiet launcher__ov-warn"[^>]*>Last activity/);
  });

  // 6.
  test('exactly one filled button: two attention items, none with a run going, none with nothing running', () => {
    const filled = (html: string): number => html.split(PRIMARY).length - 1;
    expect(filled(screen(MOCKUP))).toBe(1);
    expect(screen(MOCKUP)).toMatch(new RegExp(`class="launcher__button ${PRIMARY}"[^>]*>Answer<`));
    expect(filled(screen({ ...MOCKUP, needsYou: [] }))).toBe(1);
    expect(screen({ ...MOCKUP, needsYou: [] })).toMatch(new RegExp(`class="launcher__button ${PRIMARY}"[^>]*>Open preview<`));
    expect(filled(screen(EMPTY_OVERVIEW))).toBe(1);
    expect(screen(EMPTY_OVERVIEW)).toMatch(new RegExp(`class="launcher__button ${PRIMARY}"[^>]*>Open backlog<`));
  });

  // 7, the half without a browser.
  test('nothing on this screen, or the App around it, activates anything', async () => {
    const source = await Bun.file(join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'launcher', 'ui', 'OverviewScreen.tsx')).text();
    expect(source).not.toContain('launcher.activate');
    expect(source).not.toContain('launcher.intentStop');
    expect(source).not.toContain('launcher.intentAnswer');
  });

  // 8.
  test('application rows: Open, Review and Start by state, and a progress bar only with an open intent', () => {
    expect(appAction({ state: 'serving' })).toBe('Open');
    expect(appAction({ state: 'building' })).toBe('Open');
    expect(appAction({ state: 'needs-review' })).toBe('Review');
    expect(appAction({ state: 'stopped' })).toBe('Start');
    const html = screen(MOCKUP);
    // Two open intents, two bars; Invoices has none.
    expect(html.split('launcher__ov-fill').length - 1).toBe(2);
    expect(screen({ ...MOCKUP, backlog: [] }).split('launcher__ov-fill').length - 1).toBe(0);
  });

  // 9, the half without a browser.
  test('"Turn on alerts" shows only for default permission; blocked says so; requestAlerts is called from one place', async () => {
    expect(words(screen(EMPTY_OVERVIEW, { alerts: { ...ALERTS, permission: 'default' } }))).toContain('Turn on alerts');
    for (const permission of ['granted', 'denied', 'unsupported']) {
      expect(words(screen(EMPTY_OVERVIEW, { alerts: { ...ALERTS, permission } }))).not.toContain('Turn on alerts');
    }
    expect(words(screen(EMPTY_OVERVIEW, { alerts: { ...ALERTS, permission: 'denied' } }))).toContain('Notifications are blocked');
    const ui = join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'launcher', 'ui');
    const callers: string[] = [];
    for (const name of readdirSync(ui)) {
      const text = await Bun.file(join(ui, name)).text();
      for (const line of text.split('\n')) if (line.includes('requestAlerts(')) callers.push(`${name}: ${line.trim()}`);
    }
    expect(callers).toEqual(['App.tsx: void requestAlerts(surface).then(setPermission);']);
    expect(words(screen(EMPTY_OVERVIEW, { alerts: { ...ALERTS, sound: true } }))).toContain('Test sound');
    expect(screen(EMPTY_OVERVIEW, { alerts: { ...ALERTS, sound: true } })).toContain('checked=""');
  });

  // 10.
  test('reading: 2 s on the Overview while visible, 10 s otherwise, one read in flight, a failed read goes on', async () => {
    expect(overviewInterval('overview', true)).toBe(2_000);
    expect(overviewInterval('overview', false)).toBe(10_000);
    expect(overviewInterval('chat', true)).toBe(10_000);
    // A clock the test moves; timers fire when it passes them.
    let clock = 0;
    const timers: { at: number; run: () => void; id: number }[] = [];
    let ids = 0;
    const fake = {
      now: () => clock,
      set: (run: () => void, ms: number) => {
        ids += 1;
        timers.push({ at: clock + ms, run, id: ids });
        return ids;
      },
      clear: (id: unknown) => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index >= 0) timers.splice(index, 1);
      },
    };
    const advance = async (ms: number): Promise<void> => {
      const until = clock + ms;
      for (;;) {
        // Let a read that settled schedule the next one first.
        await Bun.sleep(0);
        await Bun.sleep(0);
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > until) break;
        timers.shift();
        clock = next.at;
        next.run();
        await Bun.sleep(0);
        await Bun.sleep(0);
      }
      clock = until;
    };
    const reads: number[] = [];
    let release: (() => void) | null = null;
    let slow = false;
    let fail = false;
    const poller = startOverviewPoller(
      () => {
        reads.push(clock);
        if (fail) return Promise.reject(new Error('no'));
        if (!slow) return Promise.resolve();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      { view: 'overview', visible: true },
      fake,
    );
    await advance(0);
    expect(reads).toEqual([0]);
    await advance(6_000);
    expect(reads).toEqual([0, 2_000, 4_000, 6_000]);
    // The chat is the view: every ten seconds from the last read.
    poller.setMode('chat', true);
    await advance(9_000);
    expect(reads).toEqual([0, 2_000, 4_000, 6_000]);
    await advance(1_000);
    expect(reads.at(-1)).toBe(16_000);
    // Back on the Overview but hidden: still ten.
    poller.setMode('overview', false);
    await advance(10_000);
    expect(reads.at(-1)).toBe(26_000);
    // Visible again: the next read comes two seconds after the last.
    poller.setMode('overview', true);
    await advance(2_000);
    expect(reads.at(-1)).toBe(28_000);
    // A slow read: nothing else is sent while it is out.
    slow = true;
    await advance(2_000);
    const before = reads.length;
    await advance(20_000);
    expect(reads.length).toBe(before);
    slow = false;
    (release as (() => void) | null)?.();
    await advance(0);
    await advance(2_000);
    expect(reads.length).toBe(before + 1);
    // A failed read is followed by the next one at the same pace.
    fail = true;
    await advance(2_000);
    await advance(2_000);
    expect(reads.length).toBe(before + 3);
    poller.stop();
    await advance(20_000);
    expect(reads.length).toBe(before + 3);
  });

  test('a failed read keeps the last data and says it could not refresh', () => {
    const text = words(screen(MOCKUP, { stale: true }));
    expect(text).toContain('Could not refresh');
    expect(text).toContain('Filter by shelf');
    expect(words(screen(null, { stale: true }))).toContain('Could not refresh');
  });

  // 11.
  test('the stylesheet: the screen’s colours are launcher variables, no new variable, no font', async () => {
    const css = await Bun.file(join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'launcher', 'ui', 'launcher.css')).text();
    const start = css.indexOf(' * The Overview: the screen the launcher opens on');
    expect(start).toBeGreaterThan(0);
    const screenCss = css.slice(start);
    const colour = /^\s*(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|box-shadow|outline(-color)?|accent-color|fill|stroke|text-decoration-color|caret-color)\s*:\s*([^;]+);/gm;
    const bad: string[] = [];
    for (const match of screenCss.matchAll(colour)) {
      const value = match[7] ?? '';
      const colours = value.replace(/var\(--launcher-[a-z-]+\)/g, '').replace(/\b(none|transparent|0|solid|inset|[0-9.]+(px|rem|em)?)\b/g, '');
      if (/[a-z]/i.test(colours.replace(/[\s,()-]/g, ''))) bad.push(match[0].trim());
    }
    expect(bad).toEqual([]);
    expect(screenCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(screenCss).not.toMatch(/\brgba?\(|\bhsla?\(|light-dark\(|@font-face|font-family/);
    const declared = new Set([...css.matchAll(/(--launcher-[a-z-]+)\s*:/g)].map((match) => match[1]));
    expect([...declared].sort()).toEqual(
      [
        '--launcher-accent', '--launcher-accent-contrast', '--launcher-border', '--launcher-error-surface', '--launcher-error-text',
        '--launcher-good-surface', '--launcher-good-text', '--launcher-ground', '--launcher-heading', '--launcher-hover', '--launcher-muted',
        '--launcher-pending', '--launcher-quiet', '--launcher-selected', '--launcher-surface', '--launcher-text', '--launcher-warn-border',
        '--launcher-warn-surface', '--launcher-warn-text',
      ].sort(),
    );
    // Every variable the screen reads is one of them.
    const used = new Set([...screenCss.matchAll(/var\((--launcher-[a-z-]+)\)/g)].map((match) => match[1]));
    for (const name of used) expect(declared.has(name)).toBe(true);
  });

  // 12, the half without a browser.
  test('the first render is the Overview: first on the rail, marked current; the chat is mounted and hidden; the applications column is not drawn', () => {
    const html = renderToString(
      createElement(BroappProvider, {
        contract: launcherContract,
        extensions: [aiContract],
        children: createElement(AiProvider, { children: createElement(App) }),
      }),
    );
    const rail = /<nav aria-label="Workspace"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? '';
    const first = /<button([^>]*)>/.exec(rail)?.[1] ?? '';
    expect(first).toContain('aria-label="Overview"');
    expect(first).toContain('aria-current="page"');
    expect(html).toContain('data-view="overview"');
    // The chat is there, once, hidden rather than removed.
    expect(html.match(/aria-label="Engineer" class="launcher__chat"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-label="Engineer" class="launcher__chat" hidden=""/);
    // The applications column is not in the document, and its toggle says why.
    expect(html).not.toContain('aria-label="Your applications"');
    expect(html).toMatch(/aria-label="Applications" class="launcher__rail-button" disabled=""/);
  });
});

// ── 17b in a browser: the views, the chat that survives them, the actions ─────
//
// A real launcher tab on a real bridge, its page built as the launcher builds
// it, driven in Chromium. Where Chromium cannot be launched the block is
// skipped, as `autoapp-theme-browser.test.ts` is; CI's `theme` job installs it
// and runs this file there too.

const browserAvailable = await chromiumRuns();
let pageDir: string | null = null;
let launcherPage = '';

/** Build the launcher's page into a temporary file, in a child: `Bun.build` under `bun test` cannot resolve every nested package. */
async function buildLauncherPage(): Promise<string> {
  pageDir = mkdtempSync(join(tmpdir(), 'autoapp-'));
  const out = join(pageDir, 'launcher-page.html');
  const root = join(import.meta.dir, '..', 'packages', 'broapp-autoapp');
  const code = `import { buildPage } from 'broapp/build'; await buildPage({ root: ${JSON.stringify(root)}, entry: 'src/launcher/ui/main.tsx', template: 'src/launcher/ui/index.html', outFile: ${JSON.stringify(out)} });`;
  const child = Bun.spawn({ cmd: [process.execPath, '-e', code], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [status, errors] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  if (status !== 0) throw new Error(`the launcher page did not build: ${errors}`);
  return await Bun.file(out).text();
}

/** A text turn slow enough to switch views while it streams: about six seconds. */
const SLOW_WORDS: readonly FakeStep[] = [{ kind: 'text', chunks: Array.from({ length: 30 }, (_, index) => `word${String(index)} `) }];

interface InBrowser {
  readonly world: Tab;
  readonly page: Page;
}

let browser: Browser | null = null;

async function openInBrowser(options: { script?: readonly FakeStep[]; seed?: (world: Tab) => void; init?: string } = {}): Promise<InBrowser> {
  const world = tabOver({ ...(options.script === undefined ? {} : { script: options.script }), chunkDelayMs: 200 });
  mkdirSync(join(world.root, 'apps'), { recursive: true });
  options.seed?.(world);
  await world.tab.ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
  const live = await harness((bridge) => world.tab.mount(bridge), { page: launcherPage });
  closers.push(() => live.stop());
  if (browser === null) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  closers.push(() => context.close());
  if (options.init !== undefined) await context.addInitScript(options.init);
  const page = await context.newPage();
  await page.goto(live.url);
  await page.waitForSelector('[data-view="overview"]', { timeout: 20_000 });
  return { world, page };
}

const view = async (page: Page): Promise<string | null> => await page.getAttribute('.launcher', 'data-view');
const turn = async (page: Page): Promise<string | null> => await page.getAttribute('.launcher', 'data-turn');

describe.skipIf(!browserAvailable)('17b: the Overview in a browser', () => {
  beforeAll(async () => {
    launcherPage = await buildLauncherPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    browser = null;
    if (pageDir !== null) rmSync(pageDir, { recursive: true, force: true });
  });

  // 13.
  test('a turn started in the chat is still running, still busy and still showing its words after the Overview and back; the chat is mounted once', async () => {
    const { page } = await openInBrowser({ script: SLOW_WORDS });
    await page.getByRole('button', { name: 'Engineer', exact: true }).click();
    expect(await view(page)).toBe('chat');
    await page.waitForSelector('.broapp-chat textarea');
    // Mark the chat's element: a remount would make a new one without it.
    await page.evaluate(() => {
      const chat = document.querySelector<HTMLElement>('.broapp-chat');
      if (chat !== null) chat.dataset['probe'] = 'kept';
    });
    await page.fill('.broapp-chat textarea', 'Say thirty words, slowly.');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-turn="busy"]', { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('.broapp-chat')?.textContent?.includes('word2') === true, undefined, { timeout: 10_000 });

    await page.getByRole('button', { name: /^Overview/ }).click();
    expect(await view(page)).toBe('overview');
    expect(await turn(page)).toBe('busy');
    expect(await page.locator('.broapp-chat').count()).toBe(1);
    expect(await page.locator('.launcher__chat').isHidden()).toBe(true);
    await page.waitForTimeout(1_000);
    expect(await turn(page)).toBe('busy');

    await page.getByRole('button', { name: 'Engineer', exact: true }).click();
    expect(await view(page)).toBe('chat');
    expect(await page.getAttribute('.broapp-chat', 'data-probe')).toBe('kept');
    expect(await page.locator('.broapp-chat').count()).toBe(1);
    // Still streaming, and it goes on to the end.
    expect(await turn(page)).toBe('busy');
    await page.waitForFunction(() => document.querySelector('.broapp-chat')?.textContent?.includes('word29') === true, undefined, { timeout: 20_000 });
    await page.waitForSelector('[data-turn="idle"]', { timeout: 10_000 });
    expect(await page.getAttribute('.broapp-chat', 'data-probe')).toBe('kept');
  }, 90_000);

  // 12, the half a first render cannot show.
  test('views: New conversation and a picked conversation show the chat, the rail marks the view, and a reload opens on the Overview', async () => {
    const { page } = await openInBrowser();
    const overviewButton = page.getByRole('button', { name: /^Overview/ });
    const engineer = page.getByRole('button', { name: 'Engineer', exact: true });
    expect(await overviewButton.getAttribute('aria-current')).toBe('page');
    expect(await page.locator('[aria-label="Your applications"]').count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Applications', exact: true }).isDisabled()).toBe(true);

    await page.locator('.launcher__rail').getByRole('button', { name: 'New conversation' }).click();
    expect(await view(page)).toBe('chat');
    expect(await engineer.getAttribute('aria-current')).toBe('page');
    expect(await overviewButton.getAttribute('aria-current')).toBeNull();
    expect(await page.getByRole('button', { name: 'Applications', exact: true }).isDisabled()).toBe(false);

    await overviewButton.click();
    expect(await view(page)).toBe('overview');
    // Picking a conversation from the list shows the chat.
    await page.locator('.launcher__history').getByText('New conversation').first().click();
    expect(await view(page)).toBe('chat');

    await page.reload();
    await page.waitForSelector('[data-view="overview"]', { timeout: 20_000 });
    expect(await view(page)).toBe('overview');
  }, 90_000);

  // 14.
  test('Log, Knowledge, Backlog and Settings open over the Overview and close back to it', async () => {
    const { page } = await openInBrowser();
    const rail = page.locator('.launcher__rail');
    for (const [open, panel, close] of [
      ['Log', '.launcher__logs', 'Close log'],
      ['Knowledge', '.launcher__k', 'Close knowledge'],
      ['Backlog', '.launcher__intent', 'Close backlog'],
      ['Settings', '.launcher__settings', 'Close settings'],
    ] as const) {
      await rail.getByRole('button', { name: open, exact: true }).click();
      await page.waitForSelector(panel);
      expect(await view(page)).toBe('overview');
      // The Backlog panel is wider than this window, so its scrim is under it:
      // it closes the way a person closes it there, with Escape.
      if (open === 'Backlog') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: close, exact: true }).click({ force: true, position: { x: 5, y: 5 } });
      await page.waitForSelector(panel, { state: 'detached' });
      expect(await view(page)).toBe('overview');
      expect(await page.locator('.launcher__overview').isVisible()).toBe(true);
    }
  }, 90_000);

  // 7.
  test('each attention row opens the panel where it is decided, on its record', async () => {
    const { page } = await openInBrowser({
      seed: (world) => {
        // A failed task with advice nobody has answered.
        const { id, taskIds } = intentWith(world.intents, ['fails-part']);
        const failed = taskIds[0] ?? 0;
        world.intents.moveTask(failed, 'in-queue', 'queued');
        world.intents.moveTask(failed, 'in-progress', 'started', 'run-failed');
        world.intents.moveTask(failed, 'failed', 'two attempts');
        world.intents.setAdvice(failed, { diagnosis: 'x', advice: 'retry', note: 'Run it again.', at: Date.now() - 1_000 });
        world.intents.setRun(id, 'running');
        world.intents.setRun(id, 'stopped', 'Build the fails part failed after 2 attempts.');
        // A candidate whose checks all passed on its own build, and nothing serving.
        const appDir = layout(world.root).app('shelf').dir;
        mkdirSync(appDir, { recursive: true });
        const releaseId = 'c'.repeat(32);
        writeFileSync(
          join(appDir, 'candidate.json'),
          JSON.stringify({
            releaseId,
            builtFromRev: null,
            builtAt: Date.now() - 5_000,
            problems: [],
            stagesRun: [],
            checks: { releaseId, previewId: `${releaseId}:1`, examples: [], results: [{ id: 'e1', title: 'e1', passed: true }], at: Date.now() },
            previewWasRunning: false,
            changed: [],
            capabilityDiff: null,
            cycle: null,
          }),
        );
      },
    });
    const band = page.locator('[aria-label="Needs your attention"]');
    await band.getByText('ready to activate').waitFor({ timeout: 20_000 });
    // The failed task: the Backlog panel, open on its request.
    await band.getByRole('button', { name: 'Review issue' }).click();
    await page.waitForSelector('.launcher__intent');
    await page.locator('.launcher__intent').getByText('Build the fails part part').first().waitFor({ timeout: 10_000 });
    expect(await page.locator('.launcher__intent').getByText('Do these things.').count()).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.launcher__intent', { state: 'detached' });
    // The release ready to activate: the candidate panel, beside the chat, on its application.
    await band.getByRole('button', { name: 'Review', exact: true }).click();
    expect(await view(page)).toBe('chat');
    await page.waitForSelector('[aria-label="Your applications"]');
    await page.locator('[aria-label="Your applications"]').getByText(/Built c{8}|cccccccc/).first().waitFor({ timeout: 10_000 });
  }, 90_000);

  // 9, the half a render cannot show.
  test('Turn on alerts asks once, on its click; the Sound switch follows it, survives a reload, is off when storage refuses; Test sound plays once', async () => {
    const stubs = `
      window.__asked = 0;
      window.__notes = 0;
      window.Notification = class {
        static permission = localStorage.getItem('test-permission') ?? 'default';
        static requestPermission() {
          window.__asked += 1;
          localStorage.setItem('test-permission', 'granted');
          window.Notification.permission = 'granted';
          return Promise.resolve('granted');
        }
      };
      window.AudioContext = class {
        state = 'running';
        currentTime = 0;
        destination = {};
        resume() { return Promise.resolve(); }
        createOscillator() {
          return { type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() { window.__notes += 1; }, stop() {} };
        }
        createGain() {
          return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
        }
      };
    `;
    const { page } = await openInBrowser({ init: stubs });
    const sound = page.getByRole('checkbox', { name: 'Sound' });
    expect(await sound.isChecked()).toBe(false);
    // Two reads go by; nothing asks.
    await page.waitForTimeout(4_500);
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
    await page.getByRole('button', { name: 'Turn on alerts' }).click();
    await page.waitForFunction(() => (window as unknown as { __asked: number }).__asked === 1);
    expect(await sound.isChecked()).toBe(true);
    expect(await page.getByRole('button', { name: 'Turn on alerts' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Test sound' }).click();
    // The attention tone is two notes, played once.
    await page.waitForFunction(() => (window as unknown as { __notes: number }).__notes === 2);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __notes: number }).__notes)).toBe(2);

    await page.reload();
    await page.waitForSelector('[data-view="overview"]', { timeout: 20_000 });
    expect(await page.getByRole('checkbox', { name: 'Sound' }).isChecked()).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);

    // Storage that refuses: the switch is off.
    const refusing = await openInBrowser({
      init: `${stubs}; Storage.prototype.getItem = function () { throw new Error('refused'); };`,
    });
    expect(await refusing.page.getByRole('checkbox', { name: 'Sound' }).isChecked()).toBe(false);
  }, 120_000);
});
