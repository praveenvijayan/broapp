/**
 * Autoapp's own routes.
 *
 * A contract like any application's, with one difference: it owns the reserved
 * `autoapp` route group and is mounted as a *second* host app on the same
 * bridge, exactly as the AI layer is. That keeps an application's route table
 * free of Autoapp's routes, and lets an application that is not running on the
 * renderer carry none of this.
 *
 * Every route declares an effect, and the two that matter are `write`:
 * `approvalsAnswer` and `workflowRun`. Both are a person clicking, which the
 * gate allows on channel `user` — and both would need approval if an agent ever
 * reached them, which is exactly right.
 *
 * Nothing in this file may import from `../host/`. The browser bundles it, and
 * a bundler that followed such an import would try to pull `node:fs` into a
 * page. A test asserts that stays true.
 */
import { defineContract, s } from 'broapp/shared';
import type { Schema } from 'broapp/shared';

import type { Conflict, Override, Overrides } from '../views/overrides.ts';
import type { ViewsSpec } from '../views/types.ts';

/**
 * A value the host controls and the browser only displays.
 *
 * Deliberately not restated field by field. The authority on each of these
 * shapes is the parser the host runs before this ever sees a value, and a
 * second description here would be a second thing to keep in step. What the
 * contract guarantees is that it is an object — the browser's renderer trusts
 * the host, which is the one direction trust runs in a local application.
 */
function hostControlled<T>(name: string): Schema<T> {
  const self: Schema<T> = {
    kind: 'host-controlled',
    check: (value, path = []) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? { ok: true, value: value as T }
        : { ok: false, issues: [{ path, message: `expected ${name}` }] },
    parse(value) {
      const outcome = self.check(value, []);
      if (outcome.ok) return outcome.value;
      throw new Error(`expected ${name}`);
    },
    toJsonSchema: () => ({ type: 'object' }),
  };
  return self;
}

/** A JSON value a browser sent, whose shape the host checks for itself. */
const anyValue = s.unknown();

/** One person's change to one component. Bounded, because a browser sends it. */
const override = s.object({
  componentId: s.string({ min: 1, max: 100, pattern: /^[a-z][a-z0-9-]*$/ }),
  label: s.optional(s.string({ max: 200 })),
  hidden: s.optional(s.boolean()),
  headers: s.optional(hostControlled<Record<string, string>>('an object of column headers')),
  columnOrder: s.optional(s.array(s.string({ min: 1, max: 100 }), { max: 50 })),
}) as unknown as Schema<Override>;

const addition = s.object({
  id: s.string({ min: 1, max: 100 }),
  page: s.string({ min: 1, max: 100 }),
  afterComponentId: s.string({ min: 1, max: 100 }),
  component: hostControlled<Record<string, unknown>>('a component'),
});

const overrides = s.object({
  version: s.number({ int: true, min: 1, max: 1 }),
  items: s.array(override, { max: 500 }),
  additions: s.optional(s.array(addition, { max: 200 })),
}) as unknown as Schema<Overrides>;

const conflict = s.object({
  componentId: s.string({ max: 100 }),
  reason: s.string({ max: 400 }),
}) as unknown as Schema<Conflict>;

/** One question waiting for an answer, as a tab shows it. */
const approvalQuestion = s.object({
  requestId: s.string({ max: 200 }),
  channel: s.enum(['user', 'ai', 'mcp', 'workflow']),
  caller: s.string({ max: 200 }),
  appId: s.string({ max: 100 }),
  releaseId: s.string({ max: 64 }),
  route: s.string({ max: 200 }),
  effect: s.enum(['read', 'write', 'external']),
  input: s.optional(anyValue),
  argumentsHash: s.string({ max: 64 }),
});

/** One recorded run, as a list shows it. */
const runSummary = s.object({
  id: s.string({ max: 200 }),
  appId: s.string({ max: 100 }),
  releaseId: s.string({ max: 64 }),
  channel: s.string({ max: 40 }),
  caller: s.string({ max: 200 }),
  mode: s.string({ max: 20 }),
  status: s.enum(['running', 'succeeded', 'failed', 'cancelled', 'unknown']),
  startedAt: s.number(),
  endedAt: s.nullable(s.number()),
  summary: s.nullable(s.string({ max: 400 })),
});

/** One recorded call. */
const runStep = s.object({
  id: s.number(),
  runId: s.string({ max: 200 }),
  requestId: s.string({ max: 200 }),
  route: s.string({ max: 200 }),
  effect: s.string({ max: 20 }),
  input: s.optional(anyValue),
  argumentsHash: s.string({ max: 64 }),
  decision: s.string({ max: 20 }),
  outcome: s.nullable(s.string({ max: 20 })),
  output: s.optional(anyValue),
  error: s.nullable(s.string({ max: 1_000 })),
  startedAt: s.number(),
  endedAt: s.nullable(s.number()),
});

const workflowSummary = s.object({
  id: s.string({ max: 100 }),
  name: s.string({ max: 200 }),
  version: s.number(),
  updatedAt: s.number(),
  // Carried in the list so a page can build the form to run one without
  // fetching each definition separately.
  params: s.array(
    s.object({
      name: s.string({ max: 60 }),
      type: s.enum(['text', 'number', 'boolean']),
      label: s.string({ max: 200 }),
      required: s.optional(s.boolean()),
    }),
    { max: 50 },
  ),
});

const workflowStepResult = s.object({
  id: s.string({ max: 60 }),
  status: s.enum(['succeeded', 'failed', 'skipped', 'declined']),
  output: s.optional(anyValue),
  error: s.optional(s.string({ max: 1_000 })),
});

/** Autoapp's routes. Applications may not declare the `autoapp` group themselves. */
export const autoappContract = defineContract({
  operations: {
    'autoapp.overridesGet': {
      effect: 'read',
      input: s.void(),
      output: overrides,
      summary: 'This person’s own changes to the interface.',
    },
    'autoapp.overridesSet': {
      effect: 'write',
      input: overrides,
      output: s.object({ ok: s.boolean() }),
      summary: 'Replace this person’s changes to the interface.',
    },
    'autoapp.viewsGet': {
      effect: 'read',
      input: s.void(),
      output: s.object({
        views: hostControlled<ViewsSpec>('a view specification'),
        conflicts: s.array(conflict, { max: 500 }),
      }),
      summary: 'The interface this release describes, with this person’s changes applied.',
    },

    'autoapp.approvalsList': {
      effect: 'read',
      input: s.void(),
      output: s.object({ pending: s.array(approvalQuestion, { max: 200 }) }),
      summary: 'Everything an agent is waiting for permission to do.',
    },
    'autoapp.approvalsAnswer': {
      // A write, because it decides whether something happens. It is the
      // person's own click, which the gate allows on channel `user`; an agent
      // reaching it would have to be approved, which is the point.
      effect: 'write',
      input: s.object({
        requestId: s.string({ min: 1, max: 200 }),
        approved: s.boolean(),
        // Carried so the binding check runs: an answer has to be about the
        // question that was asked, on the release it was asked on.
        releaseId: s.string({ min: 1, max: 64 }),
        argumentsHash: s.string({ min: 1, max: 64 }),
      }),
      output: s.object({ result: s.enum(['accepted', 'unknown', 'mismatch']) }),
      summary: 'Answer one pending question.',
    },

    'autoapp.runsList': {
      effect: 'read',
      input: s.object({
        limit: s.optional(s.number({ int: true, min: 1, max: 500 })),
        before: s.optional(s.number()),
        /** Only these channels. Omitted means every channel, this person's own included. */
        channels: s.optional(s.array(s.enum(['user', 'ai', 'mcp', 'workflow']), { max: 4 })),
      }),
      output: s.object({ runs: s.array(runSummary, { max: 500 }) }),
      summary: 'What agents have done in this application.',
    },
    'autoapp.runGet': {
      effect: 'read',
      input: s.object({ id: s.string({ min: 1, max: 200 }) }),
      output: s.object({ run: runSummary, steps: s.array(runStep, { max: 1_000 }) }),
      summary: 'One run, with every call it made.',
    },

    'autoapp.workflowDraft': {
      effect: 'read',
      input: s.object({ runId: s.string({ min: 1, max: 200 }) }),
      output: s.object({ definition: hostControlled<unknown>('a workflow definition') }),
      summary: 'Draft a workflow from a run that worked.',
    },
    'autoapp.workflowSave': {
      effect: 'write',
      input: s.object({
        id: s.optional(s.string({ min: 1, max: 100 })),
        name: s.string({ min: 1, max: 200 }),
        definition: hostControlled<unknown>('a workflow definition'),
        fromRunId: s.optional(s.string({ max: 200 })),
      }),
      output: s.object({ id: s.string(), version: s.number() }),
      summary: 'Save a workflow, or a new version of one.',
    },
    'autoapp.workflowsList': {
      effect: 'read',
      input: s.void(),
      output: s.object({ workflows: s.array(workflowSummary, { max: 500 }) }),
      summary: 'Every saved workflow.',
    },
    'autoapp.workflowDelete': {
      effect: 'write',
      input: s.object({ id: s.string({ min: 1, max: 100 }) }),
      output: s.object({ removed: s.boolean() }),
      summary: 'Delete a saved workflow.',
    },
    'autoapp.workflowRun': {
      // A write from the person who clicked. Every *step* inside it is a fresh
      // `workflow`-channel request that asks again on its own account.
      effect: 'write',
      input: s.object({
        id: s.string({ min: 1, max: 100 }),
        params: s.optional(hostControlled<Record<string, unknown>>('the workflow’s parameters')),
      }),
      output: s.object({
        runId: s.string(),
        status: s.enum(['succeeded', 'failed', 'cancelled']),
        steps: s.array(workflowStepResult, { max: 200 }),
      }),
      summary: 'Run a saved workflow. Every step that changes anything asks again.',
    },
    'autoapp.workflowPromote': {
      effect: 'write',
      input: s.object({
        id: s.string({ min: 1, max: 100 }),
        page: s.string({ min: 1, max: 100 }),
        afterComponentId: s.string({ min: 1, max: 100 }),
        label: s.string({ min: 1, max: 200 }),
      }),
      output: s.object({ ok: s.boolean() }),
      summary: 'Add a saved workflow to the interface as a button or a form.',
    },
  },
  streams: {},
});

/** Autoapp's contract type, for `HostApp` and client generics. */
export type AutoappContract = typeof autoappContract;
