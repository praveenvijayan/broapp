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

/**
 * The Backlog panel's rows.
 *
 * Written out rather than imported from `intent/types.ts` for the reason
 * `STAGE_NAMES` is: the page bundles this contract. A test holds the lists
 * equal.
 */
export const INTENT_STATUS_NAMES = ['draft', 'running', 'stopped', 'done', 'withdrawn'] as const;
export const TASK_STATUS_NAMES = [
  'proposed',
  'in-queue',
  'in-progress',
  'needs-answer',
  'completed',
  'failed',
  'interrupted',
  'removed',
] as const;

const taskStatus = s.enum([...TASK_STATUS_NAMES, 'blocked']);
const texts = (max: number, items: number): Schema<string[]> => s.array(s.string({ max }), { max: items });

const intentSummary = s.object({
  id: count,
  appId: s.string({ max: 40 }),
  status: s.enum(INTENT_STATUS_NAMES),
  restated: s.string({ max: 4_000 }),
  createdAt: count,
  /** `null` while the engineer is still writing the plan. */
  submittedAt: s.nullable(count),
  counts: s.object({
    proposed: count,
    'in-queue': count,
    'in-progress': count,
    'needs-answer': count,
    completed: count,
    failed: count,
    interrupted: count,
    removed: count,
    blocked: count,
  }),
});

const intentRecord = s.object({
  id: count,
  appId: s.string({ max: 40 }),
  request: s.string({ max: 100_000 }),
  restated: s.nullable(s.string({ max: 4_000 })),
  fits: s.nullable(s.string({ max: 4_000 })),
  conflicts: texts(1_000, 50),
  outOfReach: texts(1_000, 50),
  assumptions: texts(1_000, 50),
  questions: texts(1_000, 50),
  status: s.enum(INTENT_STATUS_NAMES),
  proposedByRun: s.nullable(s.string({ max: 200 })),
  hubModel: s.nullable(s.string({ max: 200 })),
  createdAt: count,
  submittedAt: s.nullable(count),
  startedAt: s.nullable(count),
  endedAt: s.nullable(count),
  stopReason: s.nullable(s.string({ max: 2_000 })),
});

const taskEvent = s.object({
  id: count,
  at: count,
  from: s.nullable(s.enum(TASK_STATUS_NAMES)),
  to: s.enum(TASK_STATUS_NAMES),
  note: s.string({ max: 2_000 }),
});

const taskRecord = s.object({
  id: count,
  intentId: count,
  appId: s.string({ max: 40 }),
  seq: count,
  slug: s.string({ max: 80 }),
  title: s.string({ max: 200 }),
  priority: s.string({ max: 20 }),
  labels: texts(20, 10),
  blockedBy: texts(80, 20),
  estimatedLines: count,
  locks: texts(100, 10),
  risk: s.string({ max: 20 }),
  stub: s.boolean(),
  repaidBy: s.nullable(s.string({ max: 80 })),
  summary: s.string({ max: 1_000 }),
  criteria: s.array(
    s.object({ id: s.string({ max: 8 }), text: s.string({ max: 400 }), failure: s.boolean(), passed: s.optional(s.boolean()) }),
    { max: 10 },
  ),
  noFailurePath: s.nullable(s.string({ max: 400 })),
  nonFunctional: texts(400, 10),
  testNotes: texts(400, 10),
  runbook: texts(400, 10),
  reasoning: s.string({ max: 20 }),
  tier: s.enum(['light', 'standard', 'deep']),
  tierReasons: texts(200, 10),
  modelOverride: s.nullable(s.string({ max: 200 })),
  stored: s.enum(TASK_STATUS_NAMES),
  status: taskStatus,
  waitingOn: texts(80, 20),
  /** What the task will run on: its override, its tier's model, or `null` for Settings. */
  model: s.nullable(s.string({ max: 200 })),
  /**
   * The runbook lines, by index, that name an `external` route: only the
   * activated application runs one. Absent from a launcher that does not work
   * it out.
   */
  afterActivating: s.optional(s.array(count, { max: 20 })),
  attempts: count,
  revBefore: s.nullable(s.string({ max: 80 })),
  revAfter: s.nullable(s.string({ max: 80 })),
  releaseId: s.nullable(s.string({ max: 64 })),
  actualLines: s.nullable(count),
  runIds: texts(200, 100),
  failure: s.unknown(),
  advice: s.unknown(),
  question: s.nullable(s.string({ max: 4_000 })),
  answers: s.array(s.object({ question: s.string({ max: 4_000 }), answer: s.string({ max: 4_000 }), at: count }), { max: 100 }),
  startedAt: s.nullable(count),
  endedAt: s.nullable(count),
  events: s.array(taskEvent, { max: 1_000 }),
});

/** A question a backlog run put to the person, answered through `ai.chatConfirm`. */
const runQuestion = s.object({
  runId: s.string({ max: 200 }),
  callId: s.string({ max: 200 }),
  tool: s.string({ max: 100 }),
  input: s.unknown(),
  askedAt: count,
  expiresAt: count,
});

/** The stages a builder's turn moves through; a test holds it equal to the executor's. */
export const RUN_STAGE_NAMES = ['reading', 'editing', 'building', 'checking'] as const;

/** Where a running intent is, kept in memory by the executor and derived when read. */
const runProgressFields = {
  taskId: count,
  runId: s.string({ max: 200 }),
  attempt: count,
  startedAt: count,
  lastTool: s.nullable(s.string({ max: 100 })),
  lastToolAt: s.nullable(count),
  approvals: count,
  stage: s.enum(RUN_STAGE_NAMES),
  turn: count,
  maxTurns: count,
  maxAttempts: count,
  /** The last tool call or result, or the turn's start. */
  quietSince: count,
  idleLimitMs: count,
  turnLimitMs: count,
  filesChanged: count,
  criteria: s.object({ passed: count, total: count }),
  lastRefusal: s.nullable(s.object({ tool: s.string({ max: 100 }), reason: s.string({ max: 400 }) })),
  /** What the turn has used so far, from its completed steps. */
  tokens: s.object({ input: count, output: count }),
};

const runProgress = s.object({
  ...runProgressFields,
  /** The question waiting for the person, if the run brought one to them. */
  question: s.nullable(runQuestion),
});

/**
 * A total, said honestly: `cost` is `null` when nothing in it is priced,
 * `atLeast` when a partial row or a running turn is in it, and
 * `unpricedTokens` the tokens of models nobody priced, which `cost` leaves out.
 */
const spendTotal = s.object({
  inputTokens: count,
  outputTokens: count,
  cost: s.nullable(s.number({ min: 0 })),
  atLeast: s.boolean(),
  unpricedTokens: count,
});

export const NEEDS_YOU_KINDS = ['question', 'answer', 'advice', 'activate'] as const;
export const RUN_EVENT_KINDS = ['task-completed', 'task-failed', 'turn-limit', 'run-ended', 'provider-error'] as const;

const needsYouItem = s.object({
  key: s.string({ max: 300 }),
  kind: s.enum(NEEDS_YOU_KINDS),
  appId: s.string({ max: 40 }),
  title: s.string({ max: 80 }),
  detail: s.string({ max: 400 }),
  at: count,
  expiresAt: s.nullable(count),
  target: s.object({
    panel: s.enum(['backlog', 'candidate']),
    appId: s.string({ max: 40 }),
    intentId: s.nullable(count),
    taskId: s.nullable(count),
    releaseId: s.nullable(s.string({ max: 64 })),
  }),
});

const runEvent = s.object({
  key: s.string({ max: 300 }),
  kind: s.enum(RUN_EVENT_KINDS),
  appId: s.string({ max: 40 }),
  intentId: count,
  runId: s.nullable(s.string({ max: 200 })),
  taskSlug: s.nullable(s.string({ max: 80 })),
  text: s.string({ max: 2_000 }),
  at: count,
});

const priceRow = s.object({
  modelId: s.string({ min: 1, max: 200 }),
  input: s.number(),
  output: s.number(),
});

const modelChoice = s.nullable(s.string({ min: 1, max: 200 }));
const tierModels = s.object({ light: modelChoice, standard: modelChoice, deep: modelChoice });

const appSummary = s.object({
  appId: s.string({ max: 40 }),
  name: s.string({ max: 200 }),
  currentRelease: s.nullable(s.string({ max: 64 })),
  serving: s.boolean(),
  pid: s.nullable(s.number()),
  schemaVersion: s.nullable(s.number()),
  /** True while an activation for this application is unfinished in the journal. */
  activationPending: s.boolean(),
  /**
   * Where its source workspace is, and whether it is there (19a). `dir` is
   * `null` for a workspace in the launcher's own folder: the page has nothing
   * to do with that path. A new field, so a page built before 19a, which
   * parses with the object schema's known keys only, reads the rest unchanged.
   */
  workspace: s.object({
    chosen: s.boolean(),
    dir: s.nullable(s.string({ max: 1_100 })),
    state: s.enum(['present', 'missing', 'not-a-directory', 'unreadable', 'denied']),
  }),
});

/** One application on the overview: its row, its state and its candidate's own checks. */
const appBlock = s.object({
  appId: s.string({ max: 40 }),
  name: s.string({ max: 200 }),
  currentRelease: s.nullable(s.string({ max: 64 })),
  serving: s.boolean(),
  pid: s.nullable(s.number()),
  schemaVersion: s.nullable(s.number()),
  activationPending: s.boolean(),
  state: s.enum(['serving', 'stopped', 'building', 'needs-review']),
  checks: s.nullable(s.object({ passed: count, total: count })),
  changedAt: s.nullable(count),
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
      output: s.object({
        apps: s.array(appSummary, { max: 500 }),
        /**
         * The application the person last chose, when it is still listed:
         * what the page selects when it opens, so the panels and the next
         * turn start on the same one.
         */
        selected: s.optional(s.nullable(s.string({ max: 40 }))),
      }),
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
        /**
         * The folder the workspace is made in, as `<location>/<appId>`. Absent
         * is the launcher's own folder, exactly as before 19a. A person's
         * choice only: the engineer's `apps.create` has no such field.
         */
        location: s.optional(s.string({ min: 1, max: 1_024 })),
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
        /**
         * Where a workspace the person chose was left, untouched, or `null`
         * for one in the launcher's own folder, which moved with the rest.
         */
        workspaceLeftAt: s.nullable(s.string({ max: 1_100 })),
      }),
      summary:
        'Move an application’s directory — its releases, its source workspace and its data — to the launcher’s trash. A workspace in a folder the person chose is left where it is.',
    },
    'launcher.locationCheck': {
      // A read: it looks at a folder and writes nothing, takes no lock, and is
      // what the form asks before Create is pressed.
      effect: 'read',
      input: s.object({
        appId: s.string({ min: 1, max: 40 }),
        location: s.string({ min: 1, max: 1_024 }),
      }),
      output: s.object({
        ok: s.boolean(),
        target: s.nullable(s.string({ max: 1_100 })),
        problem: s.nullable(s.string({ max: 600 })),
      }),
      summary: 'Whether an application could be created in a folder, and where its workspace would be.',
    },
    'launcher.appLocate': {
      // A write: it rewrites the pointer that says where the workspace is.
      effect: 'write',
      input: s.object({
        appId: s.string({ min: 1, max: 40 }),
        /** The workspace itself, not its parent. */
        sourceDir: s.string({ min: 1, max: 1_024 }),
      }),
      output: s.object({ dir: s.string({ max: 1_100 }) }),
      summary: 'Say where an application’s workspace went, when it was moved or renamed.',
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
    'launcher.quit': {
      // A person's route and nobody else's: no engineer tool reaches it, MCP
      // reaches applications and never the launcher's own routes, and the
      // route itself refuses every channel but `user`.
      effect: 'write',
      input: s.void(),
      output: s.object({ stopping: s.boolean() }),
      summary: 'Stop the launcher and every application it is serving.',
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
    'launcher.intentsList': {
      effect: 'read',
      input: s.object({
        appId: s.optional(s.string({ max: 40 })),
        limit: s.optional(s.number({ int: true, min: 1, max: 100 })),
      }),
      output: s.object({ intents: s.array(intentSummary, { max: 100 }) }),
      summary: 'The backlog, newest first: each request and how many of its tasks are in each status.',
    },
    'launcher.intentGet': {
      effect: 'read',
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({ intent: intentRecord, tasks: s.array(taskRecord, { max: 200 }), run: s.nullable(runProgress) }),
      summary: 'One request in full: what it was understood to be, its tasks in the order they run, and where its run is.',
    },
    'launcher.intentRunning': {
      effect: 'read',
      input: s.void(),
      output: s.object({
        run: s.nullable(s.object({ intentId: count, appId: s.string({ max: 40 }), waiting: s.boolean() })),
      }),
      summary: 'Which backlog is running, if any, and whether it is waiting for the person.',
    },
    'launcher.intentRun': {
      // The person starting a run, behind a confirmation that says what the
      // run's standing answer covers. The engineer's `intent.start` reaches the
      // same function and asks first.
      effect: 'write',
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({ started: s.boolean(), tasks: count }),
      summary: 'Start or resume building a reviewed backlog.',
    },
    'launcher.intentStop': {
      effect: 'write',
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({ stopped: s.boolean() }),
      summary: 'Stop a backlog run: the task in hand is interrupted.',
    },
    'launcher.intentAnswer': {
      effect: 'write',
      input: s.object({
        taskId: s.number({ int: true, min: 1 }),
        answer: s.string({ min: 1, max: 1_000 }),
        by: s.string({ min: 1, max: 80 }),
      }),
      output: s.object({ status: s.enum(TASK_STATUS_NAMES) }),
      summary: 'Answer a question a builder, or the advice on a failed task, put to the person.',
    },
    'launcher.intentPlan': {
      effect: 'read',
      input: s.object({ taskId: s.number({ int: true, min: 1 }) }),
      output: s.object({ markdown: s.string({ max: 40_000 }) }),
      summary: 'One task’s plan, as markdown.',
    },
    'launcher.intentModelsGet': {
      effect: 'read',
      input: s.void(),
      output: tierModels,
      summary: 'Which model runs a task of each tier; null is the model chosen in Settings.',
    },
    'launcher.intentTaskModel': {
      // A person's choice, and a write: it changes what a task will run on.
      // No engineer tool names this or any other backlog write.
      effect: 'write',
      input: s.object({ taskId: s.number({ int: true, min: 1 }), modelId: modelChoice }),
      output: s.object({ model: s.nullable(s.string({ max: 200 })) }),
      summary: 'Choose the model one task runs on, or clear the choice so its tier decides.',
    },
    'launcher.intentTaskRemove': {
      effect: 'write',
      input: s.object({ taskId: s.number({ int: true, min: 1 }) }),
      output: s.object({ status: s.enum(TASK_STATUS_NAMES) }),
      summary: 'Remove a task that has not started and that no other task depends on.',
    },
    'launcher.intentWithdraw': {
      effect: 'write',
      input: s.object({ id: s.number({ int: true, min: 1 }) }),
      output: s.object({ status: s.enum(INTENT_STATUS_NAMES) }),
      summary: 'Withdraw a request that is not running; every task it has not completed is removed.',
    },
    'launcher.overview': {
      effect: 'read',
      input: s.void(),
      output: s.object({
        needsYou: s.array(needsYouItem, { max: 500 }),
        running: s.nullable(
          s.object({
            ...runProgressFields,
            appId: s.string({ max: 40 }),
            appName: s.string({ max: 200 }),
            intentId: count,
            taskSlug: s.string({ max: 80 }),
            taskTitle: s.string({ max: 200 }),
            taskIndex: count,
            taskCount: count,
            modelId: s.nullable(s.string({ max: 200 })),
          }),
        ),
        spend: s.object({
          task: s.nullable(spendTotal),
          run: s.nullable(spendTotal),
          today: spendTotal,
          budgetDay: s.nullable(s.number({ min: 0 })),
          todayByModel: s.array(
            s.object({
              modelId: s.nullable(s.string({ max: 200 })),
              inputTokens: count,
              outputTokens: count,
              cost: s.nullable(s.number({ min: 0 })),
              atLeast: s.boolean(),
            }),
            { max: 500 },
          ),
        }),
        backlog: s.array(
          s.object({
            appId: s.string({ max: 40 }),
            appName: s.string({ max: 200 }),
            intentIds: s.array(count, { max: 100 }),
            done: count,
            failed: count,
            running: count,
            queued: count,
            blocked: count,
            total: count,
            estimate: s.nullable(s.object({ ms: count, tokens: count, estimate: s.boolean() })),
          }),
          { max: 500 },
        ),
        apps: s.array(appBlock, { max: 500 }),
        recent: s.array(runEvent, { max: 50 }),
      }),
      summary:
        'What needs the person, what is running and at what stage, what it has cost, what is left, and what each application is doing.',
    },
    'launcher.pricesGet': {
      effect: 'read',
      input: s.void(),
      output: s.object({ models: s.array(priceRow, { max: 200 }), budgetDay: s.nullable(s.number({ min: 0 })) }),
      summary: 'What each model costs per million tokens, as the person wrote it, and the daily budget.',
    },
    'launcher.pricesSet': {
      // A person's own figures. The launcher never sets or fetches a price.
      effect: 'write',
      input: s.object({
        // Wider than the file may be, so the refusal that names the limit comes
        // from `writePrices` rather than from the schema.
        models: s.array(priceRow, { max: 1_000 }),
        budgetDay: s.nullable(s.number()),
      }),
      output: s.object({ models: s.array(priceRow, { max: 200 }), budgetDay: s.nullable(s.number({ min: 0 })) }),
      summary: 'Replace what each model costs and the daily budget. Shown, never enforced.',
    },
    'launcher.intentModelsSet': {
      effect: 'write',
      input: tierModels,
      output: tierModels,
      summary: 'Choose which model runs a task of each tier.',
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
