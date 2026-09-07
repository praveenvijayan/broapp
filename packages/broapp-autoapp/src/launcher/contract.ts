/**
 * The launcher's own routes.
 *
 * The launcher is a Broapp application like any other: one tab, one bridge, one
 * contract. What is unusual is what it is *about* — the other applications on
 * this computer — and that its writes are things a person clicks rather than
 * things an agent asks for. The engineer's own actions are tools, not routes,
 * and they go through the same gate from the other direction.
 *
 * `appOpen` and `previewOpen` open a browser tab from the host and say only
 * whether they managed to. A launch URL is a credential, and it never reaches
 * the launcher's own page: not because the page would keep it, but because a
 * tab the page opened would be refused. Brobridge's fence admits a document
 * request only with `Sec-Fetch-Site: same-origin` or `none`, and a navigation
 * from the launcher's origin to an application's — same host, another port —
 * arrives as `same-site`. Opened by the operating system, it arrives as
 * `none`, the way the launcher's own tab does. No tool returns a URL either.
 *
 * The launcher's tab is written as ordinary React rather than as a view
 * specification. It has to open browser tabs and show build problems, neither
 * of which the renderer can express — and it is Broapp's own trusted interface
 * rather than something an engineer proposes changes to.
 */
import { defineContract, s } from 'broapp/shared';
import type { Schema } from 'broapp/shared';

import type { Capability } from '../spec/types.ts';

const capability = s.object({
  kind: s.enum(['files', 'network', 'spawn']),
  paths: s.optional(s.array(s.string({ max: 4_096 }), { max: 200 })),
  access: s.optional(s.enum(['read', 'write'])),
  hosts: s.optional(s.array(s.string({ max: 253 }), { max: 200 })),
  reason: s.string({ max: 400 }),
}) as unknown as Schema<Capability>;

const appSummary = s.object({
  appId: s.string({ max: 40 }),
  name: s.string({ max: 200 }),
  currentRelease: s.nullable(s.string({ max: 64 })),
  serving: s.boolean(),
  pid: s.nullable(s.number()),
  schemaVersion: s.nullable(s.number()),
  /** True while an activation for this application is unfinished in the journal. */
  activationPending: s.boolean(),
});

const releaseSummary = s.object({
  releaseId: s.string({ max: 64 }),
  createdAt: s.number(),
  schemaVersion: s.number(),
  current: s.boolean(),
});

const activationRow = s.object({
  id: s.number(),
  fromRelease: s.nullable(s.string({ max: 64 })),
  toRelease: s.string({ max: 64 }),
  phase: s.string({ max: 40 }),
  startedAt: s.number(),
  updatedAt: s.number(),
  error: s.nullable(s.string({ max: 1_000 })),
});

const buildProblem = s.object({
  stage: s.enum(['contract', 'views', 'page', 'host', 'spec']),
  message: s.string({ max: 4_000 }),
});

const checkResult = s.object({
  id: s.string({ max: 100 }),
  title: s.string({ max: 200 }),
  passed: s.boolean(),
  detail: s.optional(s.string({ max: 2_000 })),
});

const appIdInput = s.object({ appId: s.string({ min: 1, max: 40 }) });

/** The launcher's routes. */
export const launcherContract = defineContract({
  operations: {
    'launcher.appsList': {
      effect: 'read',
      input: s.void(),
      output: s.object({ apps: s.array(appSummary, { max: 500 }) }),
      summary: 'Every application on this computer, and whether it is running.',
    },
    'launcher.appOpen': {
      // A write: it may start a process and it opens a browser tab, which is
      // why only a person's own click reaches this route.
      effect: 'write',
      input: appIdInput,
      output: s.object({ opened: s.boolean() }),
      summary: 'Start an application if it is not running, and open it in a browser tab.',
    },
    'launcher.appStop': {
      effect: 'write',
      input: appIdInput,
      output: s.object({ stopped: s.boolean() }),
      summary: 'Drain an application and shut it down.',
    },
    'launcher.releasesList': {
      effect: 'read',
      input: appIdInput,
      output: s.object({ releases: s.array(releaseSummary, { max: 500 }) }),
      summary: 'Every release of one application.',
    },
    'launcher.journalList': {
      effect: 'read',
      input: appIdInput,
      output: s.object({ activations: s.array(activationRow, { max: 200 }) }),
      summary: 'What has been activated for one application, and how it went.',
    },
    'launcher.grantsGet': {
      effect: 'read',
      input: appIdInput,
      output: s.object({
        releaseId: s.nullable(s.string({ max: 64 })),
        granted: s.array(capability, { max: 100 }),
        requested: s.array(capability, { max: 100 }),
      }),
      summary: 'What an application asks for, and what it has been allowed.',
    },
    'launcher.grantsSet': {
      effect: 'write',
      input: s.object({
        appId: s.string({ min: 1, max: 40 }),
        // The release the person was looking at. A grant is about a particular
        // set of requests, and if the release has changed since it was shown,
        // the answer is about a question nobody is asking any more.
        releaseId: s.string({ min: 32, max: 64 }),
        capabilities: s.array(capability, { max: 100 }),
      }),
      output: s.object({ ok: s.boolean() }),
      summary: 'Replace what an application is allowed to do.',
    },
    'launcher.candidateStatus': {
      effect: 'read',
      input: appIdInput,
      output: s.object({
        appId: s.string({ max: 40 }),
        releaseId: s.nullable(s.string({ max: 64 })),
        problems: s.array(buildProblem, { max: 200 }),
        changed: s.array(s.string({ max: 400 }), { max: 500 }),
        previewRunning: s.boolean(),
        checks: s.array(checkResult, { max: 200 }),
        addedCapabilities: s.array(capability, { max: 100 }),
        removedCapabilities: s.array(capability, { max: 100 }),
      }),
      summary: 'What the engineer has built and previewed for one application.',
    },
    'launcher.previewOpen': {
      effect: 'write',
      input: appIdInput,
      output: s.object({ opened: s.boolean() }),
      summary: 'Open the running preview in a browser tab.',
    },
    'launcher.activate': {
      // The person's own click. The engineer's `release.activate` tool reaches
      // the same function from the other side, and asks first because it is
      // `external` on channel `ai`.
      effect: 'write',
      input: s.object({
        appId: s.string({ min: 1, max: 40 }),
        releaseId: s.string({ min: 32, max: 64 }),
      }),
      output: s.object({
        ok: s.boolean(),
        previousRelease: s.optional(s.nullable(s.string({ max: 64 }))),
        /** Whether the activated release was opened in a browser tab. */
        opened: s.optional(s.boolean()),
        phase: s.optional(s.string({ max: 40 })),
        reason: s.optional(s.string({ max: 1_000 })),
      }),
      summary: 'Replace what this application is running with a candidate release.',
    },
  },
  streams: {},
});

/** The launcher's contract type. */
export type LauncherContract = typeof launcherContract;
