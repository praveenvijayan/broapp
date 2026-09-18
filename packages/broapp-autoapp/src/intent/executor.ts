/**
 * Running a backlog: one task, one turn, one model, the host in charge.
 *
 * The shape is hub and spoke. The hub is this file — deterministic code that
 * decides the order, the model, the time allowed, whether a task is finished
 * and when to stop — and, at the two places judgement is needed, the model
 * configured in Settings: asked once for advice when a task fails, and on the
 * person's next chat turn, where the backlog document tells it what happened.
 * Each spoke is one ordinary engineer turn on the task's own model, given that
 * task's plan and nothing else to do. No model supervises another: reports 08c
 * and 12j measured what a local model does with one long open-ended turn.
 *
 * A task is completed from evidence, never from a model saying so: the
 * workspace moved, a build of it is what the preview runs, and the checks on
 * that preview include a passing example for every criterion with nothing
 * else failing. {@link verdictOf} is that rule, and it is pure.
 *
 * While a run lasts, the executor answers the gate's questions as the
 * person's stand-in — the run's standing answer — for the edits, builds and
 * previews of its own application and for nothing else. The gate still asks
 * every question and records every answer. A question the standing answer does
 * not cover is put to the person in the Backlog panel and waits; activation and
 * creating an application are refused outright, because a builder has no
 * business with either.
 */
import { jsonSchema, streamObject, type LanguageModel } from 'ai';
import type { Ai, ChatEvent, InProcessQuestion } from 'broapp/ai/host';
import { publicError } from 'broapp/host';
import type { HostLogger } from 'broapp/host';
import { s } from 'broapp/shared';

import type { CandidateStatus, CandidateStates } from '../engineer/state.ts';
import { sourceRevision } from '../knowledge/ids.ts';
import { sanitise, type EventLog } from '../knowledge/log.ts';
import type { Layout } from '../spec/index.ts';

import { modelFor, readTierModels, type TierModels } from './models.ts';
import { exampleIdFor, renderPlan, validateGraph } from './plan.ts';
import type { IntentStore } from './store.ts';
import type { StoredTaskStatus, TaskRecord } from './types.ts';

/**
 * The run's standing answer: the tools a builder's turn is approved for
 * without asking, and only when the call names the run's own application.
 *
 * These are what building a task is made of. Not a grant — `launcher.grants*`
 * already means capabilities — and never activation or creation.
 */
export const INTENT_APPROVES: readonly string[] = [
  'source.edit',
  'source.change',
  'candidate.cycle',
  'candidate.build',
  'candidate.preview',
  'preview.stop',
];

/** Refused outright and never put to the person: a builder has no business with them. */
export const INTENT_REFUSES: readonly string[] = ['release.activate', 'apps.create'];

/** How long one builder's turn may take: the evaluation harness's figure. */
export const TASK_TURN_TIMEOUT_MS = 20 * 60_000;
/** How many attempts a task gets in one run before the run stops on it. */
export const TASK_MAX_ATTEMPTS = 2;
/**
 * How many turns a task gets in one run, however much each one improves.
 *
 * An attempt that passes more criteria than any before it in the run is not
 * counted against {@link TASK_MAX_ATTEMPTS}; this is what bounds that.
 */
export const TASK_MAX_TURNS = 4;
/**
 * How long a builder's turn may go without a tool call before it is ended.
 *
 * 13c's by-hand run spent twenty minutes on twelve reads and no edit. The
 * clock stops while a tool runs and while a question waits for the person:
 * what it measures is the model holding the turn in silence.
 */
export const TASK_IDLE_TIMEOUT_MS = 8 * 60_000;
/** How many questions a builder may ask about one task. */
export const MAX_QUESTIONS_PER_TASK = 2;

/** Why a run stopped when a forwarded question was never answered. */
export const QUESTION_EXPIRED = 'A question waited ten minutes without an answer.';
/** What the panel says once every task is built. */
export const RUN_FINISHED =
  'All tasks are built and checked in the candidate. Open the preview, look, then activate from the Candidate panel.';
/** What a third `intent.ask` about one task is told. */
export const DECIDE = 'Decide with what you have.';
/** What `intent.ask` returns. */
export const ASKED_NEXT = 'Stop now. The person will answer and the task will be run again.';

/** How the gate's question to a builder's turn is answered. */
export type StandingAnswer = boolean | 'defer';

/**
 * The run's standing answer to one question, as a pure rule.
 *
 * `true` for a listed tool whose input names `appId`; `false` for the two a
 * builder may never have; `'defer'` — put it to the person — for everything
 * else, including a listed tool naming another application.
 */
export function standingAnswer(appId: string, question: { readonly tool: string; readonly input: unknown }): StandingAnswer {
  if (INTENT_REFUSES.includes(question.tool)) return false;
  const named = (question.input as { appId?: unknown } | null | undefined)?.appId;
  if (INTENT_APPROVES.includes(question.tool) && named === appId) return true;
  return 'defer';
}

/** What {@link verdictOf} decided. */
export interface Verdict {
  readonly completed: boolean;
  /** One sentence per condition that did not hold; empty when completed. */
  readonly reasons: readonly string[];
  /** The criterion ids whose example ran and passed. */
  readonly passed: readonly string[];
}

/** How the turn ended, for the reasons a verdict gives. */
export interface TurnEnding {
  readonly timedOut?: boolean;
  /** The idle limit that ended the turn, in milliseconds, when one did. */
  readonly idleMs?: number;
  /** The sentence a turn that could not start or failed on the provider gave. */
  readonly error?: string;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The sentence a turn ended by the idle limit gets. */
export function idleSentence(ms: number): string {
  const minutes = ms / 60_000;
  const amount = Number.isInteger(minutes)
    ? plural(minutes, 'minute', 'minutes')
    : plural(Math.max(1, Math.round(ms / 1_000)), 'second', 'seconds');
  return `The turn made no tool call for ${amount}.`;
}

/**
 * Whether a task is finished, from evidence alone.
 *
 * Completed needs every one of: the workspace revision moved since before the
 * task's first turn; the last build has no problems; nothing was edited after
 * it; its checks ran on the preview that is running now; every check passed, so
 * no earlier task's example regressed; every example in `required` — those of
 * the application's finished tasks — is still there, so none was removed to
 * make that true; and for each criterion an example named `<slug>-<id>` ran.
 * The model's closing words are not an input.
 */
export function verdictOf(
  task: Pick<TaskRecord, 'slug' | 'criteria'>,
  status: Pick<CandidateStatus, 'releaseId' | 'problems' | 'editsSinceBuild' | 'checksVerified' | 'checks'>,
  revBefore: string,
  revNow: string,
  ending: TurnEnding = {},
  required: readonly string[] = [],
): Verdict {
  const reasons: string[] = [];
  if (revNow === revBefore) reasons.push('The workspace did not change.');
  if (status.releaseId === null && status.problems.length === 0) reasons.push('Nothing was built.');
  if (status.problems.length > 0) reasons.push(`The build has ${plural(status.problems.length, 'problem', 'problems')}.`);
  if (status.editsSinceBuild) reasons.push('The workspace changed after the last build.');
  if (!status.checksVerified) reasons.push('The checks did not run on the build the preview is running.');
  const failed = status.checks.filter((check) => !check.passed);
  for (const check of failed.slice(0, 5)) reasons.push(`The example ${check.id} failed.`);
  if (failed.length > 5) reasons.push(`${plural(failed.length - 5, 'more example', 'more examples')} failed.`);

  const byId = new Map(status.checks.map((check) => [check.id, check]));
  for (const id of required) {
    if (!byId.has(id)) reasons.push(`The example ${id}, from a finished task, is gone.`);
  }
  const passed: string[] = [];
  for (const criterion of task.criteria) {
    const id = exampleIdFor(task.slug, criterion.id);
    const check = byId.get(id);
    if (check === undefined) reasons.push(`No example named ${id} was run.`);
    else if (check.passed && status.checksVerified) passed.push(criterion.id);
  }
  if (reasons.length > 0) {
    if (ending.timedOut === true) reasons.push('The turn ran out of time.');
    if (ending.idleMs !== undefined) reasons.push(idleSentence(ending.idleMs));
    if (ending.error !== undefined) reasons.push(`The turn ended with an error: ${ending.error}`);
  }
  return { completed: reasons.length === 0, reasons, passed };
}

/** What the builder of one task is told: one message, no history. */
export function builderMessage(
  task: TaskRecord,
  lastReasons: readonly string[] = [],
): string {
  const ids = task.criteria.map((criterion) => exampleIdFor(task.slug, criterion.id));
  const parts = [
    `Application: ${task.appId}`,
    `Build this one task and nothing else. Add one acceptance example to autoapp.json for each criterion, with exactly these ids: ${ids.join(', ')}. Do not remove or rename an acceptance example that is already there. Use candidate.cycle until every check passes, then stop. Do not request activation. Do not plan or change the backlog.`,
    'If the plan leaves a real choice open that changes what you build, call intent.ask once with one question rather than guessing. Do not ask about anything the plan or the application already answers.',
    '',
    renderPlan(task).trimEnd(),
  ];
  if (task.answers.length > 0) {
    parts.push('', 'The person answered:');
    for (const pair of task.answers) parts.push(`- ${pair.question}`, `  ${pair.answer}`);
  }
  if (lastReasons.length > 0) {
    parts.push('', 'The last attempt ended with:');
    for (const reason of lastReasons) parts.push(`- ${reason}`);
  }
  return parts.join('\n');
}

/** The main model's reading of a failed task. */
export const ADVICE = s.object({
  diagnosis: s.string({ min: 1, max: 400 }),
  advice: s.enum(['retry', 'revise', 'split', 'ask']),
  note: s.string({ min: 1, max: 400 }),
});
export type Advice = ReturnType<typeof ADVICE.parse>;

const ADVICE_SYSTEM =
  'You planned a backlog, and one of its tasks failed twice in the hands of a builder. Read the plan and why it was not completed, and advise the person. retry: nothing in the plan is wrong and another run may pass. revise: the plan asks for something that cannot pass as written. split: the task is two tasks. ask: the person has to decide something first; say what in the note. The diagnosis says what went wrong in one or two sentences; the note is what you would tell the person. Do not include paths from this machine.';

/** How long the advice question may take. */
const ADVICE_TIMEOUT_MS = 60_000;

/** The advice question, as the model reads it. */
export function advicePrompt(task: TaskRecord, reasons: readonly string[], failures: readonly string[]): string {
  return [
    '# The task',
    renderPlan(task),
    '# Why it was not completed',
    ...reasons.map((reason) => `- ${reason}`),
    '# What the last change cycle still had wrong',
    ...(failures.length === 0 ? ['(nothing recorded)'] : failures.map((failure) => `- ${failure}`)),
    '# Your answer',
    'One JSON object and nothing else, matching this JSON Schema. `advice` is exactly one of: retry, revise, split, ask.',
    JSON.stringify(ADVICE.toJsonSchema()),
  ].join('\n');
}

/** Ask for advice and validate it, exactly as the distiller asks its question. */
async function askAdvice(model: LanguageModel, prompt: string, signal: AbortSignal): Promise<Advice> {
  const result = streamObject({
    model,
    schema: jsonSchema(ADVICE.toJsonSchema()),
    system: ADVICE_SYSTEM,
    prompt,
    abortSignal: signal,
    onError: () => undefined,
  });
  // `object` settles only once the stream has been read to its end.
  for await (const partial of result.partialObjectStream) void partial;
  return ADVICE.parse(await result.object);
}

/** Lines a task changed, from `git diff --shortstat`; `null` without git. */
function changedLines(sourceDir: string, from: string, to: string): number | null {
  if (from === 'no-git' || to === 'no-git') return null;
  const probe = Bun.spawnSync({ cmd: ['git', 'diff', '--shortstat', from, to], cwd: sourceDir, stdout: 'pipe', stderr: 'ignore' });
  if (probe.exitCode !== 0) return null;
  const text = new TextDecoder().decode(probe.stdout);
  const count = (pattern: RegExp): number => Number(pattern.exec(text)?.[1] ?? 0);
  return count(/(\d+) insertions?\(\+\)/) + count(/(\d+) deletions?\(-\)/);
}

/** Where the run is, for the panel. */
export interface RunProgress {
  readonly taskId: number;
  readonly attempt: number;
  readonly startedAt: number;
  readonly lastTool: string | null;
  readonly lastToolAt: number | null;
  readonly approvals: number;
}

/** A question the standing answer did not cover, waiting for the person. */
export interface RunQuestion {
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly askedAt: number;
  readonly expiresAt: number;
}

/** What {@link createExecutor} needs. */
export interface CreateExecutorOptions {
  readonly intents: IntentStore;
  /** A function, because the executor is built before `createAi` returns. */
  readonly ai: () => Ai;
  readonly states: CandidateStates;
  readonly layout: Layout;
  /** The tier-to-model mapping, read at each task. Defaults to the backlog's file. */
  readonly mapping?: () => TierModels;
  /** Where every move, start, stop and standing answer is written down. */
  readonly log?: EventLog;
  readonly logger?: HostLogger;
  /** How long a forwarded question waits, when the gate does not say. */
  readonly confirmTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly maxAttempts?: number;
  /** Turns a task may take in one run, however much each improves. */
  readonly maxTurns?: number;
  /** How long a turn may go without a tool call. */
  readonly idleTimeoutMs?: number;
}

/** The executor. One run per launcher, one task at a time. */
export interface Executor {
  /** Start or resume an intent's run; returns at once, the work continues in the host. */
  start(intentId: number, startedBy: string): Promise<{ readonly started: true; readonly tasks: number }>;
  /** Stop a run: the task in hand is interrupted and the intent stopped. */
  stop(intentId: number, by: string): { readonly stopped: boolean };
  /** Stop whatever runs, for the launcher's shutdown. */
  stopAll(by: string): void;
  /**
   * The sentence refusing a write to `appId` from `runId`, or `null`.
   *
   * While a run works on an application, only that run's own turns may write
   * to it. A click has no run id and is refused too.
   */
  busy(appId: string, runId: string | null): string | null;
  /** A builder's question: the task waits for the person, the run stops. */
  ask(runId: string, question: string): { readonly next: string };
  /** The run in hand, if any. */
  active(): { readonly intentId: number; readonly appId: string } | null;
  /** What the panel shows about an intent's run. */
  progress(intentId: number): { readonly run: RunProgress | null; readonly question: RunQuestion | null };
  /** Resolves when no run is active. */
  idle(): Promise<void>;
}

/** Why a turn was ended from outside. */
type Ending =
  | { readonly kind: 'stopped'; readonly by: string }
  | { readonly kind: 'asked'; readonly slug: string }
  | { readonly kind: 'expired' };

interface Active {
  readonly intentId: number;
  readonly appId: string;
  controller: AbortController | null;
  runId: string | null;
  taskId: number | null;
  run: RunProgress | null;
  questions: RunQuestion[];
  ending: Ending | null;
  /** The calls of this turn whose tool is running now. */
  inFlight: Set<string>;
  /** The turn's idle clock, while a turn runs. */
  clock: IdleClock | null;
}

/** A clock that ends a turn after a stretch with no tool call. */
interface IdleClock {
  /** Start the stretch again, or hold it while `paused` says so. */
  arm(): void;
  disarm(): void;
}

function idleClock(ms: number, paused: () => boolean, onIdle: () => void): IdleClock {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    arm() {
      disarm();
      if (!paused()) timer = setTimeout(onIdle, ms);
    },
    disarm,
  };
}

/** Whether a tool's output says one of its steps' questions expired. */
function saysExpired(output: unknown, depth = 0): boolean {
  if (typeof output !== 'object' || output === null || depth > 2) return false;
  const record = output as Record<string, unknown>;
  if (record['expired'] === true) return true;
  return Object.values(record).some((value) => saysExpired(value, depth + 1));
}

/** The statuses a run starts from, and puts back in the queue. */
const REQUEUED: readonly StoredTaskStatus[] = ['proposed', 'failed', 'interrupted'];

/** Build the executor. */
export function createExecutor(options: CreateExecutorOptions): Executor {
  const { intents: store, states, layout } = options;
  const logger: HostLogger = options.logger ?? console;
  const mapping = options.mapping ?? ((): TierModels => readTierModels(store.dataDir));
  const turnTimeoutMs = options.turnTimeoutMs ?? TASK_TURN_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? TASK_MAX_ATTEMPTS;
  const maxTurns = options.maxTurns ?? TASK_MAX_TURNS;
  const idleTimeoutMs = options.idleTimeoutMs ?? TASK_IDLE_TIMEOUT_MS;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 600_000;

  let current: Active | null = null;
  let loop: Promise<void> = Promise.resolve();

  /** One knowledge event, never a reason for the run to fail. */
  const note = (message: string, appId: string, runId?: string, callId?: string): void => {
    try {
      options.log?.event('log', message, undefined, {
        appId,
        ...(runId === undefined ? {} : { runId }),
        ...(callId === undefined ? {} : { callId }),
      });
    } catch (cause) {
      logger.error(`[autoapp] could not record a backlog run: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  };

  /** Move a task, and write the move down. */
  const move = (task: TaskRecord, to: StoredTaskStatus, why: string, runId?: string): TaskRecord => {
    const moved = store.moveTask(task.id, to, why, runId);
    note(`task ${task.slug}: ${task.stored} → ${to} (${why})`, task.appId, runId);
    return moved;
  };

  const stopIntent = (active: Active, reason: string): void => {
    try {
      store.setRun(active.intentId, 'stopped', reason);
      note(`intent ${String(active.intentId)} stopped: ${reason}`, active.appId);
    } catch (cause) {
      logger.error(`[autoapp] could not stop intent ${String(active.intentId)}: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  };

  /** The ids the provider offers, or `null` when the list cannot be read. */
  async function offered(): Promise<{ readonly ids: readonly string[]; readonly provider: string } | null> {
    try {
      const configured = await options.ai().registry.currentConfig();
      if (configured === null) return null;
      const models = await configured.adapter.models(configured.config, AbortSignal.timeout(20_000));
      return { ids: models.map((model) => model.modelId), provider: configured.adapter.label };
    } catch {
      return null;
    }
  }

  /** Ask the main model for advice on a failed task. Stores it, or nothing. */
  async function advise(task: TaskRecord, reasons: readonly string[]): Promise<void> {
    const failures = states.get(task.appId).cycle?.failures.map((failure) => failure.summary) ?? [];
    try {
      const model = await options.ai().model();
      const answer = await askAdvice(model, advicePrompt(task, reasons, failures), AbortSignal.timeout(ADVICE_TIMEOUT_MS));
      store.setAdvice(task.id, { ...answer, at: Date.now() });
      note(`task ${task.slug}: the main model advises ${answer.advice}`, task.appId);
    } catch (cause) {
      note(
        `task ${task.slug}: no advice could be read from the main model (${sanitise(String(cause instanceof Error ? cause.message : cause)).slice(0, 200)})`,
        task.appId,
      );
    }
  }

  /** The example ids of every task of `appId` already completed, which a later task may not lose. */
  function finishedExamples(appId: string): string[] {
    const ids: string[] = [];
    for (const intent of store.list({ appId, limit: Number.MAX_SAFE_INTEGER })) {
      for (const task of store.runOrder(intent.id)) {
        if (task.stored !== 'completed') continue;
        for (const criterion of task.criteria) ids.push(exampleIdFor(task.slug, criterion.id));
      }
    }
    return ids;
  }

  /** The stand-in: answer, refuse, or bring the question to the person. */
  function answerFor(active: Active, runId: string) {
    return (question: InProcessQuestion): StandingAnswer => {
      const decision = standingAnswer(active.appId, question);
      const where = `${active.appId} (intent ${String(active.intentId)})`;
      if (decision === true) {
        note(`the run's standing answer approved ${question.tool} for ${where}`, active.appId, runId, question.callId);
        return true;
      }
      if (decision === false) {
        note(`the run refused ${question.tool} for ${where}: a builder may not`, active.appId, runId, question.callId);
        return false;
      }
      const now = Date.now();
      active.questions.push({
        runId,
        callId: question.callId,
        tool: question.tool,
        input: question.input,
        askedAt: now,
        expiresAt: question.expiresAt ?? now + confirmTimeoutMs,
      });
      // The person's time to answer is not the model's silence.
      active.clock?.arm();
      note(`the run put ${question.tool} to the person for ${where}`, active.appId, runId, question.callId);
      return 'defer';
    };
  }

  /** Follow the turn: the last tool, the approvals, questions settling or expiring. */
  function followerFor(active: Active) {
    return (event: ChatEvent): void => {
      const run = active.run;
      const callId = event.callId ?? '';
      const parent = callId.split('.')[0] ?? callId;
      if (event.type === 'tool-call' && run !== null) {
        active.run = { ...run, lastTool: event.tool ?? null, lastToolAt: Date.now() };
      } else if (event.type === 'confirm' && run !== null) {
        active.run = { ...run, approvals: run.approvals + 1 };
      }
      // A running tool is not the model's silence either: the clock holds
      // while one runs, and starts again when its result goes back.
      if (event.type === 'tool-call') {
        active.inFlight.add(callId);
        active.clock?.arm();
      } else if (event.type === 'tool-result') {
        active.inFlight.delete(callId);
        active.clock?.arm();
      }
      if (event.type === 'tool-result' && event.tool === 'intent.ask' && active.ending?.kind === 'asked') {
        // The question is in; the turn has nothing left to do.
        active.controller?.abort(new Error('the builder asked the person'));
        return;
      }
      // A later event about the same call settles a forwarded question: its
      // result, or the next step's question inside a cycle.
      const settled = active.questions.filter((question) => {
        const own = question.callId.split('.')[0] ?? question.callId;
        if (event.type === 'tool-result') return own === parent;
        if (event.type === 'confirm' || event.type === 'tool-call') return own === parent && callId !== question.callId;
        return false;
      });
      if (settled.length === 0) return;
      active.questions = active.questions.filter((question) => !settled.includes(question));
      active.clock?.arm();
      if (event.type !== 'tool-result') return;
      // A refusal that arrives at the deadline is the deadline, not a person's
      // no: a person's Deny comes before the window closes.
      const expired =
        (event.denied === true || saysExpired(event.output)) &&
        settled.some((question) => Date.now() >= question.expiresAt - 1_000);
      if (expired && active.ending === null) {
        active.ending = { kind: 'expired' };
        active.controller?.abort(new Error(QUESTION_EXPIRED));
      }
    };
  }

  /**
   * The model a turn with no id of its own runs on, for a task's history: the
   * one chosen in Settings, by name. A history that says "the Settings model"
   * cannot say which model that was once Settings has changed.
   */
  async function settingsModelName(): Promise<string> {
    try {
      const id = (await options.ai().registry.settings()).modelId;
      return id === null ? 'the Settings model' : `the Settings model, ${id}`;
    } catch {
      return 'the Settings model';
    }
  }

  /** Run one task to completed, failed, interrupted or waiting; `true` when the run goes on. */
  async function runTask(active: Active, first: TaskRecord): Promise<boolean> {
    const sourceDir = layout.app(active.appId).source;
    let task = first;
    let lastReasons: readonly string[] = [];
    const runIds: string[] = [];
    // Attempts that count against `maxAttempts`, and the most criteria any
    // attempt of this run has passed: an attempt that gets further than every
    // one before it is not counted, up to `maxTurns` turns.
    let counted = 0;
    let best: number | null = null;
    for (let turn = 1; ; turn += 1) {
      const modelId = modelFor(task, mapping());
      if (modelId !== null) {
        const list = await offered();
        if (list !== null && !list.ids.includes(modelId)) {
          const reason = `The model ${modelId} is no longer offered by ${list.provider}.`;
          task = move(task, 'failed', reason);
          store.setFailure(task.id, { reasons: [reason], runIds, at: Date.now() });
          stopIntent(active, `${task.slug} failed: ${reason}`);
          return false;
        }
      }
      if (active.ending !== null) return finishEnded(active, task);

      // Numbered by turns, not by counted attempts: an interrupted attempt is
      // given back, and its run id must still never be used twice.
      const turnNumber = task.runIds.length + 1;
      const runId = `intent-${String(active.intentId)}-${task.slug}-a${String(turnNumber)}`;
      const revBefore = sourceRevision(sourceDir);
      if (task.revBefore === null) task = store.recordResult(task.id, { revBefore });
      task = move(task, 'in-progress', `turn ${String(turnNumber)} on ${modelId ?? (await settingsModelName())}`, runId);
      runIds.push(runId);
      const controller = new AbortController();
      active.controller = controller;
      active.runId = runId;
      active.taskId = task.id;
      active.questions = [];
      active.inFlight = new Set();
      active.run = { taskId: task.id, attempt: turnNumber, startedAt: Date.now(), lastTool: null, lastToolAt: null, approvals: 0 };

      const limit = AbortSignal.timeout(turnTimeoutMs);
      let idle = false;
      const clock = idleClock(
        idleTimeoutMs,
        () => active.inFlight.size > 0 || active.questions.length > 0,
        () => {
          idle = true;
          controller.abort(new Error(idleSentence(idleTimeoutMs)));
        },
      );
      active.clock = clock;
      clock.arm();
      let error: string | undefined;
      try {
        const result = await options.ai().turn(
          { runId, message: builderMessage(task, lastReasons), ...(modelId === null ? {} : { modelId }) },
          { answer: answerFor(active, runId), signal: AbortSignal.any([controller.signal, limit]), onEvent: followerFor(active) },
        );
        error = result.error;
      } finally {
        clock.disarm();
        active.clock = null;
        active.inFlight = new Set();
        active.controller = null;
        active.runId = null;
        active.run = null;
        active.questions = [];
      }

      task = store.task(task.id) ?? task;
      if (active.ending !== null) return finishEnded(active, task);

      const revNow = sourceRevision(sourceDir);
      // `editsSinceBuild` is derived from a revision the states cache for a
      // moment; the verdict is taken the instant a turn ends, so it is derived
      // here from the revision just read.
      const builtFrom = states.get(active.appId).builtFromRev;
      const status = { ...states.status(active.appId), editsSinceBuild: builtFrom !== null && builtFrom !== revNow };
      // Against the revision before the task's first turn, not this one's: an
      // attempt that only builds what the last one edited has still changed
      // the workspace for this task.
      const verdict = verdictOf(
        task,
        status,
        task.revBefore ?? revBefore,
        revNow,
        {
          timedOut: limit.aborted,
          ...(idle ? { idleMs: idleTimeoutMs } : {}),
          ...(error === undefined ? {} : { error }),
        },
        finishedExamples(active.appId),
      );
      task = store.recordResult(task.id, { passed: verdict.passed });
      if (verdict.completed) {
        task = store.recordResult(task.id, {
          revAfter: revNow,
          releaseId: status.releaseId,
          actualLines: changedLines(sourceDir, task.revBefore ?? revBefore, revNow),
        });
        store.setAdvice(task.id, null);
        move(task, 'completed', 'a verified build passes an example for every criterion', runId);
        return true;
      }

      lastReasons = verdict.reasons;
      const got = verdict.passed.length;
      const further = best !== null && got > best;
      best = Math.max(best ?? got, got);
      if (!further) counted += 1;
      if (counted >= maxAttempts || turn >= maxTurns) {
        task = move(task, 'failed', verdict.reasons.join(' '), runId);
        store.setFailure(task.id, { reasons: verdict.reasons, runIds, at: Date.now() });
        stopIntent(active, `${task.slug} failed after ${plural(turn, 'attempt', 'attempts')}.`);
        await advise(task, verdict.reasons);
        return false;
      }
      // Another attempt: written down as the failure it was, then queued again.
      task = move(task, 'failed', `attempt ${String(turn)}: ${verdict.reasons.join(' ')}`, runId);
      task = move(
        task,
        'in-queue',
        further ? `another attempt: it got further (${String(got)} of ${String(task.criteria.length)})` : 'another attempt',
      );
    }
  }

  /** A turn ended from outside: stopped, a question expired, or the builder asked. */
  function finishEnded(active: Active, task: TaskRecord | null): false {
    const ending = active.ending;
    if (ending === null) return false;
    if (ending.kind === 'asked') {
      stopIntent(active, `${ending.slug} needs an answer`);
      return false;
    }
    if (task?.stored === 'in-progress') {
      move(task, 'interrupted', ending.kind === 'expired' ? QUESTION_EXPIRED : `stopped by ${ending.by}`);
    }
    stopIntent(active, ending.kind === 'expired' ? QUESTION_EXPIRED : `Stopped by ${ending.by}`);
    return false;
  }

  /** The loop: task after task in run order, until done, a failure, or a stop. */
  async function drive(active: Active): Promise<void> {
    try {
      for (;;) {
        if (active.ending !== null) {
          finishEnded(active, active.taskId === null ? null : store.task(active.taskId));
          return;
        }
        const live = store.runOrder(active.intentId).filter((task) => task.stored !== 'removed');
        if (live.every((task) => task.stored === 'completed')) {
          store.setRun(active.intentId, 'done');
          note(`intent ${String(active.intentId)} is done: ${RUN_FINISHED}`, active.appId);
          return;
        }
        const next = live.find((task) => task.stored === 'in-queue' && task.status !== 'blocked');
        if (next === undefined) {
          const waiting = live.find((task) => task.status === 'blocked');
          stopIntent(
            active,
            waiting === undefined
              ? 'Nothing left in this backlog can run.'
              : `${waiting.slug} waits on ${waiting.waitingOn.join(', ')}, which is not completed.`,
          );
          return;
        }
        active.taskId = next.id;
        if (!(await runTask(active, next))) return;
      }
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      logger.error(`[autoapp] a backlog run stopped on an error: ${message}`);
      const task = active.taskId === null ? null : store.task(active.taskId);
      try {
        if (task?.stored === 'in-progress') store.moveTask(task.id, 'interrupted', 'the run stopped on an error');
      } catch {
        // The intent is still stopped below.
      }
      stopIntent(active, `The run stopped on an error: ${sanitise(message).slice(0, 300)}`);
    }
  }

  return {
    async start(intentId, startedBy) {
      if (current !== null) {
        throw publicError.conflict(`A backlog run is already working on ${current.appId}. Stop it, or wait for it to finish.`);
      }
      const found = store.get(intentId);
      if (found === null) throw publicError.notFound(`There is no intent ${String(intentId)}.`);
      const { intent, tasks } = found;
      if (intent.status === 'draft') {
        if (intent.submittedAt === null) {
          throw publicError.conflict(`Intent ${String(intentId)} is still being written. It runs once the engineer has submitted it.`);
        }
        if (intent.questions.length > 0) {
          throw publicError.conflict(`Intent ${String(intentId)} has open questions. Answer them in the chat first.`);
        }
      } else if (intent.status !== 'stopped') {
        throw publicError.conflict(`Intent ${String(intentId)} is ${intent.status}; only a submitted draft or a stopped run starts.`);
      }
      const asking = tasks.find((task) => task.stored === 'needs-answer');
      if (asking !== undefined) {
        throw publicError.conflict(`${asking.slug} is waiting for an answer. Answer it in the Backlog panel first.`);
      }
      const runnable = tasks.filter((task) => [...REQUEUED, 'in-queue'].includes(task.stored));
      if (runnable.length === 0) throw publicError.conflict('Nothing in this backlog is left to run.');
      if (intent.status === 'stopped') {
        const problems = validateGraph(
          store.runOrder(intentId).map((task) => ({ slug: task.slug, intentId, blockedBy: task.blockedBy, stored: task.stored })),
        );
        if (problems.length > 0) throw publicError.conflict(problems.map((problem) => problem.message).join(' '));
      }
      if ((await options.ai().registry.currentConfig()) === null) {
        throw publicError.unavailable('AI is not set up yet. Open Settings to choose a provider.');
      }
      if (current !== null) {
        throw publicError.conflict(`A backlog run is already working on ${(current as Active).appId}.`);
      }

      for (const task of tasks) {
        if (!REQUEUED.includes(task.stored)) continue;
        // The failure is the last run's and goes; the advice stays in front
        // of the person until the task completes or is revised.
        if (task.stored === 'failed') store.setFailure(task.id, null);
        move(task, 'in-queue', `queued by ${startedBy}`);
      }
      store.setRun(intentId, 'running');
      note(`intent ${String(intentId)} started by ${startedBy}`, intent.appId);

      const active: Active = {
        intentId,
        appId: intent.appId,
        controller: null,
        runId: null,
        taskId: null,
        run: null,
        questions: [],
        ending: null,
        inFlight: new Set(),
        clock: null,
      };
      current = active;
      loop = drive(active).finally(() => {
        if (current === active) current = null;
      });
      return { started: true, tasks: runnable.length };
    },

    stop(intentId, by) {
      const active = current;
      if (active !== null && active.intentId === intentId) {
        if (active.ending === null) active.ending = { kind: 'stopped', by };
        active.controller?.abort(new Error(`stopped by ${by}`));
        return { stopped: true };
      }
      const intent = store.get(intentId)?.intent;
      if (intent === undefined) throw publicError.notFound(`There is no intent ${String(intentId)}.`);
      if (intent.status !== 'running') throw publicError.conflict(`Intent ${String(intentId)} is not running.`);
      // Running with no loop behind it: say so, rather than leave it running.
      store.setRun(intentId, 'stopped', `Stopped by ${by}`);
      return { stopped: true };
    },

    stopAll(by) {
      const active = current;
      if (active === null) return;
      if (active.ending === null) active.ending = { kind: 'stopped', by };
      active.controller?.abort(new Error(`stopped by ${by}`));
    },

    busy(appId, runId) {
      const active = current;
      if (active === null || active.appId !== appId) return null;
      if (runId !== null && runId.startsWith(`intent-${String(active.intentId)}-`)) return null;
      return `A backlog run is working on ${appId}. Stop it from the Backlog panel first.`;
    },

    ask(runId, question) {
      if (!runId.startsWith('intent-')) {
        throw publicError.conflict('intent.ask is for a builder in a backlog run. Ask the person in the chat.');
      }
      const active = current;
      if (active === null || active.runId !== runId || active.taskId === null) {
        throw publicError.conflict('This turn is not building a task now.');
      }
      const task = store.task(active.taskId);
      if (task === null) throw publicError.notFound('The task this turn was building is gone.');
      if (task.answers.length + (task.question === null ? 0 : 1) >= MAX_QUESTIONS_PER_TASK) {
        throw publicError.conflict(DECIDE);
      }
      store.ask(task.id, question, 'the builder asked the person');
      note(`task ${task.slug}: in-progress → needs-answer (the builder asked the person)`, task.appId, runId);
      active.ending = { kind: 'asked', slug: task.slug };
      return { next: ASKED_NEXT };
    },

    active() {
      return current === null ? null : { intentId: current.intentId, appId: current.appId };
    },

    progress(intentId) {
      const active = current;
      if (active === null || active.intentId !== intentId) return { run: null, question: null };
      return { run: active.run, question: active.questions[0] ?? null };
    },

    async idle() {
      for (;;) {
        const at = loop;
        await at;
        if (at === loop && current === null) return;
      }
    },
  };
}
