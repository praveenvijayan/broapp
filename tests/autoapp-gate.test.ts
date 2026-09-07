/**
 * The execution gate: the policy, the approval identity, and the four ways in.
 *
 * The policy table is written out here as data rather than derived from
 * `decide`, because a test that computes the answer the same way the code does
 * proves only that the code is consistent with itself. The rest of the file is
 * about the part that is easy to get subtly wrong: an approval has to be about
 * the question that was asked, it has to be usable once, and a request nobody
 * answers has to end.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAi, createFakeAdapter, fromContract, guardedTool } from 'broapp/ai/host';
import type { GuardedTool } from 'broapp/ai/host';
import {
  argumentsHash,
  createGate,
  createHostApp,
  createPendingApprovals,
  decide,
} from 'broapp/host';
import type {
  Channel,
  Envelope,
  ExecutionMode,
  ExecutionRecord,
  Gate,
  PolicyVerdict,
} from 'broapp/host';
import { BroappError } from 'broapp/client';
import { defineContract, INTERNAL_ERROR_MESSAGE, publicError, s } from 'broapp/shared';
import type { Effect } from 'broapp/shared';

import { harness, until, type Harness } from './harness.ts';

/** A logger that keeps what it was told, so a test can count the lines. */
function log(): {
  readonly warns: string[];
  readonly errors: string[];
  warn(message: string): void;
  error(message: string): void;
} {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    warn: (message) => void warns.push(message),
    error: (message) => void errors.push(message),
  };
}

/** A gate plus the records it wrote. */
function gateWith(
  options: {
    mode?: ExecutionMode;
    confirmTimeoutMs?: number;
    logger?: { warn(m: string): void; error(m: string): void };
    recorder?: { record(record: ExecutionRecord): void };
  } = {},
): { gate: Gate; records: ExecutionRecord[] } {
  const records: ExecutionRecord[] = [];
  const gate = createGate({
    appId: 'test-app',
    releaseId: 'release-one',
    confirmTimeoutMs: options.confirmTimeoutMs ?? 50,
    recorder: options.recorder ?? { record: (record) => void records.push(record) },
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { gate, records };
}

/** An envelope from a trusted adapter, which in a test is the test. */
function envelope(channel: Channel, extra: Partial<Envelope> = {}): Envelope {
  return { requestId: `req-${Math.random().toString(36).slice(2)}`, channel, caller: 'test', ...extra };
}

describe('the policy table', () => {
  test('decide answers all 24 rows', () => {
    // Written out, not derived. Every row is a decision somebody made.
    const table: readonly (readonly [Channel, Effect, ExecutionMode, PolicyVerdict])[] = [
      ['user', 'read', 'live', 'allow'],
      ['user', 'read', 'preview', 'allow'],
      ['user', 'write', 'live', 'allow'],
      ['user', 'write', 'preview', 'allow'],
      ['user', 'external', 'live', 'allow'],
      ['user', 'external', 'preview', 'refuse'],
      ['ai', 'read', 'live', 'allow'],
      ['ai', 'read', 'preview', 'allow'],
      ['ai', 'write', 'live', 'confirm'],
      ['ai', 'write', 'preview', 'confirm'],
      ['ai', 'external', 'live', 'confirm'],
      ['ai', 'external', 'preview', 'refuse'],
      ['mcp', 'read', 'live', 'allow'],
      ['mcp', 'read', 'preview', 'allow'],
      ['mcp', 'write', 'live', 'confirm'],
      ['mcp', 'write', 'preview', 'confirm'],
      ['mcp', 'external', 'live', 'confirm'],
      ['mcp', 'external', 'preview', 'refuse'],
      ['workflow', 'read', 'live', 'allow'],
      ['workflow', 'read', 'preview', 'allow'],
      ['workflow', 'write', 'live', 'confirm'],
      ['workflow', 'write', 'preview', 'confirm'],
      ['workflow', 'external', 'live', 'confirm'],
      ['workflow', 'external', 'preview', 'refuse'],
    ];
    expect(table).toHaveLength(24);
    for (const [channel, effect, mode, expected] of table) {
      expect(`${channel} ${effect} ${mode} ${decide(channel, effect, mode)}`).toBe(
        `${channel} ${effect} ${mode} ${expected}`,
      );
    }
  });
});

describe('argumentsHash', () => {
  test('is about the value, not the key order', () => {
    const a = argumentsHash({ a: 1, b: { c: 2, d: 3 } });
    const b = argumentsHash({ b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(argumentsHash({ a: 1, b: { c: 2, d: 4 } })).not.toBe(a);
  });
});

describe('guard', () => {
  test('the owner may write with nobody to ask', async () => {
    const { gate, records } = gateWith();
    let ran = 0;
    const value = await gate.guard(
      { ...envelope('user'), route: 'notes.create', effect: 'write', input: { title: 'a' } },
      () => {
        ran += 1;
        return Promise.resolve('done');
      },
    );
    expect(value).toBe('done');
    expect(ran).toBe(1);
    expect(records[0]).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
  });

  test('an agent may read with nobody to ask', async () => {
    const { gate, records } = gateWith();
    let ran = 0;
    await gate.guard(
      { ...envelope('ai'), route: 'notes.list', effect: 'read', input: {} },
      () => {
        ran += 1;
        return Promise.resolve(null);
      },
    );
    expect(ran).toBe(1);
    expect(records[0]).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
  });

  test('an agent writing with nobody to ask is denied', async () => {
    const { gate, records } = gateWith();
    let ran = 0;
    const failed = gate.guard(
      { ...envelope('ai'), route: 'notes.create', effect: 'write', input: {} },
      () => {
        ran += 1;
        return Promise.resolve(null);
      },
    );
    await expect(failed).rejects.toMatchObject({ code: 'rejected' });
    expect(ran).toBe(0);
    expect(records[0]).toMatchObject({ decision: 'denied' });
    expect(records[0]?.outcome).toBeUndefined();
  });

  test('an approved call runs once and is recorded as confirmed', async () => {
    const { gate, records } = gateWith();
    const approvals = createPendingApprovals(log());
    let ran = 0;
    const request = { ...envelope('ai', { approver: approvals }), route: 'notes.create' };
    const running = gate.guard({ ...request, effect: 'write', input: { title: 'a' } }, () => {
      ran += 1;
      return Promise.resolve('made');
    });
    await until(() => approvals.pending.length === 1, 1_000, 'the question');
    expect(approvals.answer({ requestId: request.requestId, approved: true })).toBe('accepted');
    expect(await running).toBe('made');
    expect(ran).toBe(1);
    expect(records[0]).toMatchObject({ decision: 'confirmed', outcome: 'succeeded' });
  });

  test('a declined call does not run', async () => {
    const { gate, records } = gateWith();
    const approvals = createPendingApprovals(log());
    let ran = 0;
    const request = { ...envelope('ai', { approver: approvals }), route: 'notes.create' };
    const running = gate.guard({ ...request, effect: 'write', input: {} }, () => {
      ran += 1;
      return Promise.resolve(null);
    });
    await until(() => approvals.pending.length === 1, 1_000, 'the question');
    approvals.answer({ requestId: request.requestId, approved: false });
    await expect(running).rejects.toMatchObject({ code: 'rejected' });
    expect(ran).toBe(0);
    expect(records[0]).toMatchObject({ decision: 'denied' });
  });

  test('a question nobody answers ends as a refusal', async () => {
    const { gate } = gateWith({ confirmTimeoutMs: 50 });
    const approvals = createPendingApprovals(log());
    let ran = 0;
    const failed = gate.guard(
      { ...envelope('ai', { approver: approvals }), route: 'notes.create', effect: 'write', input: {} },
      () => {
        ran += 1;
        return Promise.resolve(null);
      },
    );
    await expect(failed).rejects.toMatchObject({ code: 'rejected' });
    expect(ran).toBe(0);
    expect(approvals.pending).toHaveLength(0);
  });

  test('a cancelled request stops waiting and is recorded as cancelled', async () => {
    const { gate, records } = gateWith({ confirmTimeoutMs: 5_000 });
    const approvals = createPendingApprovals(log());
    const controller = new AbortController();
    let ran = 0;
    const failed = gate.guard(
      {
        ...envelope('ai', { approver: approvals, signal: controller.signal }),
        route: 'notes.create',
        effect: 'write',
        input: {},
      },
      () => {
        ran += 1;
        return Promise.resolve(null);
      },
    );
    await until(() => approvals.pending.length === 1, 1_000, 'the question');
    controller.abort(new Error('the tab went away'));
    await expect(failed).rejects.toMatchObject({ code: 'rejected' });
    expect(ran).toBe(0);
    expect(records[0]).toMatchObject({ decision: 'denied', outcome: 'cancelled' });
  });

  test('an answer about different arguments is a mismatch, not an approval', async () => {
    const logger = log();
    const { gate } = gateWith({ confirmTimeoutMs: 5_000, logger });
    const approvals = createPendingApprovals(logger);
    let ran = 0;
    const request = { ...envelope('ai', { approver: approvals }), route: 'notes.create' };
    const running = gate.guard({ ...request, effect: 'write', input: { title: 'a' } }, () => {
      ran += 1;
      return Promise.resolve(null);
    });
    await until(() => approvals.pending.length === 1, 1_000, 'the question');
    expect(
      approvals.answer({
        requestId: request.requestId,
        approved: true,
        argumentsHash: argumentsHash({ title: 'something else' }),
      }),
    ).toBe('mismatch');
    await expect(running).rejects.toMatchObject({ code: 'rejected' });
    expect(ran).toBe(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain('argumentsHash');
  });

  test('an answer about a different release is a mismatch', async () => {
    const logger = log();
    const { gate } = gateWith({ confirmTimeoutMs: 5_000, logger });
    const approvals = createPendingApprovals(logger);
    let ran = 0;
    const request = { ...envelope('ai', { approver: approvals }), route: 'notes.create' };
    const running = gate.guard({ ...request, effect: 'write', input: {} }, () => {
      ran += 1;
      return Promise.resolve(null);
    });
    await until(() => approvals.pending.length === 1, 1_000, 'the question');
    expect(
      approvals.answer({ requestId: request.requestId, approved: true, releaseId: 'another' }),
    ).toBe('mismatch');
    await expect(running).rejects.toMatchObject({ code: 'rejected' });
    expect(ran).toBe(0);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain('releaseId');
  });

  test('an approval is consumed once', async () => {
    const { gate } = gateWith({ confirmTimeoutMs: 5_000 });
    const approvals = createPendingApprovals(log());
    let ran = 0;
    const request = { ...envelope('ai', { approver: approvals }), route: 'notes.create' };
    const running = gate.guard({ ...request, effect: 'write', input: {} }, () => {
      ran += 1;
      return Promise.resolve('once');
    });
    await until(() => approvals.pending.length === 1, 1_000, 'the question');
    expect(approvals.answer({ requestId: request.requestId, approved: true })).toBe('accepted');
    expect(await running).toBe('once');
    // The second answer names nothing that is waiting, so it changes nothing.
    expect(approvals.answer({ requestId: request.requestId, approved: false })).toBe('unknown');
    expect(ran).toBe(1);
  });

  test('two questions are answered independently', async () => {
    const { gate } = gateWith({ confirmTimeoutMs: 200 });
    const approvals = createPendingApprovals(log());
    const ran: string[] = [];
    const first = { ...envelope('ai', { approver: approvals }), route: 'notes.create' };
    const second = { ...envelope('ai', { approver: approvals }), route: 'notes.remove' };
    const firstRun = gate.guard({ ...first, effect: 'write', input: { n: 1 } }, () => {
      ran.push('first');
      return Promise.resolve(null);
    });
    const secondRun = gate.guard({ ...second, effect: 'write', input: { n: 2 } }, () => {
      ran.push('second');
      return Promise.resolve(null);
    });
    await until(() => approvals.pending.length === 2, 1_000, 'both questions');
    approvals.answer({ requestId: second.requestId, approved: true });
    await secondRun;
    expect(ran).toEqual(['second']);
    await expect(firstRun).rejects.toMatchObject({ code: 'rejected' });
    expect(ran).toEqual(['second']);
  });

  test('two questions under one request identifier is a programming error', () => {
    const approvals = createPendingApprovals(log());
    const question = {
      requestId: 'the-same',
      channel: 'ai' as const,
      caller: 'test',
      appId: 'test-app',
      releaseId: 'release-one',
      route: 'notes.create',
      effect: 'write' as const,
      input: {},
      argumentsHash: argumentsHash({}),
    };
    void approvals.ask(question, new AbortController().signal);
    expect(() => approvals.ask(question, new AbortController().signal)).toThrow(TypeError);
  });

  test('preview refuses external for everybody, without asking', async () => {
    const { gate } = gateWith({ mode: 'preview' });
    let asked = 0;
    const approver = {
      ask: (): Promise<boolean> => {
        asked += 1;
        return Promise.resolve(true);
      },
    };
    await expect(
      gate.guard(
        { ...envelope('user'), route: 'mail.send', effect: 'external', input: {} },
        () => Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ code: 'rejected' });
    await expect(
      gate.guard(
        { ...envelope('ai', { approver }), route: 'mail.send', effect: 'external', input: {} },
        () => Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ code: 'rejected' });
    expect(asked).toBe(0);
  });

  test('an envelope may tighten to preview but never loosen back to live', async () => {
    const live = gateWith();
    await expect(
      live.gate.guard(
        { ...envelope('user', { mode: 'preview' }), route: 'mail.send', effect: 'external', input: {} },
        () => Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ code: 'rejected' });

    const preview = gateWith({ mode: 'preview' });
    await expect(
      preview.gate.guard(
        { ...envelope('user', { mode: 'live' }), route: 'mail.send', effect: 'external', input: {} },
        () => Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ code: 'rejected' });
  });

  test('a failure is recorded with a message that is safe to keep', async () => {
    const { gate, records } = gateWith();
    await expect(
      gate.guard({ ...envelope('user'), route: 'notes.create', effect: 'write', input: {} }, () =>
        Promise.reject(publicError.conflict('That name is taken.')),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(records[0]).toMatchObject({ outcome: 'failed', error: 'That name is taken.' });

    await expect(
      gate.guard({ ...envelope('user'), route: 'notes.create', effect: 'write', input: {} }, () =>
        Promise.reject(new Error('/Users/someone/.config/secret-token-abc123')),
      ),
    ).rejects.toThrow('secret-token');
    expect(records[1]).toMatchObject({ outcome: 'failed', error: INTERNAL_ERROR_MESSAGE });
  });

  test('a paused gate holds back writes and still answers reads', async () => {
    const { gate, records } = gateWith();
    expect(gate.paused).toBe(false);
    gate.pause('the application is being updated');
    expect(gate.paused).toBe(true);

    let ran = 0;
    const write = gate.guard(
      { ...envelope('user'), route: 'notes.create', effect: 'write', input: {} },
      () => {
        ran += 1;
        return Promise.resolve(null);
      },
    );
    // `unavailable`, not `rejected`: nobody decided against this call, the
    // application simply declined to be asked for a moment.
    await expect(write).rejects.toMatchObject({ code: 'unavailable' });
    await expect(write).rejects.toThrow('the application is being updated');
    expect(ran).toBe(0);
    // A pause is not a decision, so there is nothing to write down.
    expect(records).toEqual([]);

    expect(
      await gate.guard(
        { ...envelope('user'), route: 'notes.list', effect: 'read', input: {} },
        () => Promise.resolve('still here'),
      ),
    ).toBe('still here');
    expect(records[0]).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
  });

  test('resume admits writes again', async () => {
    const { gate } = gateWith();
    gate.pause('updating');
    await expect(
      gate.guard({ ...envelope('user'), route: 'notes.create', effect: 'write', input: {} }, () =>
        Promise.resolve(null),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    gate.resume();
    expect(gate.paused).toBe(false);
    expect(
      await gate.guard(
        { ...envelope('user'), route: 'notes.create', effect: 'write', input: {} },
        () => Promise.resolve('through'),
      ),
    ).toBe('through');
  });

  test('pausing does not disturb an approval already being waited on', async () => {
    const { gate, records } = gateWith({ confirmTimeoutMs: 5_000 });
    const approvals = createPendingApprovals(log());
    let ran = 0;
    const request = { ...envelope('ai', { approver: approvals }), route: 'notes.create' };
    const running = gate.guard({ ...request, effect: 'write', input: {} }, () => {
      ran += 1;
      return Promise.resolve('done anyway');
    });
    await until(() => approvals.pending.length === 1, 1_000, 'the question');

    // The pause arrives while somebody is deciding. The question was already
    // admitted; taking it back now would be a confusing way to answer it.
    gate.pause('updating');
    approvals.answer({ requestId: request.requestId, approved: true });
    expect(await running).toBe('done anyway');
    expect(ran).toBe(1);
    expect(records[0]).toMatchObject({ decision: 'confirmed', outcome: 'succeeded' });
  });

  test('a broken recorder does not break the application', async () => {
    const logger = log();
    const { gate } = gateWith({
      logger,
      recorder: {
        record: () => {
          throw new Error('the run store is gone');
        },
      },
    });
    expect(
      await gate.guard(
        { ...envelope('user'), route: 'notes.list', effect: 'read', input: {} },
        () => Promise.resolve('fine'),
      ),
    ).toBe('fine');
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toContain('notes.list');
  });
});

/** A contract whose routes say what they do, for the end-to-end tests. */
const contract = defineContract({
  operations: {
    'demo.fetch': {
      effect: 'external',
      summary: 'Reach outside this machine.',
      input: s.void(),
      output: s.object({ ok: s.boolean() }),
    },
    'demo.save': {
      effect: 'write',
      summary: 'Change something local.',
      input: s.object({ text: s.string({ max: 100 }) }),
      output: s.object({ ok: s.boolean() }),
    },
  },
  streams: {
    'demo.watch': {
      effect: 'external',
      summary: 'Watch something outside this machine.',
      params: s.object({ count: s.number({ int: true, min: 1, max: 10 }) }),
      event: s.object({ n: s.number() }),
    },
  },
});

let live: Harness | null = null;
let directory = '';

afterEach(async () => {
  await live?.stop();
  live = null;
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

/** An application whose gate the test chooses, over a real bridge. */
async function startWith(mode: ExecutionMode): Promise<{ harness: Harness; ran: string[] }> {
  const ran: string[] = [];
  const app = createHostApp<typeof contract>(contract, {
    gate: createGate({ appId: 'demo', releaseId: 'release-one', mode, logger: log() }),
    logger: log(),
  });
  app.operation('demo.fetch', () => {
    ran.push('demo.fetch');
    return { ok: true };
  });
  app.operation('demo.save', () => {
    ran.push('demo.save');
    return { ok: true };
  });
  app.stream('demo.watch', async ({ count }, sink) => {
    ran.push('demo.watch');
    for (let n = 1; n <= count; n += 1) await sink.emit({ n });
  });
  live = await harness((bridge) => app.mount(bridge));
  return { harness: live, ran };
}

describe('over a real bridge', () => {
  test('a preview refuses an external operation, and a live gate runs it', async () => {
    const previewing = await startWith('preview');
    const previewClient = await previewing.harness.connect(contract);
    try {
      await previewClient.call('demo.fetch', undefined);
      throw new Error('should have rejected');
    } catch (cause) {
      expect(cause).toBeInstanceOf(BroappError);
      expect((cause as BroappError).code).toBe('rejected');
    }
    expect(previewing.ran).toEqual([]);
    await previewClient.close();
    await previewing.harness.stop();

    const running = await startWith('live');
    const liveClient = await running.harness.connect(contract);
    expect(await liveClient.call('demo.fetch', undefined)).toEqual({ ok: true });
    expect(running.ran).toEqual(['demo.fetch']);
    await liveClient.close();
  });

  test('a preview refuses an external stream, and a live gate runs it', async () => {
    const previewing = await startWith('preview');
    const previewClient = await previewing.harness.connect(contract);
    const seen: string[] = [];
    let finished = false;
    await previewClient.subscribe('demo.watch', { count: 1 }, {
      onEvent: () => undefined,
      onDone: () => {
        finished = true;
      },
      onError: (cause) => {
        seen.push(cause.code);
        finished = true;
      },
    });
    await until(() => finished, 5_000, 'the stream to fail');
    expect(seen).toEqual(['rejected']);
    expect(previewing.ran).toEqual([]);
    await previewClient.close();
    await previewing.harness.stop();

    const running = await startWith('live');
    const liveClient = await running.harness.connect(contract);
    const events: { n: number }[] = [];
    let done = false;
    await liveClient.subscribe('demo.watch', { count: 1 }, {
      onEvent: (event) => void events.push(event),
      onDone: () => {
        done = true;
      },
    });
    await until(() => done, 5_000, 'the stream to end');
    expect(events).toEqual([{ n: 1 }]);
    expect(running.ran).toEqual(['demo.watch']);
    await liveClient.close();
  });
});

describe('invoke', () => {
  /** The same application twice: once with nobody to ask, once with somebody. */
  function buildApp(gate: Gate): { app: ReturnType<typeof createHostApp<typeof contract>>; ran: string[] } {
    const ran: string[] = [];
    const app = createHostApp<typeof contract>(contract, { gate, logger: log() });
    app.operation('demo.fetch', () => ({ ok: true }));
    app.operation('demo.save', () => {
      ran.push('demo.save');
      return { ok: true };
    });
    app.stream('demo.watch', () => undefined);
    return { app, ran };
  }

  test('an agent writing through invoke needs somebody to ask', async () => {
    const { gate } = gateWith();
    const { app, ran } = buildApp(gate);
    await expect(
      app.invoke('demo.save', { text: 'a' }, envelope('ai')),
    ).rejects.toThrow(/rejected/);
    expect(ran).toEqual([]);
  });

  test('an agent writing through invoke runs once approved', async () => {
    const { gate } = gateWith({ confirmTimeoutMs: 5_000 });
    const { app, ran } = buildApp(gate);
    const approvals = createPendingApprovals(log());
    const asking = envelope('ai', { approver: approvals });
    const running = app.invoke('demo.save', { text: 'a' }, asking);
    await until(() => approvals.pending.length === 1, 1_000, 'the question');
    approvals.answer({ requestId: asking.requestId, approved: true });
    expect(await running).toEqual({ ok: true });
    expect(ran).toEqual(['demo.save']);
  });
});

describe('the AI layer over the gate', () => {
  const toolContract = defineContract({
    operations: {
      'notes.list': {
        effect: 'read',
        summary: 'List notes.',
        input: s.void(),
        output: s.object({ titles: s.array(s.string()) }),
      },
      'notes.create': {
        effect: 'write',
        summary: 'Create a note.',
        input: s.object({ title: s.string({ min: 1, max: 50 }) }),
        output: s.object({ ok: s.boolean() }),
      },
    },
    streams: {},
  });

  function toolApp(): ReturnType<typeof createHostApp<typeof toolContract>> {
    const app = createHostApp<typeof toolContract>(toolContract, { logger: log() });
    app.operation('notes.list', () => ({ titles: [] }));
    app.operation('notes.create', () => ({ ok: true }));
    return app;
  }

  /** `createAi` needs a directory to keep settings in, and never a network. */
  function aiOptions(tools: Record<string, GuardedTool>): Parameters<typeof createAi>[0] {
    directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
    return {
      dataDir: directory,
      providers: [createFakeAdapter()],
      app: { name: 'Demo', purpose: 'It demonstrates.' },
      fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), {
        preconnect: () => undefined,
      }) as typeof fetch,
      tools,
      logger: log(),
    };
  }

  test('an unguarded tool is refused, and a guarded one is accepted', () => {
    const { gate } = gateWith();
    const unguarded = {
      description: 'Do something nobody approved.',
      inputSchema: { type: 'object', properties: {} },
      effect: 'write' as const,
      execute: () => Promise.resolve(null),
    };
    expect(() => createAi(aiOptions({ 'demo.sneak': unguarded as never }))).toThrow(TypeError);
    expect(() => createAi(aiOptions({ 'demo.sneak': unguarded as never }))).toThrow(/guardedTool/);

    const guarded = guardedTool(gate, {
      name: 'demo.sneak',
      description: 'Do something, having asked.',
      inputSchema: { type: 'object', properties: {} },
      effect: 'write',
      run: () => Promise.resolve({ ok: true }),
    });
    expect(createAi(aiOptions({ 'demo.sneak': guarded })).activeStreams).toBe(0);
  });

  test('a list that disagrees with a declared effect is refused at startup', () => {
    const app = toolApp();
    expect(() => fromContract(toolContract, app, { confirm: ['notes.list'] })).toThrow(TypeError);
    expect(() => fromContract(toolContract, app, { confirm: ['notes.list'] })).toThrow(
      /notes\.list/,
    );
    expect(() => fromContract(toolContract, app, { read: ['notes.create'] })).toThrow(TypeError);
    expect(() => fromContract(toolContract, app, { read: ['notes.create'] })).toThrow(
      /notes\.create/,
    );
    // The lists that agree with the contract are still fine.
    expect(
      Object.keys(fromContract(toolContract, app, { read: ['notes.list'], confirm: ['notes.create'] })),
    ).toEqual(['notes.list', 'notes.create']);
  });
});
