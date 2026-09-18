/**
 * A task's turn knows its task (14a): the backlog's `task_runs`, the attempts
 * document, the relationship index, and the three tiers a task's lessons are
 * chosen in.
 *
 * Serving is tested on `createServe` over real stores; the two cases that are
 * about a run — a retry and a resumed task — go through the executor and the
 * launcher's tab on the fake adapter, exactly as a backlog run does. Every
 * store is closed and every directory removed in `afterEach`.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createFakeAdapter, type ContextDocument, type FakeStep, type ProviderAdapter } from 'broapp/ai/host';
import { createGate } from 'broapp/host';
import type { HostLogger } from 'broapp/host';
import { createRunStore } from 'broapp-autoapp/host';
import { ENGINEER_INSTRUCTIONS, createCandidateStates } from 'broapp-autoapp/engineer';
import { builderMessage, NOT_AN_ATTEMPT, openIntents, type IntentStore, type TaskInput } from 'broapp-autoapp/intent';
import {
  ATTEMPTS_DOCUMENT_CHARS,
  attemptsDocument,
  createEventLog,
  createEvidence,
  createServe,
  fileKey,
  openKnowledge,
  rebuildLinks,
  recordContext,
  type AttemptRecord,
  type CreateServeInput,
  type EventLog,
  type Knowledge,
  type Serve,
} from 'broapp-autoapp/knowledge';
import { createLauncherTab, createSupervisor, listApps, openJournal, type LauncherTab } from 'broapp-autoapp/launcher';
import { layout, type Layout } from 'broapp-autoapp/spec';

import { openSession } from '../packages/broapp-autoapp/src/knowledge/session.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';

const quiet: HostLogger = { warn: () => undefined, error: () => undefined };
const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
/** Inside the repository, so a workspace can resolve `broapp` if it is ever built. */
const runRoot = join(import.meta.dir, '.autoapp-run');
const signal = new AbortController().signal;
const WHY = /^(application|backlog|attempts|pinned|words|related:.+)$/;

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

afterAll(() => {
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) rmSync(runRoot, { recursive: true, force: true });
});

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

/** A launcher root: `items` from the fixture in a repository of its own, and an empty `other`. */
function newRoot(): { directory: string; root: Layout } {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'task-context-'));
  scratch.push(directory);
  const root = layout(directory);
  const source = root.app('items').source;
  mkdirSync(root.app('items').dir, { recursive: true });
  cpSync(fixture, source, { recursive: true });
  git(source, 'init', '--quiet');
  git(source, 'add', '-A');
  git(source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'the fixture');
  mkdirSync(root.app('other').source, { recursive: true });
  return { directory, root };
}

/** A plan that passes the validator. */
function plan(words: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    title: `Build the ${words.replaceAll('-', ' ')} part`,
    words,
    priority: 'medium',
    labels: ['views'],
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

/** A submitted intent for `appId` with these tasks. */
function submitted(intents: IntentStore, tasks: readonly TaskInput[], appId = 'items'): { id: number; slugs: string[]; ids: number[] } {
  const intent = intents.createIntent({ appId, request: 'Do these things.' });
  intents.replaceAnalysis(intent.id, {
    restated: 'Do these things, one after another.',
    fits: 'Builds on items.list.',
    conflicts: [],
    outOfReach: [],
    assumptions: [],
    questions: [],
  });
  const added = tasks.map((task) => intents.addTask(intent.id, task, { deferReferences: true }));
  expect(intents.submit(intent.id)).toEqual([]);
  return { id: intent.id, slugs: added.map((task) => task.slug), ids: added.map((task) => task.id) };
}

/** Move a task into a run by hand, as the executor does. */
function startRun(intents: IntentStore, taskId: number, runId: string): void {
  const task = intents.task(taskId);
  if (task?.stored === 'proposed' || task?.stored === 'failed' || task?.stored === 'interrupted') {
    intents.moveTask(taskId, 'in-queue', 'queued by the test');
  }
  intents.moveTask(taskId, 'in-progress', 'turn by the test', runId);
}

/** One event, as a tool would have written it. */
function event(log: EventLog, kind: 'edit' | 'build' | 'check', data: Record<string, unknown>, runId: string, appId = 'items'): void {
  log.event(kind, `${kind} by the test`, data, { runId, appId });
}

/** A lesson row and its full-text row. */
function lesson(
  knowledge: Knowledge,
  fields: { summary: string; trigger?: string; status?: string; diagnosis?: string | null; episodeId?: number | null; scope?: string; stage?: string },
): number {
  const now = Date.now();
  const id = Number(
    knowledge.db
      .query<null, [string, number | null, string | null, string, string, string, string, number, number]>(
        `INSERT INTO lessons (version, status, origin, episode_id, supersedes, diagnosis, scope, applies, summary, detail, trigger,
           instructions_hash, autoapp_version, created_at, updated_at)
         VALUES (1, ?, 'distilled', ?, NULL, ?, ?, ?, ?, '', ?, 'test', 'test', ?, ?)`,
      )
      .run(
        fields.status ?? 'confirmed',
        fields.episodeId ?? null,
        fields.diagnosis ?? null,
        fields.scope ?? 'global',
        JSON.stringify(fields.stage === undefined ? {} : { stage: fields.stage }),
        fields.summary,
        fields.trigger ?? '',
        now,
        now,
      ).lastInsertRowid,
  );
  knowledge.db.query<null, [number, string, string]>('INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)').run(
    id,
    fields.summary,
    fields.trigger ?? '',
  );
  return id;
}

/** A case opened in one run and resolved in another. */
function episode(knowledge: Knowledge, fields: { appId?: string; openedIn: string; resolvedIn: string | null; openedAt: number; resolvedAt: number | null }): number {
  return Number(
    knowledge.db
      .query<null, [string, string, number, string | null, number | null]>(
        `INSERT INTO episodes (app_id, stage, signature, problem, request_blob, run_id, call_id, source_rev_before, autoapp_version, opened_at,
           resolved_run_id, resolved_at)
         VALUES (?, 'views', 'sig', 'a problem', 'blob', ?, 'call-1', 'rev', 'test', ?, ?, ?)`,
      )
      .run(fields.appId ?? 'items', fields.openedIn, fields.openedAt, fields.resolvedIn, fields.resolvedAt).lastInsertRowid,
  );
}

// ── Stores and a serving over them ──────────────────────────────────────────

interface Stores {
  readonly root: Layout;
  readonly directory: string;
  readonly dataDir: string;
  readonly knowledge: Knowledge;
  readonly intents: IntentStore;
  readonly log: EventLog;
  serve(options?: Pick<CreateServeInput, 'corpus' | 'documents' | 'seed'>): Serve;
}

function stores(where = newRoot()): Stores {
  const dataDir = join(where.directory, 'launcher');
  const knowledge = openKnowledge(dataDir);
  const intents = openIntents(dataDir);
  const log = createEventLog(knowledge, { source: 'launcher', tee: quiet });
  const journal = openJournal(where.root.journal);
  const supervisor = createSupervisor({ logger: quiet });
  const states = createCandidateStates(where.root, quiet);
  const session = openSession(dataDir, quiet);
  closers.push(
    () => supervisor.stopAll(5_000),
    () => journal.close(),
    () => intents.close(),
    () => knowledge.close(),
  );
  return {
    ...where,
    dataDir,
    knowledge,
    intents,
    log,
    serve: (options = {}) =>
      createServe({
        knowledge,
        log,
        layout: where.root,
        states,
        session,
        instructions: ENGINEER_INSTRUCTIONS,
        apps: () => listApps(where.root, supervisor, journal),
        intents,
        ...options,
      }),
  };
}

/** Search, resolve and deliver one turn, as the AI layer does; what was offered and delivered. */
async function turn(serve: Serve, runId: string, text: string): Promise<{ offered: string[]; documents: ContextDocument[]; appId: string | null }> {
  const refs = await serve.search({ text, limit: 8, runId }, signal);
  const documents = await serve.resolve(
    refs.map((ref) => ref.ref),
    signal,
  );
  const served = serve.delivered(runId, { system: 'system', documents, message: text, model: { provider: 'fake', id: 'fake-1' } });
  return { offered: refs.map((ref) => ref.ref), documents, appId: served.appId };
}

/** The last `search` event's data. */
function lastSearch(knowledge: Knowledge): { included: string[]; why: { ref: string; reason: string }[] } {
  const row = knowledge.db
    .query<{ data: string | null }, []>("SELECT data FROM events WHERE kind = 'search' ORDER BY id DESC LIMIT 1")
    .get();
  return JSON.parse(row?.data ?? '{}') as { included: string[]; why: { ref: string; reason: string }[] };
}

// ── 1. task_runs ────────────────────────────────────────────────────────────

describe('task_runs', () => {
  test('the migration backfills it from run_ids by position; a move adds one row; an unknown run is null; a run id twice is refused', () => {
    const where = newRoot();
    const dataDir = join(where.directory, 'launcher');
    const first = openIntents(dataDir);
    const { ids } = submitted(first, [plan('only-part')]);
    const taskId = ids[0] ?? 0;
    startRun(first, taskId, 'run-one');
    first.moveTask(taskId, 'failed', 'attempt 1: The example failed.', 'run-one');
    startRun(first, taskId, 'run-two');
    first.moveTask(taskId, 'interrupted', 'stopped by the test');
    first.close();

    // As a store written before 14a: no `task_runs`, and `user_version` 1.
    const raw = new Database(join(dataDir, 'intents.sqlite'));
    const starts = raw
      .query<{ at: number }, []>("SELECT at FROM task_events WHERE to_status = 'in-progress' ORDER BY id")
      .all()
      .map((row) => row.at);
    raw.exec('DROP TABLE task_runs');
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    const intents = openIntents(dataDir);
    closers.push(() => intents.close());
    expect(intents.runsOf(taskId)).toEqual([
      { runId: 'run-one', attempt: 1, at: starts[0] ?? -1 },
      { runId: 'run-two', attempt: 2, at: starts[1] ?? -1 },
    ]);
    expect(intents.taskForRun('run-two')?.id).toBe(taskId);
    expect(intents.taskForRun('intent-1-0001-only-part-a2')).toBeNull();

    startRun(intents, taskId, 'run-three');
    expect(intents.runsOf(taskId).map((run) => [run.runId, run.attempt])).toEqual([
      ['run-one', 1],
      ['run-two', 2],
      ['run-three', 3],
    ]);
    intents.moveTask(taskId, 'interrupted', 'stopped by the test');
    intents.moveTask(taskId, 'in-queue', 'again');
    expect(() => intents.moveTask(taskId, 'in-progress', 'the same run again', 'run-three')).toThrow();
    // The refusal took the move back with it.
    expect(intents.task(taskId)?.stored).toBe('in-queue');
    expect(intents.runsOf(taskId)).toHaveLength(3);

    expect(intents.attemptNotes(taskId).map((row) => [row.attempt, row.to, row.notAnAttempt])).toEqual([
      [1, 'failed', false],
      [2, 'interrupted', false],
      [3, 'interrupted', false],
    ]);
  });
});

// ── 2. A spoke turn's application ───────────────────────────────────────────

describe('a builder’s turn is found by its run id', () => {
  test('without an Application line it still gets its application’s documents, and its context names it; a chat turn is resolved as before', async () => {
    const s = stores();
    const { ids } = submitted(s.intents, [plan('only-part')]);
    startRun(s.intents, ids[0] ?? 0, 'intent-1-0001-only-part-a1');
    const serve = s.serve();
    // Names `other` and never `items`: chosen by words, this would be `other`.
    const text = 'Build this one task and nothing else, as other tasks were built.';

    const spoke = await turn(serve, 'intent-1-0001-only-part-a1', text);
    expect(spoke.offered.slice(0, 1)).toEqual(['digest:items']);
    expect(spoke.appId).toBe('items');
    const contextId = recordContext(s.knowledge, {
      runId: 'intent-1-0001-only-part-a1',
      appId: spoke.appId,
      instructions: ENGINEER_INSTRUCTIONS,
      delivered: { system: 'system', documents: spoke.documents, message: text, model: { provider: 'fake', id: 'fake-1' } },
      requested: spoke.offered,
      resolved: spoke.offered,
    });
    expect(s.knowledge.db.query<{ app_id: string }, [number]>('SELECT app_id FROM contexts WHERE id = ?').get(contextId)?.app_id).toBe('items');

    const chat = await turn(serve, 'chat-1', text);
    expect(chat.appId).toBe('other');
    expect(chat.offered[0]).toBe('digest:other');
  }, 60_000);
});

// ── 3. The attempts document ────────────────────────────────────────────────

describe('attemptsDocument', () => {
  const failed = (attempt: number, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
    attempt,
    ended: { to: 'failed', note: `attempt ${String(attempt)}: Nothing was built. The example 0001-x-c1 failed.` },
    edited: ['src/shared/views.ts'],
    lastBuild: [{ stage: 'views', message: 'views: the table "notes-table" names a column nobody returns' }],
    lastCheck: [],
    ...over,
  });

  test('no earlier attempt gives nothing', () => {
    expect(attemptsDocument({ attempts: [], diagnosis: 'x' })).toBeNull();
  });

  test('two attempts, oldest first, with what came back and the diagnosis but never the note', () => {
    const text = attemptsDocument({
      attempts: [failed(2, { edited: ['autoapp.json'] }), failed(1)],
      diagnosis: 'The column was never added to the contract.',
    });
    expect(text).not.toBeNull();
    const lines = (text ?? '').split('\n');
    expect(lines.indexOf('Attempt 1')).toBeLessThan(lines.indexOf('Attempt 2'));
    expect(text).toContain('Changed: src/shared/views.ts');
    expect(text).toContain('Changed: autoapp.json');
    expect(text).toContain('Ended with:\n- Nothing was built.\n- The example 0001-x-c1 failed.');
    expect(text).toContain('Still wrong at the end:\n- views: views: the table "notes-table" names a column nobody returns');
    expect(text).toContain('Came back:\n- views: views: the table "notes-table" names a column nobody returns (attempts 1 and 2)');
    expect(text).toContain('How the planning model read it: The column was never added to the contract.');
    expect(text).not.toContain('advice');
  });

  test('a cut list of reasons keeps how the turn ended', () => {
    const note = `attempt 1: The workspace did not change. Nothing was built. ${['c1', 'c2', 'c3', 'c4'].map((id) => `No example named x-${id} was run.`).join(' ')} The turn made no tool call for 8 minutes.`;
    const text = attemptsDocument({ attempts: [failed(1, { ended: { to: 'failed', note } })], diagnosis: null }) ?? '';
    expect(text).toContain('Ended with:\n- The turn made no tool call for 8 minutes.\n- The workspace did not change.\n- Nothing was built.\n- and 4 more');
  });

  test('more than eight paths names eight and counts the rest', () => {
    const edited = Array.from({ length: 11 }, (_, index) => `src/file-${String(index)}.ts`);
    const text = attemptsDocument({ attempts: [failed(1, { edited })], diagnosis: null }) ?? '';
    expect(text).toContain('src/file-7.ts and 3 more');
    expect(text).not.toContain('src/file-8.ts');
  });

  test('over the budget it cuts at a line and keeps the newest attempt whole', () => {
    const long = (n: number): AttemptRecord =>
      failed(n, {
        edited: Array.from({ length: 8 }, (_, index) => `src/a-rather-long-directory-name/number-${String(n)}-${String(index)}.ts`),
        lastBuild: [1, 2, 3].map((k) => ({ stage: 'views', message: `problem ${String(n)}.${String(k)} ${'x'.repeat(140)}` })),
      });
    const attempts = [1, 2, 3, 4, 5].map(long);
    const text = attemptsDocument({ attempts, diagnosis: 'Short.' }) ?? '';
    expect(text.length).toBeLessThanOrEqual(ATTEMPTS_DOCUMENT_CHARS);
    expect(text).toContain('…');
    const newest = attemptsDocument({ attempts: [long(5)], diagnosis: null }) ?? '';
    expect(text).toContain(newest);
    // Cut at a line: every line is a whole line of one attempt's block, or the mark.
    const whole = attempts.flatMap((record) => (attemptsDocument({ attempts: [record], diagnosis: null }) ?? '').split('\n'));
    for (const line of text.split('\n')) {
      if (line === '…' || line.startsWith('How the planning') || line === 'Came back:' || line.startsWith('- views: problem')) continue;
      expect(whole).toContain(line);
    }
  });

  test('an interrupted attempt lists only what it changed; a move that was not an attempt is left out entirely', () => {
    const text =
      attemptsDocument({
        attempts: [
          failed(1),
          { attempt: 2, ended: { to: 'interrupted', note: 'stopped by the person' }, edited: ['src/host/app.ts'], lastBuild: [{ stage: 'host', message: 'x' }], lastCheck: [] },
          { attempt: 3, ended: { to: 'interrupted', note: `${NOT_AN_ATTEMPT}the AI provider failed: The AI provider returned an error.` }, edited: [], lastBuild: [], lastCheck: [] },
        ],
        diagnosis: null,
      }) ?? '';
    expect(text).toContain('Attempt 2 (stopped before it finished)\nChanged: src/host/app.ts');
    expect(text.split('Attempt 2')[1]).not.toContain('Ended with');
    expect(text.split('Attempt 2')[1]).not.toContain('Still wrong');
    expect(text).not.toContain('Attempt 3');
    expect(text).not.toContain('provider');
    expect(
      attemptsDocument({
        attempts: [{ attempt: 1, ended: { to: 'interrupted', note: `${NOT_AN_ATTEMPT}the turn ended before the model did anything` }, edited: [], lastBuild: [], lastCheck: [] }],
        diagnosis: 'x',
      }),
    ).toBeNull();
  });

  test('a machine path in a build message is sanitised', () => {
    const home = process.env['HOME'] ?? '/Users/somebody';
    const text =
      attemptsDocument({
        attempts: [failed(1, { lastBuild: [{ stage: 'host', message: `Could not resolve ${home}/works/app/src/host/db.ts token=abcdef123456` }] })],
        diagnosis: null,
      }) ?? '';
    expect(text).not.toContain(home);
    expect(text).toContain('~/works/app/src/host/db.ts');
    expect(text).not.toContain('abcdef123456');
  });
});

// ── 4 and 5. Through the executor ──────────────────────────────────────────

interface World {
  readonly root: Layout;
  readonly intents: IntentStore;
  readonly knowledge: Knowledge;
  readonly tab: LauncherTab;
  readonly prompts: () => string[];
  close(): Promise<void>;
}

/** The launcher's tab over a root, with a fake model; `failFrom` makes the provider refuse from that call on. */
async function world(directory: string, script: readonly FakeStep[], options: { maxAttempts?: number; failFrom?: number } = {}): Promise<World> {
  const root = layout(directory);
  const dataDir = join(directory, 'launcher');
  const intents = openIntents(dataDir, { recover: true });
  const knowledge = openKnowledge(dataDir);
  const log = createEventLog(knowledge, { source: 'launcher', tee: quiet });
  const runs = createRunStore(dataDir, quiet);
  const journal = openJournal(root.journal);
  const supervisor = createSupervisor({ logger: quiet });
  const gate = createGate({ appId: 'launcher', releaseId: 'launcher', confirmTimeoutMs: 5_000, recorder: runs.recorder(), logger: quiet });
  const fake = createFakeAdapter({ script });
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
            if (calls > failFrom) return Promise.reject(new Error('the provider is out of credit'));
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
    confirmTimeoutMs: 5_000,
    run: { turnTimeoutMs: 60_000, ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }) },
  });
  await tab.ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    tab.executor?.stopAll('the test');
    await tab.executor?.idle();
    await supervisor.stopAll(5_000);
    journal.close();
    runs.close();
    tab.ai.close();
    intents.close();
    knowledge.close();
  };
  closers.push(close);
  return { root, intents, knowledge, tab, prompts: () => fake.calls.map((call) => JSON.stringify(call)), close };
}

function text(words: string): FakeStep {
  return { kind: 'text', chunks: [words] };
}

/** Add one example per criterion with `source.edit`, and build nothing: the verdict fails. */
function editOnly(slug: string, then: readonly FakeStep[] = [text('done')]): FakeStep {
  return {
    kind: 'tool',
    name: 'source.edit',
    input: {
      appId: 'items',
      message: `examples for ${slug}`,
      hunks: [
        {
          path: 'autoapp.json',
          find: '"acceptance": [',
          replace: `"acceptance": [\n    { "id": "${slug}-c1", "title": "${slug} c1", "steps": [{ "route": "items.list", "input": null }] },`,
        },
      ],
    },
    then,
  };
}

/** The refs a turn's context row says were delivered, in order, and the attempts document if any. */
function delivered(knowledge: Knowledge, runId: string): { refs: string[]; attempts: string | null; appId: string | null } {
  const row = knowledge.db
    .query<{ included: string; app_id: string | null }, [string]>('SELECT included, app_id FROM contexts WHERE run_id = ?')
    .get(runId);
  const included = JSON.parse(row?.included ?? '[]') as { ref: string; blob: string }[];
  const attempts = included.find((entry) => entry.ref.startsWith('attempts:'));
  return {
    refs: included.map((entry) => entry.ref),
    attempts: attempts === undefined ? null : knowledge.getBlob(attempts.blob),
    appId: row?.app_id ?? null,
  };
}

describe('a retry is told what the attempts before it did', () => {
  // 4.
  test('attempt 2 is given the attempts document, second, naming the file attempt 1 edited; attempt 1 is not', async () => {
    const { directory } = newRoot();
    const w = await world(directory, [editOnly('0001-only-part'), text('nothing this time'), text('not advice')]);
    const { id, slugs } = submitted(w.intents, [plan('only-part')]);
    const slug = slugs[0] ?? '';
    await w.tab.executor?.start(id, 'the test');
    await w.tab.executor?.idle();
    const task = w.intents.runOrder(id)[0];
    expect(task?.stored).toBe('failed');
    expect(task?.runIds).toHaveLength(2);

    const first = delivered(w.knowledge, `intent-${String(id)}-${slug}-a1`);
    const second = delivered(w.knowledge, `intent-${String(id)}-${slug}-a2`);
    expect(first.refs.some((ref) => ref.startsWith('attempts:'))).toBe(false);
    expect(first.appId).toBe('items');
    expect(second.refs[1]).toBe('attempts:items');
    expect(second.attempts).toContain('Attempt 1');
    expect(second.attempts).toContain('Changed: autoapp.json');
    expect(second.attempts).toContain('Ended with:');
    expect(second.appId).toBe('items');
  }, 120_000);

  // 5.
  test('a task resumed after a restart is told its last attempt, and what was not an attempt is left out', async () => {
    const { directory } = newRoot();
    // Attempt 1 edits and fails; the run stops on it.
    const a = await world(directory, [editOnly('0001-only-part'), text('not advice')], { maxAttempts: 1 });
    const { id, slugs } = submitted(a.intents, [plan('only-part')]);
    const slug = slugs[0] ?? '';
    await a.tab.executor?.start(id, 'the test');
    await a.tab.executor?.idle();
    expect(a.intents.runOrder(id)[0]?.stored).toBe('failed');
    await a.close();

    // A restarted launcher; the provider fails on attempt 2, which is not an attempt.
    const b = await world(directory, [], { failFrom: 0 });
    await b.tab.executor?.start(id, 'the test');
    await b.tab.executor?.idle();
    const interrupted = b.intents.attemptNotes(b.intents.runOrder(id)[0]?.id ?? 0).at(-1);
    expect(interrupted?.notAnAttempt).toBe(true);
    await b.close();

    // Restarted again: attempt 3 is told how attempt 1 ended, and only attempt 1.
    const c = await world(directory, [text('nothing'), text('not advice')], { maxAttempts: 1 });
    await c.tab.executor?.start(id, 'the test');
    await c.tab.executor?.idle();
    const message = c.prompts()[0] ?? '';
    expect(message).toContain('The last attempt ended with:');
    expect(message).toContain('Nothing was built.');
    expect(message).not.toContain('provider');
    const third = delivered(c.knowledge, `intent-${String(id)}-${slug}-a3`);
    expect(third.refs[1]).toBe('attempts:items');
    expect(third.attempts).toContain('Attempt 1');
    expect(third.attempts).not.toContain('Attempt 2');
    expect(builderMessage(c.intents.runOrder(id)[0] ?? ({} as never)).includes('The last attempt ended with:')).toBe(false);
  }, 180_000);
});

// ── 6 and 7. The index ─────────────────────────────────────────────────────

describe('fileKey', () => {
  test('one key for the spellings of one path; none for a path outside the workspace', () => {
    const { root } = newRoot();
    expect(fileKey(root, 'items', './src/a.ts')).toBe('src/a.ts');
    expect(fileKey(root, 'items', 'src\\a.ts')).toBe('src/a.ts');
    expect(fileKey(root, 'items', 'src/a.ts')).toBe('src/a.ts');
    expect(fileKey(root, 'items', 'src/b/../a.ts')).toBe('src/a.ts');
    expect(fileKey(root, 'items', join(root.app('items').source, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(fileKey(root, 'items', '/etc/passwd')).toBeNull();
    expect(fileKey(root, 'items', '../other/src/a.ts')).toBeNull();
    expect(fileKey(root, 'items', 'src/../../a.ts')).toBeNull();
    expect(fileKey(root, 'items', '')).toBeNull();
  });

  test('the same path under two applications gives rows that never join', () => {
    const s = stores();
    const mine = submitted(s.intents, [plan('only-part')]);
    const theirs = submitted(s.intents, [plan('only-part')], 'other');
    startRun(s.intents, mine.ids[0] ?? 0, 'run-items');
    startRun(s.intents, theirs.ids[0] ?? 0, 'run-other');
    event(s.log, 'edit', { paths: ['src/host/routes.ts'] }, 'run-items', 'items');
    event(s.log, 'edit', { paths: ['./src/host/routes.ts'] }, 'run-other', 'other');
    rebuildLinks({ knowledge: s.knowledge, intents: s.intents, layout: s.root, apps: ['items', 'other'] });
    const rows = s.knowledge.db
      .query<{ app_id: string; src_id: string }, []>(
        "SELECT app_id, src_id FROM links WHERE rel = 'edited' AND src_kind = 'task' AND dst_id = 'src/host/routes.ts' ORDER BY app_id",
      )
      .all();
    expect(rows).toEqual([
      { app_id: 'items', src_id: mine.slugs[0] ?? '' },
      { app_id: 'other', src_id: theirs.slugs[0] ?? '' },
    ]);
    // Every lookup names the application, so the `items` task's file never
    // reaches the run that edited `other`'s file of the same name.
    const joined = s.knowledge.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM links a
           JOIN links b ON b.app_id = a.app_id AND b.dst_kind = 'file' AND b.dst_id = a.dst_id
          WHERE a.app_id = 'items' AND a.src_kind = 'task' AND a.src_id = ? AND a.dst_kind = 'file' AND b.src_id = 'run-other'`,
      )
      .get(mine.slugs[0] ?? '')?.n;
    expect(joined).toBe(0);
  });
});

describe('rebuildLinks', () => {
  test('each relation has exactly its rows, each naming a row that exists; twice is the same table; a drop loses nothing', () => {
    const s = stores();
    const { ids, slugs } = submitted(s.intents, [plan('only-part', { locks: ['src/host/db.ts', 'the routes file'] })]);
    const taskId = ids[0] ?? 0;
    const slug = slugs[0] ?? '';
    const t0 = Date.now();
    startRun(s.intents, taskId, 'run-a1');
    event(s.log, 'edit', { paths: ['src/shared/contract.ts'] }, 'run-a1');
    s.intents.moveTask(taskId, 'failed', 'attempt 1: Nothing was built.', 'run-a1');
    startRun(s.intents, taskId, 'run-a2');
    event(s.log, 'edit', { paths: ['./src/shared/contract.ts', 'autoapp.json'] }, 'run-a2');
    const caseId = episode(s.knowledge, { openedIn: 'run-a1', resolvedIn: 'run-a2', openedAt: t0 - 1_000, resolvedAt: Date.now() + 1_000 });
    const lessonId = lesson(s.knowledge, { summary: 'A lesson from the case', episodeId: caseId, status: 'provisional' });
    s.knowledge.db
      .query<null, [number]>("INSERT INTO servings (lesson_id, run_id, app_id, how, included, served_at) VALUES (?, 'run-a2', 'items', 'turn', 1, 0)")
      .run(lessonId);
    s.knowledge.db
      .query<null, [number]>("INSERT INTO servings (lesson_id, run_id, app_id, how, included, served_at) VALUES (?, 'run-a1', 'items', 'turn', 0, 0)")
      .run(lessonId);

    const result = rebuildLinks({ knowledge: s.knowledge, intents: s.intents, layout: s.root, apps: ['items', 'other'], now: 1 });
    const read = (): string[] =>
      s.knowledge.db
        .query<{ row: string }, []>(
          "SELECT app_id || ' ' || src_kind || ':' || src_id || ' ' || rel || ' ' || dst_kind || ':' || dst_id AS row FROM links ORDER BY row",
        )
        .all()
        .map((row) => row.row);
    const expected = [
      `items case:${String(caseId)} edited file:autoapp.json`,
      `items case:${String(caseId)} edited file:src/shared/contract.ts`,
      `items case:${String(caseId)} opened_in run:run-a1`,
      `items case:${String(caseId)} resolved_in run:run-a2`,
      `items lesson:${String(lessonId)} distilled_from case:${String(caseId)}`,
      `items lesson:${String(lessonId)} served_to run:run-a2`,
      'items run:run-a1 edited file:src/shared/contract.ts',
      'items run:run-a2 edited file:autoapp.json',
      'items run:run-a2 edited file:src/shared/contract.ts',
      `items task:${slug} edited file:autoapp.json`,
      `items task:${slug} edited file:src/shared/contract.ts`,
      `items task:${slug} planned file:src/host/db.ts`,
      `items task:${slug} ran_as run:run-a1`,
      `items task:${slug} ran_as run:run-a2`,
    ].sort();
    expect(read()).toEqual(expected);
    expect(result.rows['task ran_as run']).toBe(2);
    expect(result.rows['task edited file']).toBe(2);
    expect(result.rows['lesson served_to run']).toBe(1);
    expect(result.skippedLocks).toEqual([{ appId: 'items', slug, lock: 'the routes file' }]);

    // Every source names a row that exists, in the table it names.
    const sources = s.knowledge.db.query<{ source: string }, []>('SELECT DISTINCT source FROM links').all().map((row) => row.source);
    for (const source of sources) {
      const [table, id] = source.split(':') as [string, string];
      if (table === 'task_runs') {
        expect(s.intents.taskForRun(id)).not.toBeNull();
      } else if (table === 'tasks') {
        expect(s.intents.task(Number(id))).not.toBeNull();
      } else {
        expect(['events', 'episodes', 'lessons', 'servings']).toContain(table);
        expect(s.knowledge.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(Number(id))?.n).toBe(1);
      }
    }

    const full = (): unknown[] => s.knowledge.db.query('SELECT * FROM links ORDER BY id').all();
    const before = full();
    rebuildLinks({ knowledge: s.knowledge, intents: s.intents, layout: s.root, apps: ['items', 'other'], now: 1 });
    expect(full()).toEqual(before);
    s.knowledge.db.exec('DROP TABLE links');
    rebuildLinks({ knowledge: s.knowledge, intents: s.intents, layout: s.root, apps: ['items', 'other'], now: 1 });
    expect(full()).toEqual(before);
  });
});

// ── 8 to 11. A task's lessons, and why ─────────────────────────────────────

describe('a task’s lessons', () => {
  /** A task that edited `src/host/routes.ts` in attempt 1, now on attempt 2; lessons from cases that edited it too. */
  function related(s: Stores, appId = 'items'): { slug: string; runId: string } {
    const { ids, slugs } = submitted(s.intents, [plan('priority-column', { title: 'Show the priority of each item', summary: 'A priority badge beside every item in the list, set when the item is added.' })], appId);
    const taskId = ids[0] ?? 0;
    startRun(s.intents, taskId, `r-${appId}-a1`);
    event(s.log, 'edit', { paths: ['src/host/routes.ts'] }, `r-${appId}-a1`, appId);
    s.intents.moveTask(taskId, 'failed', 'attempt 1: The example failed.', `r-${appId}-a1`);
    startRun(s.intents, taskId, `r-${appId}-a2`);
    return { slug: slugs[0] ?? '', runId: `r-${appId}-a2` };
  }

  /** A lesson distilled from a case in `items` whose window edited `path`. */
  function fromCase(s: Stores, path: string, fields: Parameters<typeof lesson>[1]): number {
    const at = Date.now();
    event(s.log, 'edit', { paths: [path] }, `case-run-${String(at)}-${fields.summary.length}`);
    const caseId = episode(s.knowledge, { openedIn: 'case-run', resolvedIn: 'case-run-2', openedAt: at - 5, resolvedAt: Date.now() + 5 });
    return lesson(s.knowledge, { ...fields, episodeId: caseId });
  }

  // 8.
  test('tier 2 serves at most two lessons that share a file, never across applications, never method_unclear or retired, and not when switched off', async () => {
    const s = stores();
    const good = fromCase(s, 'src/host/routes.ts', { summary: 'Quartz zebra lanterns hum' });
    const second = fromCase(s, 'src/host/routes.ts', { summary: 'Velvet anchors drift slowly', status: 'provisional' });
    const third = fromCase(s, 'src/host/routes.ts', { summary: 'Copper kites whistle north' });
    const unclear = fromCase(s, 'src/host/routes.ts', { summary: 'Marble owls count stars', diagnosis: 'method_unclear' });
    const retired = fromCase(s, 'src/host/routes.ts', { summary: 'Paper moons fold twice', status: 'retired' });
    const task = related(s);
    rebuildLinks({ knowledge: s.knowledge, intents: s.intents, layout: s.root, apps: ['items', 'other'] });

    const serve = s.serve({ seed: false });
    const served = await turn(serve, task.runId, 'Build this one task and nothing else.');
    const lessons = served.offered.filter((ref) => ref.startsWith('lesson:'));
    expect(lessons).toHaveLength(2);
    // Confirmed before provisional, then newest.
    expect(lessons).toEqual([`lesson:${String(third)}`, `lesson:${String(good)}`]);
    for (const id of [second, unclear, retired]) expect(lessons).not.toContain(`lesson:${String(id)}`);
    const why = lastSearch(s.knowledge).why.filter((entry) => entry.ref.startsWith('lesson:'));
    expect(why.map((entry) => entry.reason)).toEqual(['related:src/host/routes.ts', 'related:src/host/routes.ts']);

    const off = await turn(s.serve({ seed: false, corpus: { related: false } }), task.runId, 'Build this one task and nothing else.');
    expect(off.offered.filter((ref) => ref.startsWith('lesson:'))).toEqual([]);

    // The same file, edited by a task in another application: nothing.
    const elsewhere = related(s, 'other');
    rebuildLinks({ knowledge: s.knowledge, intents: s.intents, layout: s.root, apps: ['items', 'other'] });
    const theirs = await turn(s.serve({ seed: false }), elsewhere.runId, 'Build this one task and nothing else.');
    expect(theirs.offered.filter((ref) => ref.startsWith('lesson:'))).toEqual([]);
  }, 60_000);

  // 9.
  test('tier 3 is matched on the task’s own words, never the builder’s fixed sentences', async () => {
    const s = stores();
    const boiler = lesson(s.knowledge, { summary: 'Every acceptance criterion in a backlog needs its own example', stage: 'check' });
    const own = lesson(s.knowledge, { summary: 'A priority badge needs a priority column in the list query', stage: 'views' });
    const { ids } = submitted(s.intents, [plan('priority-column', { title: 'Show the priority of each item', summary: 'A priority badge beside every item in the list, set when the item is added.', criteria: [{ text: 'items.list returns a priority for each item', failure: false }, { text: 'An item with no priority shows none, never an error', failure: true }] })]);
    const task = s.intents.task(ids[0] ?? 0);
    if (task === null) throw new Error('no task');
    startRun(s.intents, task.id, 'r-words-a1');
    const message = builderMessage(task);
    expect(message).toContain('acceptance');
    expect(message).toContain('criterion');
    expect(message).toContain('backlog');

    const spoke = await turn(s.serve({ seed: false }), 'r-words-a1', message);
    expect(spoke.offered).toContain(`lesson:${String(own)}`);
    expect(spoke.offered).not.toContain(`lesson:${String(boiler)}`);
    expect(lastSearch(s.knowledge).why.find((entry) => entry.ref === `lesson:${String(own)}`)?.reason).toBe('words');

    // The same words from a chat turn match as they always did.
    const chat = await turn(s.serve({ seed: false }), 'chat-words', `In items: ${message}`);
    expect(chat.offered).toContain(`lesson:${String(boiler)}`);
  }, 60_000);

  // 10.
  test('a turn with no task is served exactly as before this prompt', async () => {
    const s = stores();
    s.intents.createIntent({ appId: 'items', request: 'Something to keep the backlog document out of it.' });
    const served = await turn(s.serve(), 'run-served1', 'add a button that goes back to the list page in items');
    expect(served.offered).toEqual([...PRE_14A_REFS]);
  }, 60_000);

  // 11.
  test('the search event says why each delivered document was there', async () => {
    const s = stores();
    const good = fromCase(s, 'src/host/routes.ts', { summary: 'Quartz zebra lanterns hum' });
    const task = related(s);
    rebuildLinks({ knowledge: s.knowledge, intents: s.intents, layout: s.root, apps: ['items', 'other'] });
    const served = await turn(s.serve(), task.runId, 'Build this one task and nothing else: priority badge beside every item.');
    const search = lastSearch(s.knowledge);
    const documents = search.included.filter((ref) => !ref.startsWith('lessons:'));
    const lessonRefs = served.offered.filter((ref) => ref.startsWith('lesson:'));
    expect(search.why.map((entry) => entry.ref)).toEqual([...documents, ...lessonRefs]);
    for (const entry of search.why) expect(entry.reason).toMatch(WHY);
    expect(search.why.find((entry) => entry.ref === 'digest:items')?.reason).toBe('application');
    expect(search.why.find((entry) => entry.ref === 'attempts:items')?.reason).toBe('attempts');
    expect(search.why.find((entry) => entry.ref === 'intent:items')?.reason).toBe('backlog');
    expect(search.why.find((entry) => entry.ref === `lesson:${String(good)}`)?.reason).toBe('related:src/host/routes.ts');
  }, 60_000);
});

/**
 * What a turn with no task was offered before 14a, for the message in test 10
 * over a fresh store with the curated seeds: read from the code at the commit
 * before this prompt (see the report), and held here.
 */
const PRE_14A_REFS: readonly string[] = ['digest:items', 'intent:items', 'evidence:items', 'lesson:1'];

