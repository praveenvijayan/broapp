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

/** One row of the launcher's log, as `launcher.eventsList` returns it. */
const eventRow = s.object({
  id: s.number({ int: true, min: 1 }),
  at: s.number({ int: true, min: 0 }),
  level: s.string({ max: 16 }),
  source: s.string({ max: 200 }),
  kind: s.string({ max: 40 }),
  appId: s.nullable(s.string({ max: 40 })),
  runId: s.nullable(s.string({ max: 64 })),
  message: s.string({ max: 4_000 }),
  data: s.nullable(s.unknown()),
});

/**
 * The Knowledge panel's rows.
 *
 * Bounds are generous on text a person wrote or a model produced, because a
 * refusal of a row the store already holds would hide it; the store is what
 * limits what goes in, and `review.ts` what a person may write.
 */
const count = s.number({ int: true, min: 0 });

const turnRow = {
  runId: s.string({ max: 200 }),
  appId: s.nullable(s.string({ max: 40 })),
  at: s.number({ int: true, min: 0 }),
  corpusVersion: count,
  request: s.nullable(s.string({ max: 400 })),
  words: s.array(s.string({ max: 200 }), { max: 16 }),
  documents: s.array(
    s.object({ ref: s.string({ max: 200 }), title: s.string({ max: 300 }), bytes: count, truncated: s.boolean() }),
    { max: 20 },
  ),
  servings: s.array(
    s.object({ lessonId: count, how: s.string({ max: 20 }), included: s.boolean(), outcome: s.string({ max: 20 }) }),
    { max: 100 },
  ),
  counts: s.object({ edits: count, builds: count, checks: count, casesOpened: count, casesResolved: count }),
  run: s.nullable(s.object({ steps: count, ms: s.nullable(count), status: s.string({ max: 20 }) })),
};

const LESSON_STATUSES = ['provisional', 'confirmed', 'superseded', 'retired'] as const;

const lessonRow = s.object({
  id: count,
  status: s.string({ max: 20 }),
  review: s.nullable(s.string({ max: 60 })),
  origin: s.string({ max: 20 }),
  diagnosis: s.nullable(s.string({ max: 40 })),
  scope: s.string({ max: 60 }),
  applies: s.unknown(),
  summary: s.string({ max: 4_000 }),
  createdAt: count,
  reviewedBy: s.nullable(s.string({ max: 200 })),
  served: s.object({
    resolved: count,
    recurred: count,
    blocked: count,
    inconclusive: count,
    unrelated: count,
    none: count,
    open: count,
    notIncluded: count,
  }),
});

const lessonServing = s.object({
  runId: s.string({ max: 200 }),
  how: s.string({ max: 20 }),
  included: s.boolean(),
  servedAt: count,
  outcome: s.nullable(s.string({ max: 20 })),
  attemptKind: s.nullable(s.string({ max: 20 })),
  attemptCallId: s.nullable(s.string({ max: 200 })),
  attemptRelease: s.nullable(s.string({ max: 64 })),
  attemptAt: s.nullable(count),
});

const lessonRecord = s.object({
  id: count,
  version: count,
  status: s.string({ max: 20 }),
  review: s.nullable(s.string({ max: 60 })),
  origin: s.string({ max: 20 }),
  diagnosis: s.nullable(s.string({ max: 40 })),
  scope: s.string({ max: 60 }),
  applies: s.unknown(),
  summary: s.string({ max: 4_000 }),
  detail: s.string({ max: 20_000 }),
  trigger: s.string({ max: 4_000 }),
  instructionsHash: s.string({ max: 64 }),
  autoappVersion: s.string({ max: 40 }),
  createdAt: count,
  updatedAt: count,
  reviewedBy: s.nullable(s.string({ max: 200 })),
  reviewedAt: s.nullable(count),
  supersedes: s.nullable(count),
  supersededBy: s.nullable(count),
  provenance: s.nullable(
    s.object({
      episodeId: count,
      appId: s.string({ max: 40 }),
      stage: s.string({ max: 20 }),
      problem: s.string({ max: 20_000 }),
      request: s.nullable(s.string({ max: 100_000 })),
      sourceRevBefore: s.string({ max: 80 }),
      sourceRevAfter: s.nullable(s.string({ max: 80 })),
      releaseBefore: s.nullable(s.string({ max: 64 })),
      releaseAfter: s.nullable(s.string({ max: 64 })),
      diagnosis: s.nullable(s.string({ max: 40 })),
      reasoning: s.nullable(s.string({ max: 4_000 })),
    }),
  ),
  servings: s.array(lessonServing, { max: 500 }),
});

const caseRow = {
  id: count,
  appId: s.string({ max: 40 }),
  stage: s.string({ max: 20 }),
  signature: s.string({ max: 64 }),
  problem: s.string({ max: 20_000 }),
  openedAt: count,
  resolvedAt: s.nullable(count),
  diagnosis: s.nullable(s.string({ max: 40 })),
  distillState: s.string({ max: 20 }),
  lessonId: s.nullable(count),
  edits: count,
};

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

/**
 * A build's stages, in `BUILD_STAGES` order.
 *
 * Written out rather than imported from `candidate.ts`: this contract is
 * bundled into the launcher's page, and that module reaches `node:fs` and the
 * bundler. A test holds the two lists equal.
 */
export const STAGE_NAMES = ['spec', 'contract', 'views', 'page', 'host'] as const;

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
    'launcher.appCreate': {
      // A write, like `appOpen`: a person's own click, and it ends by opening a
      // tab. The engineer reaches the same function through `apps.create`,
      // which asks first because it arrives on channel `ai`.
      effect: 'write',
      input: s.object({
        appId: s.string({ min: 3, max: 40 }),
        name: s.string({ min: 1, max: 200 }),
        description: s.optional(s.string({ max: 400 })),
        /** Which starter to write. Absent is `starter`, so nothing existing changes. */
        template: s.optional(s.enum(['starter', 'blank'])),
      }),
      output: s.object({
        ok: s.boolean(),
        releaseId: s.nullable(s.string({ max: 64 })),
        installed: s.boolean(),
        problems: s.array(buildProblem, { max: 200 }),
        notes: s.array(s.string({ max: 400 }), { max: 20 }),
        opened: s.boolean(),
      }),
      summary:
        'Create an application from a starter, build it, make it current, and open it in a browser tab.',
    },
    'launcher.appRemove': {
      // A write, and a person's own. There is no engineer tool for this, so
      // the only way it arrives on channel `ai` at all is through the MCP
      // adapter or a workflow, where the gate asks as it does for any write.
      effect: 'write',
      input: s.object({
        appId: s.string({ min: 1, max: 40 }),
        // The id again, typed by the person. A confirmation that is a boolean
        // is a confirmation somebody can give by clicking the wrong row.
        confirm: s.string({ min: 1, max: 40 }),
      }),
      output: s.object({
        appId: s.string({ max: 40 }),
        trashPath: s.string({ max: 4_096 }),
        releases: s.number({ int: true, min: 0 }),
        hadSource: s.boolean(),
        dataBytes: s.number({ int: true, min: 0 }),
        snapshots: s.number({ int: true, min: 0 }),
        dataPrev: s.number({ int: true, min: 0 }),
        previewStopped: s.boolean(),
      }),
      summary:
        'Move an application’s directory — its releases, its source workspace and its data — to the launcher’s trash.',
    },
    'launcher.appOpen': {
      // A write: it may start a process and it opens a browser tab, which is
      // why only a person's own click reaches this route.
      effect: 'write',
      input: appIdInput,
      output: s.object({ opened: s.boolean() }),
      summary: 'Start an application if it is not running, and open it in a browser tab.',
    },
    'launcher.appSelect': {
      // A write: it changes what the engineer's next turn is about. The
      // person's row click; the engineer's own tools make the same choice from
      // the other side whenever they are called for an application.
      effect: 'write',
      input: appIdInput,
      output: s.object({ ok: s.boolean() }),
      summary: 'Remember which application the person is looking at, so the engineer’s next turn is about it.',
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
    'launcher.eventsList': {
      effect: 'read',
      input: s.object({
        limit: s.optional(s.number({ int: true, min: 1, max: 500 })),
        level: s.optional(s.enum(['warn', 'error'])),
        appId: s.optional(s.string({ max: 40 })),
        before: s.optional(s.number({ int: true, min: 1 })),
      }),
      output: s.object({
        events: s.array(eventRow, { max: 500 }),
        /** Events the log could not write since the launcher started. */
        dropped: s.number({ int: true, min: 0 }),
      }),
      summary: "The launcher's own log, newest first: what it did, warned about and failed at.",
    },
    'launcher.knowledgeTurns': {
      effect: 'read',
      input: s.object({
        limit: s.optional(s.number({ int: true, min: 1, max: 200 })),
        appId: s.optional(s.string({ max: 40 })),
      }),
      output: s.object({ turns: s.array(s.object(turnRow), { max: 200 }) }),
      summary: 'The engineer’s turns, newest first: what each was given, whether it was cut, and what came of each lesson.',
    },
    'launcher.knowledgeTurn': {
      effect: 'read',
      input: s.object({ runId: s.string({ min: 1, max: 200 }) }),
      output: s.object({
        turn: s.object({
          ...turnRow,
          texts: s.array(s.object({ ref: s.string({ max: 200 }), text: s.string({ max: 20_000 }), cut: s.boolean() }), {
            max: 20,
          }),
          instructions: s.object({ sha256: s.string({ max: 64 }), length: count }),
          systemLength: count,
        }),
      }),
      summary: 'One turn, with the text of every document it was given.',
    },
    'launcher.knowledgeLessons': {
      effect: 'read',
      input: s.object({
        status: s.optional(s.enum(LESSON_STATUSES)),
        review: s.optional(s.boolean()),
      }),
      output: s.object({ lessons: s.array(lessonRow, { max: 5_000 }) }),
      summary: 'Every lesson, with how its servings came out.',
    },
    'launcher.knowledgeLesson': {
      effect: 'read',
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({
        lesson: lessonRecord,
        blocked: count,
        unrelatedByStage: count,
        evidence: s.array(s.string({ max: 2_000 }), { max: 200 }),
      }),
      summary: 'One lesson: its text, where it came from, every serving, and what its replays found.',
    },
    'launcher.knowledgeCases': {
      effect: 'read',
      input: s.object({
        limit: s.optional(s.number({ int: true, min: 1, max: 200 })),
        appId: s.optional(s.string({ max: 40 })),
      }),
      output: s.object({ cases: s.array(s.object(caseRow), { max: 200 }) }),
      summary: 'The failures the engineer met and how they were repaired, newest first.',
    },
    'launcher.knowledgeCase': {
      effect: 'read',
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({
        case: s.object({
          ...caseRow,
          runId: s.string({ max: 200 }),
          request: s.nullable(s.string({ max: 100_000 })),
          editLog: s.string({ max: 10_000 }),
          reasoning: s.nullable(s.string({ max: 4_000 })),
          sourceRevBefore: s.string({ max: 80 }),
          sourceRevAfter: s.nullable(s.string({ max: 80 })),
          releaseBefore: s.nullable(s.string({ max: 64 })),
          releaseAfter: s.nullable(s.string({ max: 64 })),
        }),
      }),
      summary: 'One case in full: the problem, the request, the edits and the revisions either side.',
    },
    'launcher.lessonReview': {
      // A write, and a person's: it changes what the engineer is served from
      // the next turn on. No engineer tool names it, so on channel `ai` it
      // could only arrive through MCP or a workflow, and the gate would ask.
      effect: 'write',
      input: s.object({
        id: s.number({ int: true, min: 1 }),
        decision: s.enum(['confirm', 'retire']),
        by: s.string({ min: 1, max: 80 }),
      }),
      output: s.object({ changed: s.boolean(), status: s.string({ max: 20 }) }),
      summary: 'Confirm or retire a lesson, as `knowledge confirm` and `knowledge retire` do.',
    },
    'launcher.lessonWrite': {
      effect: 'write',
      input: s.object({
        // Wider than a lesson may be, so the refusal that names the field and
        // its limit comes from `writeLesson` rather than from the schema.
        summary: s.string({ max: 4_000 }),
        detail: s.string({ max: 20_000 }),
        trigger: s.string({ max: 4_000 }),
        scope: s.string({ max: 60 }),
        stage: s.optional(s.string({ max: 20 })),
        routes: s.optional(s.array(s.string({ max: 400 }), { max: 50 })),
        files: s.optional(s.array(s.string({ max: 400 }), { max: 50 })),
        supersedes: s.optional(s.number({ int: true, min: 1 })),
        by: s.string({ min: 1, max: 80 }),
      }),
      output: s.object({ id: count }),
      summary: 'Write a confirmed lesson by hand, or replace one with a corrected lesson that supersedes it.',
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
        /** The workspace has moved on since the release was built. */
        editsSinceBuild: s.boolean(),
        /** A preview was running and the launcher restarted since. */
        previewLost: s.boolean(),
        /** The checks ran on this release, in the preview that is running now. */
        checksVerified: s.boolean(),
        stagesRun: s.array(s.enum([...STAGE_NAMES]), { max: 5 }),
        /** The candidate's `page.html`, in bytes: what the browser receives on every open. */
        pageBytes: s.nullable(s.number({ int: true, min: 0 })),
        /** The same for the release that is serving, when there is one. */
        pageBytesBefore: s.nullable(s.number({ int: true, min: 0 })),
      }),
      summary: 'What the engineer has built and previewed for one application.',
    },
    'launcher.previewStart': {
      // A write, not a read: it copies the application's data and starts the
      // candidate's code in a child process. Opening a preview that is already
      // running stays `previewOpen`, which refuses when there is none.
      effect: 'write',
      input: appIdInput,
      output: s.object({ previewRunning: s.boolean() }),
      summary: 'Start the preview again for the candidate that was built.',
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
