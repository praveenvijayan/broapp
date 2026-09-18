/**
 * Running a backlog: the executor, its verdict, its standing answer, and the
 * routes and panel that start, stop and answer it.
 *
 * The builders' turns are real turns of the launcher's tab, on the fake
 * adapter, scripted as a model would make the calls — so a task that completes
 * really edited `autoapp.json`, really built, really previewed on a copy of the
 * data and really passed its examples. Every test awaits the executor's
 * `idle()` and stops every child in `afterEach`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { aiContract } from 'broapp/ai';
import { createFakeAdapter, type Ai, type FakeAdapter, type FakeStep, type ProviderAdapter } from 'broapp/ai/host';
import type { BroappClient } from 'broapp/client';
import { createGate } from 'broapp/host';
import type { Approver, Envelope, Gate, HostLogger } from 'broapp/host';
import { mergeContracts } from 'broapp/shared';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import {
  BUILDER_MAY_NOT_PLAN,
  engineerTools,
  intentTools,
  RUN_AGREEMENT,
  specReference,
  SPLIT_RULES,
} from 'broapp-autoapp/engineer';
import {
  createExecutor,
  DECIDE,
  idleSentence,
  INTENT_APPROVES,
  INTENT_REFUSES,
  LAUNCHER_STOPPED,
  NOT_AN_ATTEMPT,
  nothingDoneStopped,
  openIntents,
  providerStopped,
  QUESTION_EXPIRED,
  RUN_FINISHED,
  standingAnswer,
  verdictOf,
  type IntentStore,
  type TaskInput,
} from 'broapp-autoapp/intent';
import { createEventLog, createEvidence, openKnowledge, sanitisedLogger, type Knowledge } from 'broapp-autoapp/knowledge';
import {
  buildCandidate,
  createApplication,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  type LauncherTab,
} from 'broapp-autoapp/launcher';
import { layout, readCurrent, setCurrent, type Layout } from 'broapp-autoapp/spec';

import {
  BY_HAND,
  FAILED_NEXT,
  IntentPanel,
  RUN_CONFIRMATION,
  RUN_DONE,
  shouldPoll,
} from '../packages/broapp-autoapp/src/launcher/ui/IntentPanel.tsx';
import { firstSelection } from '../packages/broapp-autoapp/src/launcher/ui/selection.ts';
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
  built = mkdtempSync(join(runRoot, 'intent-run-built-'));
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

/** Run git in a directory with an identity, so a machine without one still commits. */
function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
}

// ── A world: a launcher root, its stores and its tab ────────────────────────

interface WorldOptions {
  readonly confirmTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxTurns?: number;
  readonly turnTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** The fake model's delay between chunks, so a turn can be slow without a tool call. */
  readonly chunkDelayMs?: number;
  /** From this model call on (0 is the first), the provider fails with {@link PROVIDER_FAILURE}. */
  readonly failFrom?: number;
  /** Choose the provider in Settings and no model, so a turn cannot start. */
  readonly noModel?: boolean;
}

/**
 * A provider's failure in the shape 13d's run printed: an out-of-credit
 * sentence with the settings address that names the key. The key's id here is
 * made up; no real one is in any fixture.
 */
const FAKE_KEY_ID = 'a'.repeat(24) + '0123456789abcdef'.repeat(2) + 'b'.repeat(8);
const PROVIDER_FAILURE = `This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 83488. To increase, visit https://openrouter.ai/workspaces/default/keys/${FAKE_KEY_ID} and adjust the key's total limit`;

interface World {
  readonly root: Layout;
  readonly dataDir: string;
  readonly intents: IntentStore;
  readonly knowledge: Knowledge;
  readonly runs: RunStore;
  readonly gate: Gate;
  readonly tab: LauncherTab;
  readonly fake: FakeAdapter;
  /** Every model id a turn or a question was sent to, in order. */
  readonly asked: string[];
}

async function world(script: readonly FakeStep[], options: WorldOptions = {}): Promise<World> {
  if (built === null) throw new Error('nothing was built');
  const directory = mkdtempSync(join(runRoot, 'intent-run-'));
  scratch.push(directory);
  cpSync(join(built, 'apps'), join(directory, 'apps'), { recursive: true });
  const root = layout(directory);
  // A repository of its own, so every applied change is a commit and a
  // revision the verdict can compare.
  const source = root.app('items').source;
  git(source, 'init', '--quiet');
  git(source, 'add', '-A');
  git(source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'the fixture');

  const dataDir = join(directory, 'launcher');
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 5_000;
  const intents = openIntents(dataDir);
  const knowledge = openKnowledge(dataDir);
  const log = createEventLog(knowledge, { source: 'launcher', tee: quiet });
  const runs = createRunStore(dataDir, quiet);
  const journal = openJournal(root.journal);
  const supervisor = createSupervisor({ logger: quiet });
  const gate = createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs, recorder: runs.recorder(), logger: quiet });
  const fake = createFakeAdapter({
    script,
    ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
    models: [
      { provider: 'fake', modelId: 'fake-1', label: 'Fake 1', capabilities: { tools: true, vision: false, structuredOutput: true } },
      { provider: 'fake', modelId: 'fake-deep', label: 'Fake deep', capabilities: { tools: true, vision: false, structuredOutput: true } },
    ],
  });
  const asked: string[] = [];
  let calls = 0;
  const adapter: ProviderAdapter = {
    ...fake,
    model: (config, modelId) => {
      asked.push(modelId);
      const model = fake.model(config, modelId);
      const failFrom = options.failFrom;
      if (failFrom === undefined || typeof model !== 'object') return model;
      // Every call from `failFrom` on is refused by the provider, as a spent
      // key is: the stream never starts.
      return new Proxy(model, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (property !== 'doStream' || typeof value !== 'function') return value;
          return (...args: unknown[]): unknown => {
            calls += 1;
            if (calls > failFrom) return Promise.reject(new Error(PROVIDER_FAILURE));
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
  const tab = createLauncherTab({
    layout: root,
    supervisor,
    journal,
    gate,
    dataDir,
    store: runs,
    templates: TEMPLATES,
    versions: STARTER_VERSIONS,
    install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
    initGit: () => false,
    providers: [adapter],
    fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), { preconnect: () => undefined }) as typeof fetch,
    logger: quiet,
    openBrowser: () => Promise.resolve(true),
    knowledge: { store: knowledge, log, evidence: createEvidence(knowledge, log) },
    intents,
    distil: false,
    confirmTimeoutMs,
    run: {
      turnTimeoutMs: options.turnTimeoutMs ?? 120_000,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    },
  });
  closers.push(
    () => supervisor.stopAll(5_000),
    () => journal.close(),
    () => runs.close(),
    () => intents.close(),
    () => tab.ai.close(),
    () => knowledge.close(),
    async () => {
      tab.executor?.stopAll('the test');
      await tab.executor?.idle();
    },
  );
  await tab.ai.registry.update(options.noModel === true ? { provider: 'fake' } : { provider: 'fake', modelId: 'fake-1' });
  return { root, dataDir, intents, knowledge, runs, gate, tab, fake, asked };
}

function executorOf(w: World): NonNullable<LauncherTab['executor']> {
  if (w.tab.executor === null) throw new Error('the tab has no executor');
  return w.tab.executor;
}

const launcherAndAi = mergeContracts(launcherContract, aiContract);
type LauncherClient = BroappClient<typeof launcherAndAi>;

async function connect(tab: LauncherTab): Promise<LauncherClient> {
  live = await harness((bridge) => tab.mount(bridge));
  const client = await live.connect(launcherAndAi);
  closers.push(() => client.close());
  return client;
}

/** A plan that passes the validator; `blockedBy` may name words or slugs. */
function plan(words: string, overrides: Partial<TaskInput> = {}): TaskInput {
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
    ...overrides,
  };
}

/** A submitted intent for `appId` with these tasks, in this order. */
function submitted(intents: IntentStore, tasks: readonly TaskInput[], appId = 'items'): { id: number; slugs: string[] } {
  const intent = intents.createIntent({ appId, request: 'Do these things.' });
  intents.replaceAnalysis(intent.id, {
    restated: 'Do these things, one after another.',
    fits: 'Builds on items.list.',
    conflicts: [],
    outOfReach: [],
    assumptions: [],
    questions: [],
  });
  const slugs = tasks.map((task) => intents.addTask(intent.id, task, { deferReferences: true }).slug);
  expect(intents.submit(intent.id)).toEqual([]);
  return { id: intent.id, slugs };
}

function text(words: string): FakeStep {
  return { kind: 'text', chunks: [words] };
}

function tool(name: string, input: unknown, then: readonly FakeStep[] = [text('done')]): FakeStep {
  return { kind: 'tool', name, input, then };
}

/** A builder's cycle adding one passing example per criterion id given. */
function cycle(slug: string, ids: readonly string[] = ['c1', 'c2'], then: readonly FakeStep[] = [text('done')]): FakeStep {
  const examples = ids
    .map((id) => `\n    { "id": "${slug}-${id}", "title": "${slug} ${id}", "steps": [{ "route": "items.list", "input": null }] },`)
    .join('');
  return tool(
    'candidate.cycle',
    {
      appId: 'items',
      message: `examples for ${slug}`,
      hunks: [{ path: 'autoapp.json', find: '"acceptance": [', replace: `"acceptance": [${examples}` }],
    },
    then,
  );
}

/** A cycle with no hunks: build, preview and check the workspace as it is. */
function verify(then: readonly FakeStep[] = [text('done')]): FakeStep {
  return tool('candidate.cycle', { appId: 'items', message: 'verify', hunks: [] }, then);
}

/** Add one example per criterion id with `source.edit`, and build nothing. */
function editOnly(slug: string, ids: readonly string[], then: readonly FakeStep[] = [text('done')]): FakeStep {
  const examples = ids
    .map((id) => `\n    { "id": "${slug}-${id}", "title": "${slug} ${id}", "steps": [{ "route": "items.list", "input": null }] },`)
    .join('');
  return tool(
    'source.edit',
    { appId: 'items', message: `examples for ${slug}`, hunks: [{ path: 'autoapp.json', find: '"acceptance": [', replace: `"acceptance": [${examples}` }] },
    then,
  );
}

/** An edit to the blank application, which the standing answer does not cover. */
function editEmpty(name: string, then: readonly FakeStep[] = []): FakeStep {
  return tool(
    'source.edit',
    { appId: 'empty', message: `rename to ${name}`, hunks: [{ path: 'autoapp.json', find: '"name": "Empty"', replace: `"name": "${name}"` }] },
    then,
  );
}

async function until<T>(read: () => T | null | undefined | Promise<T | null | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waited too long');
    await Bun.sleep(20);
  }
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

/** Every prompt the fake was sent, as text. */
function prompts(fake: FakeAdapter): string[] {
  return fake.calls.map((call) => JSON.stringify(call));
}

/** An envelope from an ordinary chat turn, answered yes by whoever asks. */
function chatEnvelope(runId: string, approver: Approver = { ask: () => Promise.resolve(true) }): Envelope {
  return { requestId: `${runId}:call-1`, channel: 'ai', caller: `ai:${runId}`, approver };
}

// ── Step 0 ──────────────────────────────────────────────────────────────────

describe('step 0: corrections from the review of 13b', () => {
  test('blockedBy and repaidBy accept a task’s words, resolve to the whole slug, and name both on an ambiguity', () => {
    const dir = mkdtempSync(join(runRoot, 'intent-run-refs-'));
    scratch.push(dir);
    const intents = openIntents(dir);
    closers.push(() => intents.close());
    const intent = intents.createIntent({ appId: 'items', request: 'r' });

    // At add time, when the task already exists.
    const first = intents.addTask(intent.id, plan('add-tags'), { deferReferences: true });
    const second = intents.addTask(intent.id, plan('filter-by-tag', { blockedBy: ['add-tags'] }), { deferReferences: true });
    expect(second.blockedBy).toEqual([first.slug]);

    // At submit, for a task named before it was added.
    const early = intents.addTask(intent.id, plan('show-counts', { blockedBy: ['count-route'] }), { deferReferences: true });
    expect(early.blockedBy).toEqual(['count-route']);
    const later = intents.addTask(intent.id, plan('count-route'), { deferReferences: true });
    expect(intents.submit(intent.id)).toEqual([]);
    expect(intents.task(early.id)?.blockedBy).toEqual([later.slug]);

    // Two tasks with the same words: the reference names both.
    const other = intents.createIntent({ appId: 'items', request: 'r2' });
    const a = intents.addTask(other.id, plan('same-words'), { deferReferences: true });
    const b = intents.addTask(other.id, plan('same-words'), { deferReferences: true });
    const problems = intents.planProblems(other.id, plan('waits-on-it', { blockedBy: ['same-words'] }));
    expect(problems).toEqual([
      { field: 'blocked_by', message: `blocked_by names same-words, which could be ${a.slug} or ${b.slug}. Name the whole slug.` },
    ]);
    // A reference that matches nothing is still refused at submit.
    intents.addTask(other.id, plan('dangling', { blockedBy: ['nothing-here'] }), { deferReferences: true });
    expect(intents.submit(other.id).map((problem) => problem.message).join(' ')).toContain('nothing-here');
  });

  test('the intent.task description says either form is accepted', async () => {
    const w = await world([]);
    const tools = intentTools({ layout: w.root, gate: w.gate, intents: w.intents, logger: quiet });
    expect(tools.tools['intent.task']?.description).toContain('or by its words alone');
  });

  test('a read route answers while a turn is held open on a tool call', async () => {
    const w = await world([tool('source.edit', { appId: 'items', message: 'm', hunks: [{ path: 'autoapp.json', find: '"name": "Items"', replace: '"name": "Things"' }] })]);
    const { id } = submitted(w.intents, [plan('only-part')]);
    const client = await connect(w.tab);
    let confirm: { callId: string } | null = null;
    let finished = false;
    await client.subscribe(
      'ai.chat',
      { runId: 'run-held', message: 'rename items', refs: [], history: [] },
      {
        onEvent: (event) => {
          const one = event as { type: string; callId?: string };
          if (one.type === 'confirm' && one.callId !== undefined) confirm = { callId: one.callId };
          if (one.type === 'done' || one.type === 'error') finished = true;
        },
        onError: () => {
          finished = true;
        },
      },
    );
    const waiting = await until(() => confirm);
    // The turn is waiting on the person; the panel's read still answers.
    const read = await client.call('launcher.intentGet', { id });
    expect(read.intent.id).toBe(id);
    await client.call('ai.chatConfirm', { runId: 'run-held', callId: waiting.callId, approve: false });
    await until(() => (finished ? true : null));
  }, 60_000);

  test('the split rules say a criterion is what a route returns or a page declares, never how the code is written', () => {
    const sentence = 'never how the code is\n  written; how it is written goes in `testNotes`.';
    expect(SPLIT_RULES).toContain(sentence);
    expect(specReference('intents')).toContain(sentence);
  });

  test('the panel reads again while a turn runs, while the open draft is being written, or while a run goes', () => {
    const draft = { id: 1, status: 'draft' as const, submittedAt: null };
    const reviewed = { id: 1, status: 'draft' as const, submittedAt: 5 };
    expect(shouldPoll(true, [], null)).toBe(true);
    expect(shouldPoll(false, [draft], 1)).toBe(true);
    expect(shouldPoll(false, [draft], null)).toBe(false);
    expect(shouldPoll(false, [reviewed], 1)).toBe(false);
    expect(shouldPoll(false, [{ id: 2, status: 'running', submittedAt: 5 }], null)).toBe(true);
  });
});

// ── 1. The verdict ──────────────────────────────────────────────────────────

describe('step 0: corrections from the review of 13d', () => {
  // a.
  test('a turn the provider killed before any tool call interrupts its task, costs no attempt and asks no advice', async () => {
    const w = await world([], { failFrom: 0 });
    const { id, slugs } = submitted(w.intents, [plan('first-part'), plan('second-part')]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const detail = w.intents.get(id);
    const [first, second] = detail?.tasks ?? [];
    expect(first?.stored).toBe('interrupted');
    expect(first?.attempts).toBe(0);
    expect(second?.stored).toBe('in-queue');
    expect(detail?.intent.status).toBe('stopped');
    expect(detail?.intent.stopReason).toBe(providerStopped(slugs[0] ?? ''));
    expect(first?.events.some((event) => event.to === 'failed')).toBe(false);
    const interrupted = first?.events.find((event) => event.to === 'interrupted');
    expect(interrupted?.note.startsWith(NOT_AN_ATTEMPT)).toBe(true);
    expect(interrupted?.note).toContain('the AI provider failed: The AI provider returned an error.');
    // The provider's own words reached neither the history nor the panel's reason.
    expect(JSON.stringify(detail)).not.toContain('openrouter');
    // One model call for the turn, and none for advice.
    expect(w.asked).toHaveLength(1);
    expect(w.intents.attemptNotes(first?.id ?? 0).map((row) => row.notAnAttempt)).toEqual([true]);
  }, 60_000);

  // b.
  test('a turn that cannot start is treated the same way', async () => {
    const w = await world([], { noModel: true });
    const { id, slugs } = submitted(w.intents, [plan('first-part'), plan('second-part')]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const detail = w.intents.get(id);
    const [first, second] = detail?.tasks ?? [];
    expect(first?.stored).toBe('interrupted');
    expect(first?.attempts).toBe(0);
    expect(second?.stored).toBe('in-queue');
    expect(detail?.intent.stopReason).toBe(providerStopped(slugs[0] ?? ''));
    expect(first?.events.find((event) => event.to === 'interrupted')?.note).toBe(
      `${NOT_AN_ATTEMPT}the AI provider failed: Choose a model for Fake provider.`,
    );
    expect(first?.events.some((event) => event.to === 'failed')).toBe(false);
    expect(w.asked).toHaveLength(0);
  }, 60_000);

  // c.
  test('a turn that ended failed with no tool call and no error is not an attempt either', async () => {
    const w = await world([]);
    const { id, slugs } = submitted(w.intents, [plan('only-part')]);
    const real = w.tab.ai;
    const silent: Ai = { ...real, turn: () => Promise.resolve({ status: 'failed', events: [] }) };
    const executor = createExecutor({ intents: w.intents, ai: () => silent, states: w.tab.states, layout: w.root, logger: quiet });
    await executor.start(id, 'the test');
    await executor.idle();
    const detail = w.intents.get(id);
    const task = detail?.tasks[0];
    expect(task?.stored).toBe('interrupted');
    expect(task?.attempts).toBe(0);
    expect(detail?.intent.stopReason).toBe(nothingDoneStopped(slugs[0] ?? ''));
    expect(task?.events.find((event) => event.to === 'interrupted')?.note).toBe(
      `${NOT_AN_ATTEMPT}the turn ended before the model did anything`,
    );
  }, 60_000);

  // d.
  test('a provider failure after an edit is still an interruption, and the edit stays', async () => {
    const w = await world([editOnly('0001-only-part', ['c1'])], { failFrom: 1 });
    const { id } = submitted(w.intents, [plan('only-part')]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const task = w.intents.runOrder(id)[0];
    expect(task?.stored).toBe('interrupted');
    expect(task?.attempts).toBe(0);
    expect(readFileSync(join(w.root.app('items').source, 'autoapp.json'), 'utf8')).toContain('0001-only-part-c1');
    expect(w.intents.get(id)?.tasks[0]?.events.some((event) => event.to === 'failed')).toBe(false);
  }, 60_000);

  // e.
  test('the launcher’s printed log is sanitised the way the knowledge log is', () => {
    const lines: string[] = [];
    const printed = sanitisedLogger({ warn: (line) => lines.push(`warn ${line}`), error: (line) => lines.push(`error ${line}`) });
    printed.error(`[broapp] ai.chat provider error: AI_APICallError: ${PROVIDER_FAILURE}`);
    printed.warn(`[autoapp] ${PROVIDER_FAILURE}`);
    printed.warn('[autoapp] the preview of items stopped');
    expect(lines).toHaveLength(3);
    for (const line of lines.slice(0, 2)) {
      expect(line).not.toContain(FAKE_KEY_ID);
      expect(line).toContain('https://openrouter.ai/workspaces/default/keys/<redacted>');
    }
    expect(lines[2]).toBe('warn [autoapp] the preview of items stopped');
  });

  // f.
  test('the launcher’s page starts on the application the person last chose, not the first row', async () => {
    const w = await world([]);
    w.tab.session.select('items');
    const client = await connect(w.tab);
    const listed = await client.call('launcher.appsList', undefined);
    expect(listed.apps.map((row) => row.appId)).toEqual(['empty', 'items']);
    expect(listed.selected).toBe('items');
    // What the page selects, and so what the Backlog panel lists, on first open.
    expect(firstSelection(listed.apps, listed.selected)).toBe('items');
    expect(firstSelection(listed.apps, null)).toBe('empty');
    expect(firstSelection(listed.apps, 'gone')).toBe('empty');
  }, 60_000);
});

describe('verdictOf', () => {
  const task = {
    slug: '0007-add-tags',
    criteria: [
      { id: 'c1', text: 'a', failure: false },
      { id: 'c2', text: 'b', failure: true },
    ],
  };
  const passing = {
    releaseId: 'a'.repeat(32),
    problems: [],
    editsSinceBuild: false,
    checksVerified: true,
    checks: [
      { id: 'list-works', title: 'l', passed: true },
      { id: '0007-add-tags-c1', title: 'c1', passed: true },
      { id: '0007-add-tags-c2', title: 'c2', passed: true },
    ],
  };

  test('every condition met is completed', () => {
    expect(verdictOf(task, passing, 'rev-1', 'rev-2')).toEqual({ completed: true, reasons: [], passed: ['c1', 'c2'] });
  });

  test('one case per condition, each with its sentence', () => {
    const reasonsOf = (status: typeof passing, before = 'rev-1', ending = {}): readonly string[] =>
      verdictOf(task, status, before, 'rev-2', ending).reasons;
    expect(reasonsOf(passing, 'rev-2')).toEqual(['The workspace did not change.']);
    expect(reasonsOf({ ...passing, problems: [{ stage: 'views', message: 'x' }, { stage: 'views', message: 'y' }] as never })).toContain(
      'The build has 2 problems.',
    );
    expect(reasonsOf({ ...passing, editsSinceBuild: true })).toEqual(['The workspace changed after the last build.']);
    expect(reasonsOf({ ...passing, checksVerified: false })).toEqual(['The checks did not run on the build the preview is running.']);
    expect(
      reasonsOf({ ...passing, checks: passing.checks.map((check) => (check.id === 'list-works' ? { ...check, passed: false } : check)) }),
    ).toEqual(['The example list-works failed.']);
    expect(reasonsOf({ ...passing, checks: passing.checks.filter((check) => check.id !== '0007-add-tags-c2') })).toEqual([
      'No example named 0007-add-tags-c2 was run.',
    ]);
    expect(reasonsOf({ ...passing, releaseId: null as never, checks: [] })).toContain('Nothing was built.');
    expect(reasonsOf({ ...passing, checks: [] }, 'rev-1', { timedOut: true })).toContain('The turn ran out of time.');
    // The model's closing words are not an input: there is nowhere to put them.
    expect(verdictOf.length).toBe(4);
  });

  test('an example of a finished task that is gone is named; present and passing, it is completed', () => {
    const earlier = ['0003-author-column-c1', '0003-author-column-c2'];
    const gone = verdictOf(task, passing, 'rev-1', 'rev-2', {}, earlier);
    expect(gone.completed).toBe(false);
    expect(gone.reasons).toEqual([
      'The example 0003-author-column-c1, from a finished task, is gone.',
      'The example 0003-author-column-c2, from a finished task, is gone.',
    ]);
    const kept = { ...passing, checks: [...passing.checks, ...earlier.map((id) => ({ id, title: id, passed: true }))] };
    expect(verdictOf(task, kept, 'rev-1', 'rev-2', {}, earlier)).toEqual({ completed: true, reasons: [], passed: ['c1', 'c2'] });
  });

  test('the idle sentence names the limit in minutes, or in seconds below one', () => {
    expect(idleSentence(8 * 60_000)).toBe('The turn made no tool call for 8 minutes.');
    expect(idleSentence(60_000)).toBe('The turn made no tool call for 1 minute.');
    expect(idleSentence(1_500)).toBe('The turn made no tool call for 2 seconds.');
    expect(verdictOf(task, { ...passing, checks: [] }, 'rev-1', 'rev-2', { idleMs: 8 * 60_000 }).reasons).toContain(
      'The turn made no tool call for 8 minutes.',
    );
  });
});

// ── 4 (pure). The standing answer ───────────────────────────────────────────

describe('the run’s standing answer', () => {
  test('the list is edits, builds and previews, never activation or creation', () => {
    expect([...INTENT_APPROVES]).toEqual([
      'source.edit',
      'source.change',
      'candidate.cycle',
      'candidate.build',
      'candidate.preview',
      'preview.stop',
    ]);
    expect(INTENT_APPROVES).not.toContain('release.activate');
    expect(INTENT_APPROVES).not.toContain('apps.create');
    expect([...INTENT_REFUSES]).toEqual(['release.activate', 'apps.create']);
  });

  test('yes for its own application, no for the two refused, and the person for everything else', () => {
    expect(standingAnswer('items', { tool: 'candidate.cycle', input: { appId: 'items' } })).toBe(true);
    expect(standingAnswer('items', { tool: 'candidate.cycle', input: { appId: 'empty' } })).toBe('defer');
    expect(standingAnswer('items', { tool: 'release.activate', input: { appId: 'items' } })).toBe(false);
    expect(standingAnswer('items', { tool: 'apps.create', input: { appId: 'x' } })).toBe(false);
    expect(standingAnswer('items', { tool: 'launcher.somethingElse', input: { appId: 'items' } })).toBe('defer');
  });

  test('the panel and the tool say the same agreement, and the same closing sentence', () => {
    expect(RUN_CONFIRMATION).toBe(RUN_AGREEMENT);
    expect(RUN_DONE).toBe(RUN_FINISHED);
  });
});

// ── Runs ────────────────────────────────────────────────────────────────────

describe('a backlog run', () => {
  // 2 and 3.
  test('two tasks run in order, each its own turn on its own model, and the intent is done with nothing activated', async () => {
    const plans = [plan('first-part'), plan('second-part', { blockedBy: ['first-part'] })];
    const w = await world([cycle('0001-first-part'), cycle('0002-second-part')]);
    const { id, slugs } = submitted(w.intents, plans);
    const [first, second] = w.intents.runOrder(id);
    if (first === undefined || second === undefined) throw new Error('two tasks');
    expect(second.blockedBy).toEqual([slugs[0] ?? '']);
    w.intents.setModel(second.id, 'fake-deep');
    const before = readCurrent(w.root, 'items');

    const executor = executorOf(w);
    expect(await executor.start(id, 'the test')).toEqual({ started: true, tasks: 2 });
    await executor.idle();

    const detail = w.intents.get(id);
    expect(detail?.intent.status).toBe('done');
    for (const task of detail?.tasks ?? []) {
      expect(task.stored).toBe('completed');
      expect(task.events.map((event) => event.to)).toEqual(['proposed', 'in-queue', 'in-progress', 'completed']);
      expect(task.criteria.every((criterion) => criterion.passed === true)).toBe(true);
      expect(task.attempts).toBe(1);
      expect(task.revAfter).not.toBe(task.revBefore);
      expect(task.actualLines).toBeGreaterThan(0);
      expect(task.releaseId).toMatch(/^[0-9a-f]{32}$/);
    }
    // In order: the second started after the first completed.
    const at = (slug: string, to: string): number =>
      detail?.tasks.find((task) => task.slug === slug)?.events.find((event) => event.to === to)?.at ?? 0;
    expect(at(slugs[1] ?? '', 'in-progress')).toBeGreaterThanOrEqual(at(slugs[0] ?? '', 'completed'));
    // Nothing was activated.
    expect(readCurrent(w.root, 'items')).toBe(before);

    // 3. Each turn's context names the application, under the run id shape.
    const contexts = w.knowledge.db
      .query<{ run_id: string; app_id: string | null }, []>('SELECT run_id, app_id FROM contexts ORDER BY id')
      .all();
    expect(contexts).toEqual([
      { run_id: `intent-${String(id)}-${slugs[0] ?? ''}-a1`, app_id: 'items' },
      { run_id: `intent-${String(id)}-${slugs[1] ?? ''}-a1`, app_id: 'items' },
    ]);
    // The first ran on the Settings model (no id sent), the second on its own.
    expect(w.asked).toEqual(['fake-1', 'fake-deep']);
    // And each task's history names the model its turn ran on.
    const startedOn = (slug: string): string =>
      detail?.tasks.find((task) => task.slug === slug)?.events.find((event) => event.to === 'in-progress')?.note ?? '';
    expect(startedOn(slugs[0] ?? '')).toBe('turn 1 on the Settings model, fake-1');
    expect(startedOn(slugs[1] ?? '')).toBe('turn 1 on fake-deep');
    // Every move and the start and finish were written down.
    const log = w.knowledge.db.query<{ message: string }, []>("SELECT message FROM events WHERE kind = 'log' ORDER BY id").all();
    expect(log.some((row) => row.message.includes(`intent ${String(id)} started by the test`))).toBe(true);
    expect(log.some((row) => row.message.includes(`${slugs[0] ?? ''}: in-progress → completed`))).toBe(true);
    expect(log.some((row) => row.message.startsWith(`intent ${String(id)} is done`))).toBe(true);
    expect(log.some((row) => row.message.includes("the run's standing answer approved candidate.cycle for items"))).toBe(true);
  }, 240_000);

  // 4.
  test('the stand-in approves its own, refuses activation and creation, and puts the rest to the person', async () => {
    const w = await world(
      [
        tool('preview.stop', { appId: 'items' }, [
          tool('release.activate', { appId: 'items', releaseId: 'a'.repeat(32) }, [
            tool('apps.create', { appId: 'another', name: 'Another' }, [editEmpty('Empty one', [editEmpty('Empty two', [text('done')])])]),
          ]),
        ]),
      ],
      { maxAttempts: 1 },
    );
    const { id, slugs } = submitted(w.intents, [plan('only-part')]);
    const client = await connect(w.tab);
    const executor = executorOf(w);
    await executor.start(id, 'the test');

    const first = await until(async () => (await client.call('launcher.intentGet', { id })).run?.question ?? null);
    expect(first.tool).toBe('source.edit');
    expect((first.input as { appId: string }).appId).toBe('empty');
    expect((await client.call('launcher.intentRunning', undefined)).run).toEqual({ intentId: id, appId: 'items', waiting: true });
    expect((await client.call('ai.chatConfirm', { runId: first.runId, callId: first.callId, approve: true })).accepted).toBe(true);
    // A second answer to the same question finds nobody waiting.
    expect((await client.call('ai.chatConfirm', { runId: first.runId, callId: first.callId, approve: true })).accepted).toBe(false);

    const second = await until(async () => {
      const question = (await client.call('launcher.intentGet', { id })).run?.question ?? null;
      return question !== null && question.callId !== first.callId ? question : null;
    });
    await client.call('ai.chatConfirm', { runId: second.runId, callId: second.callId, approve: false });
    await executor.idle();

    expect(readFileSync(join(w.root.app('empty').source, 'autoapp.json'), 'utf8')).toContain('"name": "Empty one"');
    const runId = `intent-${String(id)}-${slugs[0] ?? ''}-a1`;
    const steps = w.runs.getRun(runId)?.steps ?? [];
    expect(steps.map((step) => [step.route, step.decision])).toEqual([
      ['preview.stop', 'confirmed'],
      ['release.activate', 'denied'],
      ['apps.create', 'denied'],
      ['source.edit', 'confirmed'],
      ['source.edit', 'denied'],
    ]);
    // Each question is in the gate's record exactly once.
    expect(new Set(steps.map((step) => step.requestId)).size).toBe(steps.length);
    const log = w.knowledge.db.query<{ message: string }, []>("SELECT message FROM events WHERE kind = 'log' ORDER BY id").all();
    expect(log.filter((row) => row.message.includes('the run refused')).length).toBe(2);
    expect(log.filter((row) => row.message.includes('put source.edit to the person')).length).toBe(2);
  }, 120_000);

  // 4b.
  test('a forwarded question nobody answers stops the run without costing the task an attempt', async () => {
    const w = await world([editEmpty('Nobody saw this')], { confirmTimeoutMs: 1_500 });
    const { id, slugs } = submitted(w.intents, [plan('only-part')]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const detail = w.intents.get(id);
    expect(detail?.intent.status).toBe('stopped');
    expect(detail?.intent.stopReason).toBe(QUESTION_EXPIRED);
    const task = detail?.tasks.find((one) => one.slug === slugs[0]);
    expect(task?.stored).toBe('interrupted');
    expect(task?.attempts).toBe(0);
  }, 60_000);

  // 4c.
  test('a builder asks, the task waits, the answer reaches the next attempt, and a third question is refused', async () => {
    const w = await world(
      [
        tool('intent.ask', { question: 'Should done items be listed first?' }, []),
        tool('intent.ask', { question: 'Should the count include done items?' }, []),
        tool('intent.ask', { question: 'And should it be bold?' }, [text('I will decide.')]),
      ],
      { maxAttempts: 1 },
    );
    const { id, slugs } = submitted(w.intents, [plan('only-part')]);
    const client = await connect(w.tab);
    const executor = executorOf(w);
    const task = (): ReturnType<IntentStore['task']> => w.intents.runOrder(id)[0] ?? null;

    await executor.start(id, 'the test');
    await executor.idle();
    expect(task()?.stored).toBe('needs-answer');
    expect(task()?.question).toBe('Should done items be listed first?');
    expect(task()?.attempts).toBe(0);
    expect(w.intents.get(id)?.intent.stopReason).toBe(`${slugs[0] ?? ''} needs an answer`);
    expect((await refusal(executor.start(id, 'the test'))).message).toContain('waiting for an answer');

    const answered = await client.call('launcher.intentAnswer', { taskId: task()?.id ?? 0, answer: 'Yes, done first.', by: 'the person' });
    expect(answered.status).toBe('in-queue');
    expect(task()?.answers.map((pair) => pair.answer)).toEqual(['Yes, done first.']);

    await executor.start(id, 'the test');
    await executor.idle();
    const second = prompts(w.fake).find((prompt) => prompt.includes('Should done items be listed first?') && prompt.includes('The person answered:'));
    expect(second).toContain('Yes, done first.');
    expect(task()?.stored).toBe('needs-answer');
    await client.call('launcher.intentAnswer', { taskId: task()?.id ?? 0, answer: 'No.', by: 'the person' });

    await executor.start(id, 'the test');
    await executor.idle();
    const third = w.knowledge.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'log' AND message LIKE '%needs-answer%'")
      .get();
    expect(third?.n).toBe(2);
    // The builder was told, in the result of its third question.
    expect(prompts(w.fake).some((prompt) => prompt.includes(DECIDE))).toBe(true);
    expect(task()?.stored).toBe('failed');

    // From an ordinary chat turn, intent.ask is refused.
    const tools = intentTools({ layout: w.root, gate: w.gate, intents: w.intents, logger: quiet, executor });
    const refused = await refusal(
      tools.tools['intent.ask']?.execute({ question: 'Is this allowed here?' }, chatEnvelope('run-chat'), new AbortController().signal) ??
        Promise.resolve(),
    );
    expect(refused.code).toBe('conflict');
  }, 120_000);

  // 5 and 6.
  test('a turn that says done without an example is not completed; two failures stop the run and the advice is stored', async () => {
    const advice = { diagnosis: 'The builder never wrote the second example.', advice: 'retry', note: 'Run it again; the plan is sound.' };
    const w = await world([
      cycle('0001-first-part', ['c1']),
      text('done, both examples are in'),
      text(JSON.stringify(advice)),
      cycle('0001-first-part', ['c2']),
      cycle('0002-second-part'),
    ]);
    const { id, slugs } = submitted(w.intents, [plan('first-part'), plan('second-part', { blockedBy: ['first-part'] })]);
    const client = await connect(w.tab);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();

    const second = prompts(w.fake).find((prompt) => prompt.includes('The last attempt ended with:'));
    expect(second).toContain(`No example named ${slugs[0] ?? ''}-c2 was run.`);
    const detail = await client.call('launcher.intentGet', { id });
    expect(detail.intent.status).toBe('stopped');
    const [first, next] = detail.tasks;
    expect(first?.stored).toBe('failed');
    expect(first?.attempts).toBe(2);
    expect((first?.failure as { reasons: string[] }).reasons).toContain(`No example named ${slugs[0] ?? ''}-c2 was run.`);
    expect(first?.advice).toEqual({ ...advice, at: expect.any(Number) });
    expect(next?.stored).toBe('in-queue');
    // The first criterion's example did pass; the plan shows it.
    expect(first?.criteria.map((criterion) => criterion.passed)).toEqual([true, false]);

    // Run again: the advice stays in front of the person while the task is
    // queued, and goes once the task completes.
    await executor.start(id, 'the test');
    const queued = w.intents.task(first?.id ?? 0);
    expect(queued?.failure).toBeNull();
    expect(queued?.advice).toEqual({ ...advice, at: expect.any(Number) });
    await executor.idle();
    expect(w.intents.get(id)?.intent.status).toBe('done');
    expect(w.intents.task(first?.id ?? 0)?.advice).toBeNull();
  }, 180_000);

  test('a malformed advice answer stores nothing and changes no status', async () => {
    const w = await world([text('done'), text('this is not the answer you asked for')], { maxAttempts: 1 });
    const { id } = submitted(w.intents, [plan('only-part')]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const task = w.intents.runOrder(id)[0];
    expect(task?.stored).toBe('failed');
    expect(task?.advice).toBeNull();
    const log = w.knowledge.db.query<{ message: string }, []>("SELECT message FROM events WHERE kind = 'log' ORDER BY id").all();
    expect(log.some((row) => row.message.includes('no advice could be read'))).toBe(true);
  }, 60_000);

  // 7.
  test('a model the provider no longer offers fails the task without a turn', async () => {
    const w = await world([]);
    const { id } = submitted(w.intents, [plan('only-part')]);
    const task = w.intents.runOrder(id)[0];
    w.intents.setModel(task?.id ?? 0, 'gone-model');
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const after = w.intents.task(task?.id ?? 0);
    expect(after?.stored).toBe('failed');
    expect(after?.failure).toEqual({ reasons: ['The model gone-model is no longer offered by Fake provider.'], runIds: [], at: expect.any(Number) });
    expect(w.fake.calls.length).toBe(0);
  }, 60_000);

  // 8.
  test('while a run works on an application, other turns may read it but not write to it, and activation waits', async () => {
    const w = await world([editEmpty('Held open')]);
    const { id } = submitted(w.intents, [plan('only-part')]);
    const client = await connect(w.tab);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await until(() => executor.progress(id).question);

    const busy = 'A backlog run is working on items. Stop it from the Backlog panel first.';
    const tools = engineerTools({
      layout: w.root,
      supervisor: createSupervisor({ logger: quiet }),
      journal: openJournal(w.root.journal),
      gate: w.gate,
      states: w.tab.states,
      logger: quiet,
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      busy: (appId, runId) => executor.busy(appId, runId),
    });
    const call = (name: string, input: unknown): Promise<unknown> =>
      tools[name]?.execute(input, chatEnvelope('run-chat'), new AbortController().signal) ?? Promise.reject(new Error(name));
    expect(
      await refusal(call('source.edit', { appId: 'items', message: 'm', hunks: [{ path: 'autoapp.json', find: '"name"', replace: '"name"' }] })),
    ).toEqual({ code: 'conflict', message: busy });
    expect(await call('source.read', { appId: 'items', path: 'autoapp.json' })).toEqual(expect.objectContaining({ path: 'autoapp.json' }));
    expect(
      await call('source.edit', { appId: 'empty', message: 'm', hunks: [{ path: 'autoapp.json', find: '"name": "Empty"', replace: '"name": "Mine"' }] }),
    ).toEqual(expect.objectContaining({ changed: ['autoapp.json'] }));
    const releaseId = readCurrent(w.root, 'items') ?? '';
    expect(await refusal(client.call('launcher.activate', { appId: 'items', releaseId }))).toEqual(
      expect.objectContaining({ message: expect.stringContaining(busy) as unknown as string }),
    );
    // The run's own turns are not busy.
    expect(executor.busy('items', `intent-${String(id)}-0001-only-part-a1`)).toBeNull();
    executor.stop(id, 'the test');
    await executor.idle();
  }, 60_000);

  // 9.
  test('stopping mid-turn interrupts the task, and running again resumes from it', async () => {
    const w = await world([editEmpty('Held open'), cycle('0001-only-part')]);
    const { id, slugs } = submitted(w.intents, [plan('only-part')]);
    const client = await connect(w.tab);
    const executor = executorOf(w);
    await client.call('launcher.intentRun', { id });
    await until(() => executor.progress(id).question);
    expect(await client.call('launcher.intentStop', { id })).toEqual({ stopped: true });
    await executor.idle();
    let detail = w.intents.get(id);
    expect(detail?.intent.status).toBe('stopped');
    expect(detail?.intent.stopReason).toBe('Stopped by the person');
    expect(detail?.tasks[0]?.stored).toBe('interrupted');
    expect(detail?.tasks[0]?.attempts).toBe(0);

    expect(await client.call('launcher.intentRun', { id })).toEqual({ started: true, tasks: 1 });
    await executor.idle();
    detail = w.intents.get(id);
    expect(detail?.intent.status).toBe('done');
    expect(detail?.tasks[0]?.stored).toBe('completed');
    // Two turns, two run ids, one counted attempt.
    expect(detail?.tasks[0]?.runIds).toEqual([`intent-${String(id)}-${slugs[0] ?? ''}-a1`, `intent-${String(id)}-${slugs[0] ?? ''}-a2`]);
    expect(detail?.tasks[0]?.attempts).toBe(1);
  }, 180_000);

  // 11.
  test('intent.start on channel ai asks once and starts only after a yes; a builder may not call it', async () => {
    const w = await world(
      [
        tool('intent.start', { intentId: 1 }, [text('Not started.')]),
        tool('intent.start', { intentId: 1 }, [text('Started; progress is in the Backlog panel.')]),
        text('builder: done'),
        text('not advice'),
      ],
      { maxAttempts: 1 },
    );
    const { id } = submitted(w.intents, [plan('only-part')]);
    expect(id).toBe(1);
    const client = await connect(w.tab);

    const chat = async (runId: string, approve: boolean): Promise<{ type: string; tool?: string }[]> => {
      const seen: { type: string; tool?: string; callId?: string }[] = [];
      let finished = false;
      await client.subscribe(
        'ai.chat',
        { runId, message: 'Go ahead with the items backlog.', refs: [], history: [] },
        {
          onEvent: (event) => {
            const one = event as { type: string; tool?: string; callId?: string };
            seen.push(one);
            if (one.type === 'confirm' && one.callId !== undefined) {
              void client.call('ai.chatConfirm', { runId, callId: one.callId, approve });
            }
            if (one.type === 'done' || one.type === 'error') finished = true;
          },
          onError: () => {
            finished = true;
          },
        },
      );
      await until(() => (finished ? true : null));
      return seen;
    };

    const declined = await chat('run-decline', false);
    expect(declined.filter((event) => event.type === 'confirm' && event.tool === 'intent.start')).toHaveLength(1);
    expect(w.intents.get(id)?.intent.status).toBe('draft');

    const approved = await chat('run-approve', true);
    expect(approved.filter((event) => event.type === 'confirm' && event.tool === 'intent.start')).toHaveLength(1);
    await executorOf(w).idle();
    expect(w.intents.get(id)?.intent.startedAt).not.toBeNull();

    const tools = intentTools({ layout: w.root, gate: w.gate, intents: w.intents, logger: quiet, executor: executorOf(w) });
    const builder = await refusal(
      tools.tools['intent.start']?.execute({ intentId: id }, chatEnvelope('intent-1-0001-only-part-a1'), new AbortController().signal) ??
        Promise.resolve(),
    );
    expect(builder).toEqual({ code: 'conflict', message: `intent.start: ${BUILDER_MAY_NOT_PLAN}` });
  }, 120_000);

  // 12.
  test('start refuses a draft never submitted, one with open questions, and a second run while one is active', async () => {
    const w = await world([editEmpty('Held open')]);
    const executor = executorOf(w);

    const unsubmitted = w.intents.createIntent({ appId: 'items', request: 'r' });
    w.intents.addTask(unsubmitted.id, plan('first-part'), { deferReferences: true });
    expect((await refusal(executor.start(unsubmitted.id, 'the test'))).message).toContain('still being written');

    const { id: asking } = submitted(w.intents, [plan('asked-part')]);
    w.intents.db.query<null, [number]>(`UPDATE intents SET questions = '["Which tag?"]' WHERE id = ?`).run(asking);
    expect((await refusal(executor.start(asking, 'the test'))).message).toContain('open questions');

    const { id } = submitted(w.intents, [plan('only-part')]);
    await executor.start(id, 'the test');
    await until(() => executor.progress(id).question);
    const { id: another } = submitted(w.intents, [plan('another-part')], 'items');
    expect((await refusal(executor.start(another, 'the test'))).message).toContain('already working on items');
    executor.stop(id, 'the test');
    await executor.idle();
  }, 60_000);
});

// ── 13d. Fix-ups to the run ─────────────────────────────────────────────────

describe('13d: holding a run to its earlier examples, and letting progress earn a turn', () => {
  const three = plan('three-part', {
    criteria: [
      { text: 'items.list returns the items', failure: false },
      { text: 'An empty list reads as empty, never as an error', failure: true },
      { text: 'items.list returns a count', failure: false },
    ],
  });
  const reasonsOf = (w: World, taskId: number): string[] => (w.intents.task(taskId)?.failure as { reasons: string[] } | null)?.reasons ?? [];

  // 2.
  test('a task that removes a finished task’s example is not completed, and the reason names it', async () => {
    const renamed = tool('candidate.cycle', {
      appId: 'items',
      message: 'take over the first part’s examples',
      hunks: [
        { path: 'autoapp.json', find: '"id": "0001-first-part-c1", "title": "0001-first-part c1"', replace: '"id": "0002-second-part-c1", "title": "0002-second-part c1"' },
        { path: 'autoapp.json', find: '"id": "0001-first-part-c2", "title": "0001-first-part c2"', replace: '"id": "0002-second-part-c2", "title": "0002-second-part c2"' },
      ],
    });
    const w = await world([cycle('0001-first-part'), renamed, text('not advice')], { maxAttempts: 1 });
    const { id, slugs } = submitted(w.intents, [plan('first-part'), plan('second-part', { blockedBy: ['first-part'] })]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();

    const [first, second] = w.intents.runOrder(id);
    expect(first?.stored).toBe('completed');
    expect(second?.stored).toBe('failed');
    // Its own examples ran and passed; the first task's are what is missing.
    expect(second?.criteria.map((criterion) => criterion.passed)).toEqual([true, true]);
    expect(reasonsOf(w, second?.id ?? 0)).toEqual([
      `The example ${slugs[0] ?? ''}-c1, from a finished task, is gone.`,
      `The example ${slugs[0] ?? ''}-c2, from a finished task, is gone.`,
    ]);
    // The builder was told not to.
    expect(prompts(w.fake).some((prompt) => prompt.includes('Do not remove or rename an acceptance example that is already there.'))).toBe(true);
  }, 240_000);

  // 3.
  test('a second attempt that only builds and checks what the first edited completes', async () => {
    const w = await world([editOnly('0001-only-part', ['c1', 'c2']), verify()]);
    const { id } = submitted(w.intents, [plan('only-part')]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const task = w.intents.runOrder(id)[0];
    expect(task?.stored).toBe('completed');
    expect(task?.attempts).toBe(2);
    // The second turn's own revision did not move; the task's did.
    expect(task?.revAfter).not.toBe(task?.revBefore);
    expect(w.intents.get(id)?.intent.status).toBe('done');
  }, 240_000);

  // 4.
  test('passing 0, then 2, then 3 of 3: the third attempt happens without a person and completes', async () => {
    const w = await world([text('nothing yet'), cycle('0001-three-part', ['c1', 'c2']), cycle('0001-three-part', ['c3'])]);
    const { id } = submitted(w.intents, [three]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const detail = w.intents.get(id);
    const task = detail?.tasks[0];
    expect(detail?.intent.status).toBe('done');
    expect(task?.stored).toBe('completed');
    expect(task?.runIds).toHaveLength(3);
    expect(task?.events.map((event) => event.note)).toContain('another attempt: it got further (2 of 3)');
  }, 240_000);

  test('passing 1, then 1: no progress, and the run stops after two', async () => {
    const w = await world([cycle('0001-three-part', ['c1']), verify(), text('not advice')]);
    const { id } = submitted(w.intents, [three]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const task = w.intents.runOrder(id)[0];
    expect(task?.stored).toBe('failed');
    expect(task?.runIds).toHaveLength(2);
    expect(w.intents.get(id)?.intent.stopReason).toBe(`${task?.slug ?? ''} failed after 2 attempts.`);
  }, 240_000);

  test('four turns is the ceiling, however much each one improves', async () => {
    const five = plan('five-part', {
      criteria: ['a', 'b', 'c', 'd', 'e'].map((letter) => ({ text: `items.list answers ${letter}`, failure: letter === 'e' })),
    });
    const w = await world([
      text('nothing yet'),
      cycle('0001-five-part', ['c1']),
      cycle('0001-five-part', ['c2']),
      cycle('0001-five-part', ['c3']),
      text('not advice'),
      cycle('0001-five-part', ['c4', 'c5']),
    ]);
    const { id } = submitted(w.intents, [five]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const task = w.intents.runOrder(id)[0];
    expect(task?.stored).toBe('failed');
    expect(task?.runIds).toHaveLength(4);
    expect(task?.criteria.map((criterion) => criterion.passed)).toEqual([true, true, true, false, false]);
    const events = w.intents.get(id)?.tasks[0]?.events ?? [];
    expect(events.filter((event) => event.note.startsWith('another attempt: it got further'))).toHaveLength(2);
  }, 300_000);

  // 5.
  test('a turn silent past the idle limit is ended with the idle sentence', async () => {
    const silent: FakeStep = { kind: 'text', chunks: Array.from({ length: 12 }, () => 'thinking ') };
    const w = await world([silent, text('not advice')], { maxAttempts: 1, idleTimeoutMs: 400, chunkDelayMs: 150 });
    const { id } = submitted(w.intents, [plan('only-part')]);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    await executor.idle();
    const task = w.intents.runOrder(id)[0];
    expect(task?.stored).toBe('failed');
    expect(reasonsOf(w, task?.id ?? 0)).toContain(idleSentence(400));
    expect(w.fake.aborted).toBeGreaterThan(0);
  }, 60_000);

  test('a turn waiting on a forwarded question is not ended by the idle limit', async () => {
    const w = await world([editEmpty('Answered late', [text('done')]), text('not advice')], {
      maxAttempts: 1,
      idleTimeoutMs: 400,
      confirmTimeoutMs: 10_000,
    });
    const { id } = submitted(w.intents, [plan('only-part')]);
    const client = await connect(w.tab);
    const executor = executorOf(w);
    await executor.start(id, 'the test');
    const question = await until(async () => (await client.call('launcher.intentGet', { id })).run?.question ?? null);
    await Bun.sleep(1_200);
    expect((await client.call('ai.chatConfirm', { runId: question.runId, callId: question.callId, approve: true })).accepted).toBe(true);
    await executor.idle();
    const task = w.intents.runOrder(id)[0];
    expect(readFileSync(join(w.root.app('empty').source, 'autoapp.json'), 'utf8')).toContain('"name": "Answered late"');
    expect(task?.stored).toBe('failed');
    expect(reasonsOf(w, task?.id ?? 0)).not.toContain(idleSentence(400));
  }, 60_000);
});

// ── 10. Restart ─────────────────────────────────────────────────────────────

describe('restart', () => {
  test('only a recovering open interrupts what was in progress and stops what was running; nothing starts', async () => {
    const w = await world([]);
    const { id } = submitted(w.intents, [plan('only-part')]);
    const task = w.intents.runOrder(id)[0];
    w.intents.moveTask(task?.id ?? 0, 'in-queue', 'queued');
    w.intents.setRun(id, 'running');
    w.intents.moveTask(task?.id ?? 0, 'in-progress', 'turn 1', 'intent-1-0001-only-part-a1');
    expect(w.intents.task(task?.id ?? 0)?.attempts).toBe(1);
    w.intents.close();

    // `serve <appId>` and the one-shot commands open the store without
    // recovering: a launcher beside them may be running this very backlog.
    const beside = openIntents(w.dataDir);
    expect(beside.get(id)?.intent.status).toBe('running');
    expect(beside.get(id)?.tasks[0]?.stored).toBe('in-progress');
    beside.close();

    const reopened = openIntents(w.dataDir, { recover: true });
    closers.push(() => reopened.close());
    const after = reopened.get(id);
    expect(after?.intent.status).toBe('stopped');
    expect(after?.intent.stopReason).toBe(LAUNCHER_STOPPED);
    expect(after?.tasks[0]?.stored).toBe('interrupted');
    expect(after?.tasks[0]?.attempts).toBe(0);
    expect(after?.tasks[0]?.events.at(-1)?.note).toBe('the launcher stopped');
    expect(executorOf(w).active()).toBeNull();
  });
});

describe('revising a failed task', () => {
  test('returns it to proposed with a new plan, and clears its failure and advice', async () => {
    const w = await world([]);
    const { id } = submitted(w.intents, [plan('only-part')]);
    const task = w.intents.runOrder(id)[0];
    const taskId = task?.id ?? 0;
    w.intents.moveTask(taskId, 'in-queue', 'queued');
    w.intents.setRun(id, 'running');
    w.intents.moveTask(taskId, 'in-progress', 'turn 1', 'intent-1-0001-only-part-a1');
    w.intents.moveTask(taskId, 'failed', 'two attempts');
    w.intents.setRun(id, 'stopped', 'failed');
    w.intents.setFailure(taskId, { reasons: ['r'], runIds: [], at: 1 });
    w.intents.setAdvice(taskId, { diagnosis: 'd', advice: 'revise', note: 'n', at: 1 });
    const revised = w.intents.replaceTask(taskId, plan('only-part', { summary: 'A sharper plan for the same part of the request.' }));
    expect(revised.stored).toBe('proposed');
    expect(revised.summary).toBe('A sharper plan for the same part of the request.');
    expect(revised.failure).toBeNull();
    expect(revised.advice).toBeNull();
  });
});

// ── 13. The panel ───────────────────────────────────────────────────────────

describe('the Backlog panel', () => {
  test('a running intent shows the last tool; a failed task its reasons and advice; a done intent the closing sentence and the runbook', async () => {
    const w = await world([]);
    const { id } = submitted(w.intents, [plan('first-part', { runbook: ['Open the list and read it aloud.'] }), plan('second-part')]);
    const client = await connect(w.tab);
    const { intents } = await client.call('launcher.intentsList', { appId: 'items' });
    const opened = await client.call('launcher.intentGet', { id });
    const [first, second] = opened.tasks;
    if (first === undefined || second === undefined) throw new Error('two tasks');
    const draw = (detail: typeof opened): string =>
      renderToString(createElement(IntentPanel, { appId: 'items', onClose: () => undefined, snapshot: { intents, opened: detail } }));

    const running = draw({
      ...opened,
      intent: { ...opened.intent, status: 'running' },
      run: { taskId: first.id, attempt: 1, startedAt: Date.now(), lastTool: 'candidate.cycle', lastToolAt: Date.now(), approvals: 3, question: null },
      tasks: [{ ...first, stored: 'in-progress', status: 'in-progress' }, second],
    });
    expect(running).toContain('candidate.cycle');
    expect(running).toContain('Working, turn 1');

    const failed = draw({
      ...opened,
      intent: { ...opened.intent, status: 'stopped', stopReason: 'Two attempts failed.' },
      tasks: [
        {
          ...first,
          stored: 'failed',
          status: 'failed',
          failure: { reasons: ['No example named 0001-first-part-c2 was run.'], runIds: [], at: 1 },
          advice: { diagnosis: 'The second example was never written.', advice: 'retry', note: 'Run it again.', at: 1 },
        },
        second,
      ],
    });
    expect(failed).toContain('No example named 0001-first-part-c2 was run.');
    expect(failed).toContain('The second example was never written.');
    expect(failed).toContain(FAILED_NEXT);

    const done = draw({
      ...opened,
      intent: { ...opened.intent, status: 'done' },
      tasks: [
        { ...first, stored: 'completed', status: 'completed', actualLines: 12 },
        { ...second, stored: 'completed', status: 'completed', actualLines: 4 },
      ],
    });
    expect(done).toContain(RUN_DONE);
    expect(done).toContain(BY_HAND);
    expect(done).toContain('Open the list and read it aloud.');
    expect(done).toContain('Estimated 20 lines, changed 12.');
  }, 60_000);
});
