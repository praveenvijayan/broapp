/**
 * Saved workflows: drafting one, checking one, running one, promoting one.
 *
 * The property under test that matters is that a workflow remembers *what to
 * do*, never *permission to do it*. Every write asks again, on every run, and
 * there is no path through the code that could consult an old approval.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  argumentsHash,
  createGate,
  createHostApp,
  createPendingApprovals,
  createReservedHostApp,
} from 'broapp/host';
import type { Approver, HostApp } from 'broapp/host';
import { defineContract, mergeContracts, s, ValidationError } from 'broapp/shared';
import type { AnyContract } from 'broapp/shared';
import { createAutoappHost, createRunStore, attachedOnly, type RunStore } from 'broapp-autoapp/host';
import { autoappContract, withAutoappRoutes } from 'broapp-autoapp/shared';
import type { ViewsSpec } from 'broapp-autoapp/shared';
import { exportContract } from 'broapp-autoapp/spec';
import {
  draftFromRun,
  parameterise,
  parseWorkflow,
  runWorkflow,
} from 'broapp-autoapp/workflows';
import type { WorkflowDefinition } from 'broapp-autoapp/workflows';

import { harness, type Harness } from './harness.ts';

/** A small application: one read, one write, one that reaches outside. */
const contract = defineContract({
  operations: {
    'items.list': {
      effect: 'read',
      summary: 'Every item.',
      input: s.void(),
      output: s.object({ items: s.array(s.string(), { max: 100 }), count: s.number() }),
    },
    'items.add': {
      effect: 'write',
      summary: 'Add one item.',
      input: s.object({ label: s.string({ min: 1, max: 100 }) }),
      output: s.object({ id: s.number(), label: s.string() }),
    },
    'items.ping': {
      effect: 'external',
      summary: 'Reach outside.',
      input: s.void(),
      output: s.object({ ok: s.boolean() }),
    },
  },
  streams: {},
});

const exported = exportContract(contract);

const views: ViewsSpec = {
  specVersion: 1,
  home: 'items',
  pages: [
    {
      id: 'items',
      title: 'Items',
      sources: [{ id: 'all', operation: 'items.list' }],
      children: [
        { id: 'intro', kind: 'text', template: 'You have {{all.count}} items.' },
        {
          id: 'items-table',
          kind: 'table',
          source: 'all',
          rows: 'items',
          columns: [{ id: 'label', header: 'Label', path: '' }],
        },
      ],
    },
  ],
};

let directory = '';
let store: RunStore | null = null;
let live: Harness | null = null;

afterEach(async () => {
  await live?.stop();
  live = null;
  store?.close();
  store = null;
  if (directory !== '') rmSync(directory, { recursive: true, force: true });
  directory = '';
});

/** The application, its gate, its store — everything a workflow needs to run. */
function build(options: { attached?: boolean } = {}): {
  app: HostApp<typeof contract>;
  store: RunStore;
  approvals: ReturnType<typeof createPendingApprovals>;
  approver: Approver;
  added: string[];
} {
  directory = mkdtempSync(join(tmpdir(), 'autoapp-wf-'));
  const quiet = { warn: () => undefined, error: () => undefined };
  store = createRunStore(directory, quiet);
  const approvals = createPendingApprovals(quiet);
  const approver = attachedOnly(approvals, () => options.attached !== false);

  const app = createHostApp(contract, {
    gate: createGate({
      appId: 'items',
      releaseId: 'a'.repeat(32),
      confirmTimeoutMs: 5_000,
      recorder: store.recorder(),
      logger: quiet,
    }),
    logger: quiet,
  });
  const added: string[] = [];
  app.operation('items.list', () => ({ items: [...added], count: added.length }));
  app.operation('items.add', ({ label }) => {
    added.push(label);
    return { id: added.length, label };
  });
  app.operation('items.ping', () => ({ ok: true }));

  return { app, store, approvals, approver, added };
}

/** Answer the next pending question, once there is one. */
async function answerNext(
  approvals: ReturnType<typeof createPendingApprovals>,
  approved: boolean,
  mangle?: (hash: string) => string,
): Promise<string> {
  while (approvals.pending.length === 0) await Bun.sleep(5);
  const question = approvals.pending[0];
  if (question === undefined) throw new Error('no pending question');
  const result = approvals.answer({
    requestId: question.requestId,
    approved,
    releaseId: question.releaseId,
    argumentsHash: mangle === undefined ? question.argumentsHash : mangle(question.argumentsHash),
  });
  return result;
}

describe('parseWorkflow', () => {
  const good = {
    version: 1,
    onFailure: 'stop',
    params: [{ name: 'label', type: 'text', label: 'Label', required: true }],
    steps: [
      { id: 'add', route: 'items.add', input: { label: '$param.label' } },
      { id: 'list', route: 'items.list', input: null },
    ],
  };

  test('accepts a well-formed workflow', () => {
    expect(parseWorkflow(good, exported).steps).toHaveLength(2);
  });

  test('refuses a forward step reference', () => {
    const forward = {
      ...good,
      steps: [
        { id: 'add', route: 'items.add', input: { label: '$step.list.count' } },
        { id: 'list', route: 'items.list', input: null },
      ],
    };
    expect(() => parseWorkflow(forward, exported)).toThrow(/does not run before this one/);
  });

  test('refuses a step that refers to itself', () => {
    const itself = {
      ...good,
      steps: [{ id: 'add', route: 'items.add', input: { label: '$step.add.label' } }],
    };
    expect(() => parseWorkflow(itself, exported)).toThrow(/does not run before this one/);
  });

  test('refuses a parameter nobody declared', () => {
    const unknown = { ...good, params: [] };
    expect(() => parseWorkflow(unknown, exported)).toThrow(/does not declare/);
  });

  test('refuses a route the application does not have', () => {
    const gone = {
      ...good,
      steps: [{ id: 'add', route: 'items.gone', input: {} }],
      params: [],
    };
    expect(() => parseWorkflow(gone, exported)).toThrow(/items\.gone/);
  });

  test('refuses a duplicate step id', () => {
    const twice = {
      ...good,
      params: [],
      steps: [
        { id: 'add', route: 'items.list', input: null },
        { id: 'add', route: 'items.list', input: null },
      ],
    };
    expect(() => parseWorkflow(twice, exported)).toThrow(/used twice/);
  });

  test('a failure is a ValidationError, so its issues can be shown', () => {
    try {
      parseWorkflow({ version: 1, params: [], steps: [], onFailure: 'stop' }, exported);
      throw new Error('should have thrown');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ValidationError);
    }
  });

  test('a workflow cannot name an autoapp route, so it cannot approve itself', () => {
    const sneaky = {
      version: 1,
      params: [],
      onFailure: 'stop',
      steps: [
        {
          id: 'approve',
          route: 'autoapp.approvalsAnswer',
          input: { requestId: 'x', approved: true, releaseId: 'y', argumentsHash: 'z' },
        },
      ],
    };
    // The application's own contract is what a workflow is checked against, and
    // it does not contain Autoapp's routes.
    expect(() => parseWorkflow(sneaky, exported)).toThrow(/autoapp\.approvalsAnswer/);
  });
});

describe('draftFromRun and parameterise', () => {
  /** A recorded run: one read, one write, one denied. */
  function record(target: RunStore, options: { unknownStep?: boolean } = {}): void {
    const base = {
      channel: 'ai' as const,
      caller: 'ai:run-1',
      appId: 'items',
      releaseId: 'a'.repeat(32),
      mode: 'live' as const,
      askedAt: Date.now(),
      expiresAt: Date.now() + 120_000,
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    const recorder = target.recorder();
    // An unknown step is not something the gate records: it is a step that was
    // allowed and never recorded an outcome at all, which `markUnknownOnStart`
    // later resolves. So the "unknown" case leaves the outcome off.
    recorder.record({
      ...base,
      requestId: 'run-1:c1',
      route: 'items.add',
      effect: 'write',
      input: { label: 'milk' },
      argumentsHash: argumentsHash({ label: 'milk' }),
      decision: 'confirmed',
      ...(options.unknownStep === true
        ? {}
        : { outcome: 'succeeded' as const, output: { id: 1, label: 'milk' } }),
    });
    recorder.record({
      ...base,
      requestId: 'run-1:c2',
      route: 'items.list',
      effect: 'read',
      input: undefined,
      argumentsHash: argumentsHash(undefined),
      decision: 'allowed',
      outcome: 'succeeded',
      output: { items: ['milk'], count: 1 },
    });
    recorder.record({
      ...base,
      requestId: 'run-1:c3',
      route: 'items.ping',
      effect: 'external',
      input: undefined,
      argumentsHash: argumentsHash(undefined),
      decision: 'denied',
    });
    if (options.unknownStep === true) {
      // What the next process does when it finds the store mid-step.
      target.markUnknownOnStart();
    } else {
      target.finishRun('run-1', 'succeeded', 'add milk');
    }
  }

  test('one step per succeeded step, and nothing else', () => {
    const { store: target } = build();
    record(target);
    const found = target.getRun('run-1');
    if (found === null) throw new Error('the run was not recorded');
    const definition = draftFromRun(found.run, found.steps, exported);

    // The denied step is not in the draft: it is a thing the person said no to.
    expect(definition.steps.map((step) => step.route)).toEqual(['items.add', 'items.list']);
    expect(definition.steps[0]?.input).toEqual({ label: 'milk' });
    expect(definition.params).toEqual([]);
  });

  test('a run with an unknown step cannot be saved', () => {
    const { store: target } = build();
    record(target, { unknownStep: true });
    const found = target.getRun('run-1');
    if (found === null) throw new Error('the run was not recorded');
    expect(() => draftFromRun(found.run, found.steps, exported)).toThrow(/unknown outcome/);
  });

  test('parameterise replaces only the picked literal', () => {
    const definition = parseWorkflow(
      {
        version: 1,
        params: [],
        onFailure: 'stop',
        steps: [
          { id: 'add-one', route: 'items.add', input: { label: 'milk' } },
          { id: 'add-two', route: 'items.add', input: { label: 'milk' } },
        ],
      },
      exported,
    );
    const parameterised = parameterise(definition, [
      { stepId: 'add-one', inputPath: 'label', paramName: 'label', type: 'text', label: 'Label' },
    ]);

    expect(parameterised.steps[0]?.input).toEqual({ label: '$param.label' });
    // The identical literal in the other step is left exactly as it was: two
    // arguments that happen to be equal are not thereby the same argument.
    expect(parameterised.steps[1]?.input).toEqual({ label: 'milk' });
    expect(parameterised.params).toEqual([
      { name: 'label', type: 'text', label: 'Label', required: true },
    ]);
    // The input is never mutated.
    expect(definition.steps[0]?.input).toEqual({ label: 'milk' });
  });
});

describe('runWorkflow', () => {
  const definition: WorkflowDefinition = {
    version: 1,
    onFailure: 'stop',
    params: [{ name: 'label', type: 'text', label: 'Label', required: true }],
    steps: [
      { id: 'before', route: 'items.list', input: null },
      { id: 'add', route: 'items.add', input: { label: '$param.label' } },
      { id: 'after', route: 'items.list', input: null },
    ],
  };

  test('a read runs without asking; a write asks and then runs', async () => {
    const world = build();
    const running = runWorkflow({
      app: world.app as HostApp<AnyContract>,
      contract: exported,
      workflowId: 'wf-1',
      definition,
      params: { label: 'milk' },
      approver: world.approver,
      runId: 'wf-run-1',
    });
    // Nothing was asked about the read; the write is what is waiting.
    expect(await answerNext(world.approvals, true)).toBe('accepted');
    const result = await running;

    expect(result.status).toBe('succeeded');
    expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(world.added).toEqual(['milk']);

    // Every step is in the store, under one run.
    const found = world.store.getRun('wf-run-1');
    expect(found?.steps.map((step) => step.route)).toEqual([
      'items.list',
      'items.add',
      'items.list',
    ]);
    expect(found?.steps[1]?.decision).toBe('confirmed');
  });

  test('declining stops the run and everything after it is skipped', async () => {
    const world = build();
    const running = runWorkflow({
      app: world.app as HostApp<AnyContract>,
      contract: exported,
      workflowId: 'wf-1',
      definition,
      params: { label: 'milk' },
      approver: world.approver,
      runId: 'wf-run-2',
      logger: { warn: () => undefined, error: () => undefined },
    });
    await answerNext(world.approvals, false);
    const result = await running;

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'declined', 'skipped']);
    expect(world.added).toEqual([]);
  });

  test('a step reference resolves to an earlier step’s output', async () => {
    const world = build();
    world.added.push('bread');
    const chained: WorkflowDefinition = {
      version: 1,
      onFailure: 'stop',
      params: [],
      steps: [
        { id: 'before', route: 'items.list', input: null },
        { id: 'add', route: 'items.add', input: { label: '$step.before.items.0' } },
      ],
    };
    const running = runWorkflow({
      app: world.app as HostApp<AnyContract>,
      contract: exported,
      workflowId: 'wf-2',
      definition: chained,
      params: {},
      approver: world.approver,
      runId: 'wf-run-3',
    });
    await answerNext(world.approvals, true);
    expect((await running).status).toBe('succeeded');
    expect(world.added).toEqual(['bread', 'bread']);
  });

  test('skipWhen skips, and the run still succeeds', async () => {
    const world = build();
    const conditional: WorkflowDefinition = {
      version: 1,
      onFailure: 'stop',
      params: [],
      steps: [
        { id: 'before', route: 'items.list', input: null },
        {
          id: 'add',
          route: 'items.add',
          input: { label: 'only when empty' },
          // The list is empty, so this is skipped and nothing asks.
          skipWhen: { step: 'before', path: 'count', equals: 0 },
        },
      ],
    };
    const result = await runWorkflow({
      app: world.app as HostApp<AnyContract>,
      contract: exported,
      workflowId: 'wf-3',
      definition: conditional,
      params: {},
      approver: world.approver,
      runId: 'wf-run-4',
    });
    expect(result.status).toBe('succeeded');
    expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'skipped']);
    expect(world.added).toEqual([]);
  });

  test('with no tab attached, a write is denied without anybody being asked', async () => {
    const world = build({ attached: false });
    const running = runWorkflow({
      app: world.app as HostApp<AnyContract>,
      contract: exported,
      workflowId: 'wf-4',
      definition,
      params: { label: 'milk' },
      approver: world.approver,
      runId: 'wf-run-5',
      logger: { warn: () => undefined, error: () => undefined },
    });
    const result = await running;
    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => step.status)).toEqual(['succeeded', 'declined', 'skipped']);
    // The table was never consulted, so nothing is left waiting in it.
    expect(world.approvals.pending).toHaveLength(0);
    expect(world.added).toEqual([]);
  });

  test('an answer about different arguments is a mismatch, and the step is denied', async () => {
    const world = build();
    const running = runWorkflow({
      app: world.app as HostApp<AnyContract>,
      contract: exported,
      workflowId: 'wf-5',
      definition,
      params: { label: 'milk' },
      approver: world.approver,
      runId: 'wf-run-6',
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await answerNext(world.approvals, true, () => argumentsHash({ label: 'something else' }))).toBe(
      'mismatch',
    );
    const result = await running;
    expect(result.steps[1]?.status).toBe('declined');
    expect(world.added).toEqual([]);
  });

  test('a saved workflow asks again on every run', async () => {
    const world = build();
    for (const runId of ['wf-run-a', 'wf-run-b']) {
      const running = runWorkflow({
        app: world.app as HostApp<AnyContract>,
        contract: exported,
        workflowId: 'wf-6',
        definition,
        params: { label: 'milk' },
        approver: world.approver,
        runId,
      });
      // If an old approval could be reused, this would resolve with nothing
      // pending and the loop would hang here on the second pass.
      expect(await answerNext(world.approvals, true)).toBe('accepted');
      expect((await running).status).toBe('succeeded');
    }
    expect(world.added).toEqual(['milk', 'milk']);
  });
});

describe('the autoapp host over a real bridge', () => {
  const merged = mergeContracts(contract, autoappContract);

  async function start(): Promise<{ harness: Harness; world: ReturnType<typeof build> }> {
    const world = build();
    const quiet = { warn: () => undefined, error: () => undefined };
    const autoapp = createAutoappHost({
      dataDir: directory,
      views,
      store: world.store,
      contract: exported,
      app: world.app as HostApp<AnyContract>,
      isAttached: () => true,
      logger: quiet,
    });
    live = await harness((bridge) => {
      world.app.mount(bridge);
      autoapp.mount(bridge);
    });
    return { harness: live, world };
  }

  test('a workflow can be saved, listed, run and deleted', async () => {
    const { harness: test, world } = await start();
    const client = await test.connect(merged);

    const saved = await client.call('autoapp.workflowSave', {
      name: 'Add one',
      definition: {
        version: 1,
        onFailure: 'stop',
        params: [{ name: 'label', type: 'text', label: 'Label', required: true }],
        steps: [{ id: 'add', route: 'items.add', input: { label: '$param.label' } }],
      },
    });
    expect(saved.version).toBe(1);
    expect((await client.call('autoapp.workflowsList', undefined)).workflows).toHaveLength(1);

    // Run it, and answer the question it raises.
    const running = client.call('autoapp.workflowRun', { id: saved.id, params: { label: 'milk' } });
    const pending = await waitForPending(client);
    expect(pending.route).toBe('items.add');
    expect(
      await client.call('autoapp.approvalsAnswer', {
        requestId: pending.requestId,
        approved: true,
        releaseId: pending.releaseId,
        argumentsHash: pending.argumentsHash,
      }),
    ).toEqual({ result: 'accepted' });

    const result = await running;
    expect(result.status).toBe('succeeded');
    expect(world.added).toEqual(['milk']);

    expect(await client.call('autoapp.workflowDelete', { id: saved.id })).toEqual({ removed: true });
    await client.close();
  }, 20_000);

  test('a promoted workflow appears on the page, after its anchor', async () => {
    const { harness: test } = await start();
    const client = await test.connect(merged);
    const saved = await client.call('autoapp.workflowSave', {
      name: 'Add one',
      definition: {
        version: 1,
        onFailure: 'stop',
        params: [{ name: 'label', type: 'text', label: 'Label', required: true }],
        steps: [{ id: 'add', route: 'items.add', input: { label: '$param.label' } }],
      },
    });

    expect(
      await client.call('autoapp.workflowPromote', {
        id: saved.id,
        page: 'items',
        afterComponentId: 'intro',
        label: 'Add one',
      }),
    ).toEqual({ ok: true });

    const shown = await client.call('autoapp.viewsGet', undefined);
    const children = shown.views.pages[0]?.children ?? [];
    expect(children.map((child) => child.id)).toEqual([
      'intro',
      `wf-${saved.id}`,
      'items-table',
    ]);
    // A workflow with parameters becomes a form, whose submit runs it.
    const added = children[1];
    expect(added?.kind).toBe('form');
    expect(added?.submit?.operation).toBe('autoapp.workflowRun');
    expect(added?.submit?.confirmText).toBe('Run Add one?');
    expect(shown.conflicts).toEqual([]);
    await client.close();
  }, 20_000);

  test('promoting onto an anchor that is not there is refused', async () => {
    const { harness: test } = await start();
    const client = await test.connect(merged);
    const saved = await client.call('autoapp.workflowSave', {
      name: 'Add one',
      definition: {
        version: 1,
        onFailure: 'stop',
        params: [],
        steps: [{ id: 'list', route: 'items.list', input: null }],
      },
    });
    await expect(
      client.call('autoapp.workflowPromote', {
        id: saved.id,
        page: 'items',
        afterComponentId: 'not-there',
        label: 'Add one',
      }),
    ).rejects.toThrow(/no longer exists/);
    await client.close();
  }, 20_000);

  test('an addition whose anchor a later release removed is a conflict, not a crash', async () => {
    const world = build();
    const quiet = { warn: () => undefined, error: () => undefined };
    // Promote against the current views, then serve a release that has lost the
    // anchor — which is what an update can do to somebody's customisation.
    const first = createAutoappHost({
      dataDir: directory,
      views,
      store: world.store,
      contract: exported,
      app: world.app as HostApp<AnyContract>,
      isAttached: () => true,
      logger: quiet,
    });
    const saved = world.store.saveWorkflow({
      name: 'Add one',
      definition: parseWorkflow(
        { version: 1, params: [], onFailure: 'stop', steps: [{ id: 'list', route: 'items.list', input: null }] },
        exported,
      ),
    });
    live = await harness((bridge) => {
      world.app.mount(bridge);
      first.mount(bridge);
    });
    const client = await live.connect(merged);
    await client.call('autoapp.workflowPromote', {
      id: saved.id,
      page: 'items',
      afterComponentId: 'intro',
      label: 'Add one',
    });
    await client.close();
    await live.stop();
    live = null;

    const withoutIntro: ViewsSpec = {
      ...views,
      pages: views.pages.map((page) => ({
        ...page,
        children: page.children.filter((child) => child.id !== 'intro'),
      })),
    };
    const second = createAutoappHost({
      dataDir: directory,
      views: withoutIntro,
      store: world.store,
      contract: exported,
      app: world.app as HostApp<AnyContract>,
      isAttached: () => true,
      logger: quiet,
    });
    live = await harness((bridge) => {
      world.app.mount(bridge);
      second.mount(bridge);
    });
    const after = await live.connect(merged);
    const shown = await after.call('autoapp.viewsGet', undefined);
    expect(shown.conflicts).toEqual([
      { componentId: `wf-${saved.id}`, reason: 'component intro no longer exists' },
    ]);
    // Kept, not dropped: a later release may bring the anchor back.
    expect((await after.call('autoapp.overridesGet', undefined)).additions).toHaveLength(1);
    await after.close();
  }, 20_000);

  /** Poll `approvalsList` until something is waiting. */
  async function waitForPending(client: {
    call(route: 'autoapp.approvalsList', input: undefined): Promise<{ pending: readonly { requestId: string; route: string; releaseId: string; argumentsHash: string }[] }>;
  }): Promise<{ requestId: string; route: string; releaseId: string; argumentsHash: string }> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { pending } = await client.call('autoapp.approvalsList', undefined);
      const first = pending[0];
      if (first !== undefined) return first;
      await Bun.sleep(10);
    }
    throw new Error('nothing ever asked for approval');
  }
});

describe('the merged contract export', () => {
  test('carries both route tables, so a promoted button checks out', () => {
    const both = withAutoappRoutes(exported);
    expect(both.operations['items.add']).toBeDefined();
    expect(both.operations['autoapp.workflowRun']?.effect).toBe('write');
    // The application's own export is untouched.
    expect(exported.operations['autoapp.workflowRun']).toBeUndefined();
  });

  test('the reserved host app is the only thing that may serve autoapp routes', () => {
    // An application declaring the group is refused where it enters the host.
    const sneaky = defineContract({
      operations: {
        'autoapp.workflowRun': { effect: 'read', summary: 'no', input: s.void(), output: s.void() },
      },
      streams: {},
    });
    expect(() => createHostApp(sneaky)).toThrow(/reserved/);
    expect(() => createReservedHostApp(sneaky)).not.toThrow();
  });
});
