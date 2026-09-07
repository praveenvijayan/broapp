/**
 * The run store: what was recorded, and what happens to what was not.
 *
 * The property under test that matters most is the one about *not knowing*. A
 * step that was allowed and never recorded an outcome may have reached the
 * outside world. Calling that a failure would be a lie, and replaying it would
 * be worse, so it becomes `unknown` and nothing will replay it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { argumentsHash, createGate, createPendingApprovals } from 'broapp/host';
import type { Envelope, ExecutionRecord } from 'broapp/host';
import { createRunStore, redact, runIdOf, type RunStore } from 'broapp-autoapp/host';

let directory = '';
let store: RunStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

/** A fresh store in its own directory. */
function open(): RunStore {
  directory = mkdtempSync(join(tmpdir(), 'autoapp-runs-'));
  store = createRunStore(directory, { warn: () => undefined, error: () => undefined });
  return store;
}

/** A gate whose records go into `target`. */
function gateInto(target: RunStore, confirmTimeoutMs = 50) {
  return createGate({
    appId: 'items',
    releaseId: 'a'.repeat(32),
    confirmTimeoutMs,
    recorder: target.recorder(),
    logger: { warn: () => undefined, error: () => undefined },
  });
}

function envelope(channel: Envelope['channel'], requestId: string, extra: Partial<Envelope> = {}): Envelope {
  return { requestId, channel, caller: `${channel}:test`, ...extra };
}

describe('the recorder', () => {
  test('writes one step per gate decision, whatever the decision was', async () => {
    const runs = open();
    const gate = gateInto(runs);

    await gate.guard(
      { ...envelope('ai', 'run-1:c1'), route: 'items.list', effect: 'read', input: {} },
      () => Promise.resolve({ items: [] }),
    );
    // Denied: an agent writing with nobody to ask.
    await expect(
      gate.guard(
        { ...envelope('ai', 'run-1:c2'), route: 'items.add', effect: 'write', input: { label: 'x' } },
        () => Promise.resolve(null),
      ),
    ).rejects.toThrow();
    // Refused: preview forbids reaching outside, for anybody.
    const preview = createGate({
      appId: 'items',
      releaseId: 'a'.repeat(32),
      mode: 'preview',
      recorder: runs.recorder(),
      logger: { warn: () => undefined, error: () => undefined },
    });
    await expect(
      preview.guard(
        { ...envelope('ai', 'run-1:c3'), route: 'items.ping', effect: 'external', input: {} },
        () => Promise.resolve(null),
      ),
    ).rejects.toThrow();

    const found = runs.getRun('run-1');
    expect(found).not.toBeNull();
    expect(found?.run.status).toBe('running');
    expect(found?.steps.map((step) => [step.route, step.decision, step.outcome])).toEqual([
      ['items.list', 'allowed', 'succeeded'],
      ['items.add', 'denied', null],
      ['items.ping', 'refused', null],
    ]);
    // Output is kept only for a step that actually returned something.
    expect(found?.steps[0]?.output).toEqual({ items: [] });
    expect(found?.steps[1]?.output).toBeNull();

    runs.finishRun('run-1', 'succeeded', 'add two items');
    expect(runs.getRun('run-1')?.run.status).toBe('succeeded');
    expect(runs.getRun('run-1')?.run.summary).toBe('add two items');
    expect(runs.listRuns().map((run) => run.id)).toEqual(['run-1']);
  });

  test('a confirmed step is recorded as confirmed', async () => {
    const runs = open();
    const gate = gateInto(runs, 5_000);
    const approvals = createPendingApprovals({ warn: () => undefined, error: () => undefined });
    const request = envelope('workflow', 'wf-1:step-1', { approver: approvals });
    const running = gate.guard(
      { ...request, route: 'items.add', effect: 'write', input: { label: 'x' } },
      () => Promise.resolve({ id: 1 }),
    );
    while (approvals.pending.length === 0) await Bun.sleep(5);
    approvals.answer({ requestId: request.requestId, approved: true });
    await running;

    const found = runs.getRun('wf-1');
    expect(found?.steps[0]).toMatchObject({ decision: 'confirmed', outcome: 'succeeded' });
    expect(found?.steps[0]?.argumentsHash).toBe(argumentsHash({ label: 'x' }));
  });

  test('a run identifier is the prefix for agents and the whole id otherwise', () => {
    expect(runIdOf('run-1:c2', 'ai')).toBe('run-1');
    expect(runIdOf('wf-9:step-2', 'workflow')).toBe('wf-9');
    // An MCP call is its own run: there is no turn to group it under.
    expect(runIdOf('call-7', 'mcp')).toBe('call-7');
    expect(runIdOf('abc:def', 'user')).toBe('abc:def');
  });

  test('a broken store does not take the application down', async () => {
    const runs = open();
    const gate = gateInto(runs);
    runs.close();
    // The store's database is shut; recording has to fail and be swallowed.
    expect(
      await gate.guard(
        { ...envelope('user', 'r1'), route: 'items.list', effect: 'read', input: {} },
        () => Promise.resolve('fine'),
      ),
    ).toBe('fine');
    store = null;
  });
});

describe('redaction', () => {
  test('truncates long strings and replaces secret-shaped keys, at every depth', () => {
    const long = 'x'.repeat(2_500);
    const original = {
      note: long,
      apiKey: 'sk-live-1234',
      nested: { password: 'hunter2', fine: 'kept', deeper: [{ authToken: 'abc' }] },
      count: 7,
    };
    const before = JSON.stringify(original);

    expect(redact(original)).toEqual({
      note: '<truncated 2500 chars>',
      apiKey: '<redacted>',
      nested: { password: '<redacted>', fine: 'kept', deeper: [{ authToken: '<redacted>' }] },
      count: 7,
    });
    // The value handed in is never touched.
    expect(JSON.stringify(original)).toBe(before);
  });

  test('a recorded step is redacted on the way in', async () => {
    const runs = open();
    const gate = gateInto(runs);
    await gate.guard(
      {
        ...envelope('user', 'r1'),
        route: 'items.add',
        effect: 'write',
        input: { label: 'x', apiToken: 'sk-live-9' },
      },
      () => Promise.resolve({ ok: true }),
    );
    expect(runs.getRun('r1')?.steps[0]?.input).toEqual({ label: 'x', apiToken: '<redacted>' });
  });
});

describe('markUnknownOnStart', () => {
  test('a step that never finished becomes unknown, and so does its run', async () => {
    directory = mkdtempSync(join(tmpdir(), 'autoapp-runs-'));
    const quiet = { warn: () => undefined, error: () => undefined };
    const first = createRunStore(directory, quiet);

    // A step that was allowed and never recorded an outcome: exactly what a
    // process dying between the call and the record leaves behind.
    const halfway: ExecutionRecord = {
      requestId: 'run-9:c1',
      channel: 'ai',
      caller: 'ai:run-9',
      appId: 'items',
      releaseId: 'a'.repeat(32),
      route: 'mail.send',
      effect: 'external',
      input: {},
      argumentsHash: argumentsHash({}),
      mode: 'live',
      decision: 'confirmed',
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    first.recorder().record(halfway);
    expect(first.getRun('run-9')?.run.status).toBe('running');
    first.close();

    // Reopened, as the next process would.
    store = createRunStore(directory, quiet);
    store.markUnknownOnStart();
    const found = store.getRun('run-9');
    expect(found?.run.status).toBe('unknown');
    expect(found?.steps[0]?.outcome).toBe('unknown');
  });

  test('a step that was denied is left alone', () => {
    const runs = open();
    runs.recorder().record({
      requestId: 'run-8:c1',
      channel: 'ai',
      caller: 'ai:run-8',
      appId: 'items',
      releaseId: 'a'.repeat(32),
      route: 'items.add',
      effect: 'write',
      input: {},
      argumentsHash: argumentsHash({}),
      mode: 'live',
      decision: 'denied',
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    runs.finishRun('run-8', 'failed');
    runs.markUnknownOnStart();
    // Nothing ran, so there is nothing to be unsure about.
    expect(runs.getRun('run-8')?.steps[0]?.outcome).toBeNull();
    expect(runs.getRun('run-8')?.run.status).toBe('failed');
  });
});

describe('the store on disk', () => {
  test('lives in the data directory it was given', () => {
    const runs = open();
    runs.finishRun('nothing', 'succeeded');
    const db = new Database(join(directory, 'runs.sqlite'), { readonly: true });
    try {
      expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name).sort()).toEqual([
        'runs',
        'sqlite_sequence',
        'steps',
        'workflows',
      ]);
    } finally {
      db.close();
    }
  });
});
