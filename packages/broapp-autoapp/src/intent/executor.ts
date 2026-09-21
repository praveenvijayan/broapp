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
import { parseModelRef } from 'broapp/ai';
import type { AdapterConfig, Ai, ChatEvent, InProcessQuestion, ProviderAdapter } from 'broapp/ai/host';
import { publicError } from 'broapp/host';
import type { Envelope, HostLogger } from 'broapp/host';
import { s } from 'broapp/shared';

import type { CandidateStatus, CandidateStates } from '../engineer/state.ts';
import type { RunStore } from '../host/run-store.ts';
import { sourceRevision } from '../knowledge/ids.ts';
import { stepsHash } from '../knowledge/evidence.ts';
import { sanitise, type EventLog } from '../knowledge/log.ts';
import { sourceProblem } from '../launcher/location.ts';
import { readRelease, type Layout } from '../spec/index.ts';

import { modelFor, readTierModels, type TierModels } from './models.ts';
import { exampleIdFor, FAILURE_MARK, renderPlan, validateGraph } from './plan.ts';
import { refusalError, refusalLine, refusalsOf, type RefusalGroup } from './refusals.ts';
import type { IntentStore } from './store.ts';
import { NOT_AN_ATTEMPT, type StoredTaskStatus, type TaskRecord } from './types.ts';
import { recordUsage } from './usage.ts';

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
/**
 * How many times a backlog turn may be refused for the same reason, with its
 * workspace unchanged, before it is ended.
 *
 * A choice, not a measurement. The second identical refusal shows the builder
 * a valid input; the third is its try at it; the fourth says it is not going to
 * get there. The paper that prompted this used five and eight for its own loop
 * detector and did not vary them, and nothing about Autoapp is known from that.
 * Nobody has measured four.
 */
export const MAX_SAME_REFUSALS = 4;
/** How many questions a builder may ask about one task. */
export const MAX_QUESTIONS_PER_TASK = 2;

/**
 * The verdict's reason when no build of the workspace exists and none failed.
 *
 * A constant because the refusal sentences are placed after it: matched by
 * value, never by re-reading the sentence.
 */
export const NOTHING_BUILT = 'Nothing was built.';

/** The note on a task completed on the build the host made for its turn. */
export const HOST_BUILT_COMPLETED = 'completed after the host built what the turn left unbuilt';

/**
 * The call id of the one `candidate.cycle` the host makes for a builder's turn.
 *
 * Its request id is `<runId>:host-build`, so the gate's record says under the
 * turn's own run which call nobody's model made; its steps follow as
 * `…:host-build.build`, `.preview` and `.check`.
 */
export const HOST_CALL_ID = 'host-build';

/** Why a run stopped when a forwarded question was never answered. */
export const QUESTION_EXPIRED = 'A question waited ten minutes without an answer.';
/** What the panel says once every task is built. */
export const RUN_FINISHED =
  'All tasks are built and checked in the candidate. Open the preview, look, then activate from the Candidate panel.';
/** What a third `intent.ask` about one task is told. */
export const DECIDE = 'Decide with what you have.';
/** What `intent.ask` returns. */
export const ASKED_NEXT = 'Stop now. The person will answer and the task will be run again.';

/**
 * The start of a note on a move that was not an attempt of the builder's.
 * Defined beside the task types, so the store can mark such a row; exported
 * here, where the notes are written.
 */
export { NOT_AN_ATTEMPT } from './types.ts';

/** Why a run stopped when the provider failed while a task was being built. */
export function providerStopped(slug: string): string {
  return `The AI provider returned an error while building ${slug}. Nothing was judged. The launcher's log has the detail.`;
}

/** Why a run stopped when a builder's turn ended before the model did anything. */
export function nothingDoneStopped(slug: string): string {
  return `The turn building ${slug} ended before the model did anything. Nothing was judged. The launcher's log has the detail.`;
}

/**
 * The reasons a note on a move to `failed` or `interrupted` gives, as the
 * sentences a builder is told; empty for a move that was not an attempt.
 *
 * A retry inside one run is told the verdict's reasons from a variable; a task
 * resumed after a stop or a restart has only the history, so the history is
 * read back into the same sentences. An interrupted attempt says so, because
 * "stopped by the person" is not a reason the plan failed.
 */
export function reasonsFromNote(to: 'failed' | 'interrupted', note: string): string[] {
  if (note.startsWith(NOT_AN_ATTEMPT)) return [];
  if (to === 'interrupted') return [`The attempt was stopped before it finished (${note}).`];
  const text = note.replace(/^attempt \d+: /, '');
  return text
    .split(/(?<=\.)\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

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
  /** The refusal that ended the turn, and how many times it came, when {@link MAX_SAME_REFUSALS} did. */
  readonly stuck?: { readonly group: Pick<RefusalGroup, 'route' | 'kind' | 'error'>; readonly count: number };
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The sentence a turn ended for being refused the same way too often gets. */
export function stuckSentence(count: number, group: Pick<RefusalGroup, 'route' | 'kind' | 'error'>): string {
  return `The turn was refused ${String(count)} times for the same reason: ${group.route}: ${endSentence(refusalError(group, 160))}`;
}

/** The sentence a turn ended by the idle limit gets. */
export function idleSentence(ms: number): string {
  const minutes = ms / 60_000;
  const amount = Number.isInteger(minutes)
    ? plural(minutes, 'minute', 'minutes')
    : plural(Math.max(1, Math.round(ms / 1_000)), 'second', 'seconds');
  return `The turn made no tool call for ${amount}.`;
}

/** The tools whose refusals are counted as refused edits. */
const EDIT_TOOLS: readonly string[] = ['source.edit', 'source.change'];

/** `once`, or `<n> times`. */
function times(n: number): string {
  return n === 1 ? 'once' : `${String(n)} times`;
}

/** A sentence's last word, with the one full stop it needs. */
function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * What the tools refused, as sentences for a verdict that built nothing.
 *
 * One per refused group of `candidate.cycle` and `candidate.build`, at most
 * three; then, when edits were refused, one sentence for all of them with the
 * error they were refused with most often. What the builder got wrong, in the
 * tool's own words — never a guess at why.
 */
export function refusalSentences(refusals: readonly RefusalGroup[]): string[] {
  const sentences = refusals
    .filter((group) => group.route === 'candidate.cycle' || group.route === 'candidate.build')
    .slice(0, 3)
    .map((group) => `${group.route} was refused ${times(group.count)}: ${endSentence(refusalError(group))}`);
  // Edits only: a refused `source.read` or `source.search` is not an edit,
  // and the replay of 14c watched one be called one.
  const edits = refusals.filter((group) => EDIT_TOOLS.includes(group.route));
  const most = edits[0];
  if (most !== undefined) {
    const total = edits.reduce((sum, group) => sum + group.count, 0);
    sentences.push(`${plural(total, 'edit was', 'edits were')} refused; most often: ${endSentence(refusalError(most))}`);
  }
  return sentences;
}

/**
 * Whether a task is finished, from evidence alone.
 *
 * Completed needs every one of: the workspace revision moved since before the
 * task's first turn; the last build has no problems; nothing was edited after
 * it; its checks ran on the preview that is running now; every check passed, so
 * no earlier task's example regressed; every example in `required` — those of
 * the application's finished tasks — is still there, so none was removed to
 * make that true, and still says what it said when its task completed, so
 * none was rewritten to make that true either; and for each criterion an
 * example named `<slug>-<id>` ran. The model's closing words are not an input.
 *
 * What an example says is the hash of its steps: `required` carries the hash
 * kept when its task completed, `current` the hash of each example in the
 * specification this build was made from. A required example with a null hash
 * belongs to a task completed before hashes were kept, and is held by its id
 * alone. One whose current hash is unknown cannot be shown to be unchanged,
 * and reads as changed.
 */
export function verdictOf(
  task: Pick<TaskRecord, 'slug' | 'criteria'>,
  status: Pick<CandidateStatus, 'releaseId' | 'problems' | 'editsSinceBuild' | 'checksVerified' | 'checks'>,
  revBefore: string,
  revNow: string,
  ending: TurnEnding = {},
  required: readonly RequiredExample[] = [],
  refusals: readonly RefusalGroup[] = [],
  current: Readonly<Record<string, string>> = {},
): Verdict {
  const reasons: string[] = [];
  // The refusal that ended a stuck turn is said once, by its own sentence.
  const stuck = ending.stuck;
  const told = stuck === undefined ? refusals : refusals.filter((group) => group.route !== stuck.group.route || group.kind !== stuck.group.kind);
  if (revNow === revBefore) reasons.push('The workspace did not change.');
  // Nothing built is the one reason a refused build explains, so the refusals
  // follow it and nothing else: a verdict with a build has its own evidence.
  if (status.releaseId === null && status.problems.length === 0) reasons.push(NOTHING_BUILT, ...refusalSentences(told));
  if (status.problems.length > 0) reasons.push(`The build has ${plural(status.problems.length, 'problem', 'problems')}.`);
  if (status.editsSinceBuild) reasons.push('The workspace changed after the last build.');
  if (!status.checksVerified) reasons.push('The checks did not run on the build the preview is running.');
  const failed = status.checks.filter((check) => !check.passed);
  for (const check of failed.slice(0, 5)) reasons.push(`The example ${check.id} failed.`);
  if (failed.length > 5) reasons.push(`${plural(failed.length - 5, 'more example', 'more examples')} failed.`);

  const byId = new Map(status.checks.map((check) => [check.id, check]));
  const gone = required.filter((example) => !byId.has(example.id));
  const changed = required.filter(
    (example) => byId.has(example.id) && example.hash !== null && current[example.id] !== example.hash,
  );
  for (const example of gone) reasons.push(`The example ${example.id}, from a finished task, is gone.`);
  for (const example of changed) reasons.push(`The example ${example.id}, from a finished task, was changed.`);
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
    if (stuck !== undefined) reasons.push(stuckSentence(stuck.count, stuck.group));
    if (ending.error !== undefined) reasons.push(`The turn ended with an error: ${ending.error}`);
  }
  return { completed: reasons.length === 0, reasons, passed };
}

/** An example a finished task left, and the hash of its steps when it finished (`null` before 15b). */
export interface RequiredExample {
  readonly id: string;
  readonly hash: string | null;
}

/** What the builder of one task is told: one message, no history. */
/**
 * How a builder is told to read a failure criterion. Without it, 14b's builder
 * stopped twice to say two criteria contradicted each other, having no way to
 * write the example for the one that is refused.
 */
export const FAILURE_SENTENCE = `A criterion marked ${FAILURE_MARK} is not in conflict with the others: its example is a step with \`fails\`, showing the route refuses, and the others show what happens when it does not.`;

export function builderMessage(
  task: TaskRecord,
  lastReasons: readonly string[] = [],
): string {
  const ids = task.criteria.map((criterion) => exampleIdFor(task.slug, criterion.id));
  const parts = [
    `Application: ${task.appId}`,
    `Build this one task and nothing else. Add one acceptance example to autoapp.json for each criterion, with exactly these ids: ${ids.join(', ')}. Do not remove, rename or change an acceptance example that is already there. If an older example fails, run candidate.cycle again so the checks run on a fresh preview. If it still fails, your change is wrong or the plan is: say which with intent.ask. ${FAILURE_SENTENCE} Use candidate.cycle until every check passes, then stop. Do not request activation. Do not plan or change the backlog.`,
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
  'You planned a backlog, and one of its tasks failed twice in the hands of a builder. Read the plan and why it was not completed, and advise the person. retry: nothing in the plan is wrong and another run may pass. revise: the plan asks for something that cannot pass as written. split: the task is two tasks. ask: the person has to decide something first; say what in the note. The diagnosis says what went wrong in one or two sentences; the note is what you would tell the person. When the builder\'s calls were refused for their input, the plan is not at fault and another model may be the answer; say so in the note. Do not include paths from this machine.';

/** How long the advice question may take. */
const ADVICE_TIMEOUT_MS = 60_000;

/** What the tools refused in the last two attempts, for the advice question. */
export interface AdviceRefusals {
  readonly last: readonly RefusalGroup[];
  readonly before: readonly RefusalGroup[];
}

/** The advice question, as the model reads it. */
export function advicePrompt(
  task: TaskRecord,
  reasons: readonly string[],
  failures: readonly string[],
  refusals: AdviceRefusals = { last: [], before: [] },
): string {
  // Both attempts, because a builder that repeats the refusal its first
  // attempt met is the sign that another model, not another plan, is needed.
  const refused = [
    ...refusals.last.map((group) => `- the last attempt: ${refusalLine(group)}`),
    ...refusals.before.map((group) => `- the attempt before: ${refusalLine(group)}`),
  ];
  return [
    '# The task',
    renderPlan(task),
    '# Why it was not completed',
    ...reasons.map((reason) => `- ${reason}`),
    '# What the last change cycle still had wrong',
    ...(failures.length === 0 ? ['(nothing recorded)'] : failures.map((failure) => `- ${failure}`)),
    '# What the tools refused',
    ...(refused.length === 0 ? ['(nothing was refused)'] : refused),
    '# Your answer',
    'One JSON object and nothing else, matching this JSON Schema. `advice` is exactly one of: retry, revise, split, ask.',
    JSON.stringify(ADVICE.toJsonSchema()),
  ].join('\n');
}

/**
 * Ask for advice and validate it, exactly as the distiller asks its question.
 *
 * `used` is told what the question used as soon as the provider says, before
 * the answer is validated: a question whose answer is refused still cost what
 * it cost.
 */
async function askAdvice(
  model: LanguageModel,
  prompt: string,
  signal: AbortSignal,
  used: (usage: { inputTokens: number; outputTokens: number }) => void,
): Promise<Advice> {
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
  const usage = await result.usage;
  used({ inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
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

/** Which part of the work a builder's turn is in. */
export type RunStage = 'reading' | 'editing' | 'building' | 'checking';

/** What {@link stageOf} reads of a turn's events: the AI layer's `tool-call`, `tool-result` and `confirm`. */
export interface StageEvent {
  readonly type: string;
  readonly tool?: string;
  readonly output?: unknown;
  readonly denied?: boolean;
}

/** The tools whose start is a build. */
const BUILD_TOOLS: readonly string[] = ['candidate.cycle', 'candidate.build'];
/** The tools whose start, or whose step's question, is a check. */
const CHECK_TOOLS: readonly string[] = ['candidate.preview', 'candidate.check', 'preview.try'];

/** Whether a result reports a build that did not end in a checked preview. */
function stoppedShort(tool: string, output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return true;
  const record = output as { error?: unknown; ok?: unknown; build?: { ok?: unknown; declined?: unknown }; preview?: { started?: unknown; declined?: unknown } };
  if (record.error !== undefined) return true;
  if (tool === 'candidate.build') return record.ok !== true;
  const build = record.build;
  if (build === undefined || build.declined === true || build.ok === false) return true;
  const preview = record.preview;
  return preview !== undefined && (preview.declined === true || preview.started === false);
}

/**
 * Which stage a builder's turn is in, from its tool events, in order.
 *
 * `reading` until an edit lands — a `source.edit` or `source.change` that
 * succeeded, or a cycle whose patch changed a file; `editing` after it.
 * `building` from the start of a cycle or a `candidate.build`; `checking` from
 * a preview or a check, whether called alone or asked as a cycle's step. It
 * moves back as the turn does: a build that failed, was declined, or whose
 * preview would not start returns the turn to `editing` — or to `reading` when
 * nothing has landed — so a failed build followed by an edit is `editing`
 * again. A refused edit changes nothing, and a turn that has called nothing is
 * `reading`. Pure: the same events give the same stage.
 */
export function stageOf(events: readonly StageEvent[]): RunStage {
  let stage: RunStage = 'reading';
  let landed = false;
  for (const event of events) {
    const tool = event.tool ?? '';
    if (event.type === 'tool-call') {
      if (BUILD_TOOLS.includes(tool)) stage = 'building';
      else if (CHECK_TOOLS.includes(tool)) stage = 'checking';
    } else if (event.type === 'confirm') {
      if (tool === 'candidate.build') stage = 'building';
      else if (CHECK_TOOLS.includes(tool)) stage = 'checking';
    } else if (event.type === 'tool-result') {
      if (event.denied !== true && landedEdit(tool, event.output)) landed = true;
      if (tool === 'source.edit' || tool === 'source.change') {
        if (event.denied !== true && landedEdit(tool, event.output)) stage = 'editing';
      } else if (BUILD_TOOLS.includes(tool) && (event.denied === true || stoppedShort(tool, event.output))) {
        stage = landed ? 'editing' : 'reading';
      }
    }
  }
  return stage;
}

/** Where the run is, for the panel and the overview. */
export interface RunProgress {
  readonly taskId: number;
  /** The turn's run id: what an alert about it is keyed by. */
  readonly runId: string;
  /** The task's turns so far, across runs: the number in the run id. */
  readonly attempt: number;
  readonly startedAt: number;
  readonly lastTool: string | null;
  readonly lastToolAt: number | null;
  readonly approvals: number;
  readonly stage: RunStage;
  /** This task's turns in this run, and the most it may take. */
  readonly turn: number;
  readonly maxTurns: number;
  /** The attempts that count against a task in one run. */
  readonly maxAttempts: number;
  /** The last tool call or result, or the turn's start: what the idle limit counts from. */
  readonly quietSince: number;
  readonly idleLimitMs: number;
  readonly turnLimitMs: number;
  /** Distinct paths this task's turns have edited. */
  readonly filesChanged: number;
  /** The task's criteria whose example passed, by the last check or the last verdict; zero before either. */
  readonly criteria: { readonly passed: number; readonly total: number };
  /** The newest refusal of this turn, reason cut at 160. */
  readonly lastRefusal: { readonly tool: string; readonly reason: string } | null;
  /** What the turn has used so far, from its completed steps. */
  readonly tokens: { readonly input: number; readonly output: number };
}

/** What happened in a run that a person might want to hear about when they are not looking. */
export type RunEventKind = 'task-completed' | 'task-failed' | 'turn-limit' | 'run-ended' | 'provider-error';

/** One such thing, kept in memory for the life of the launcher. */
export interface RunEvent {
  /** Unique for the event: the run id and the kind, or the intent's run and `run-ended`. */
  readonly key: string;
  readonly kind: RunEventKind;
  readonly appId: string;
  readonly intentId: number;
  readonly runId: string | null;
  readonly taskSlug: string | null;
  /** One sentence a person reads. */
  readonly text: string;
  readonly at: number;
}

/** How many run events the executor remembers. */
export const RECENT_RUN_EVENTS = 20;

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
  /**
   * Called after a task moves to `completed`, `failed` or `interrupted`: the
   * moment the record an attempt left is whole. The launcher rebuilds its
   * relationship index here.
   */
  readonly onTaskEnded?: (task: TaskRecord) => void;
  /**
   * The launcher's run store, where the gate wrote every call of a builder's
   * turn under its run id. Read for what the tools refused. Absent, nothing
   * is read and the verdict, the advice and the attempts say nothing of it.
   */
  readonly runs?: Pick<RunStore, 'getRun'>;
  /**
   * The engineer's own `candidate.cycle`, for the one call the host makes when
   * a turn ends with edits nothing built. It passes the gate like any call.
   * Absent, the host builds nothing.
   */
  readonly hostCycle?: (input: unknown, envelope: Envelope, signal: AbortSignal) => Promise<unknown>;
  /**
   * What a running turn has used so far, as the AI layer's `onUsageSoFar`
   * last said; `null` before its first step completes. Absent, a running
   * turn's tokens read as zero.
   */
  readonly usageSoFar?: (runId: string) => { readonly inputTokens: number; readonly outputTokens: number } | null;
  /**
   * The paths the given runs edited, as the knowledge log's `edit` events
   * recorded them. Absent, only what this run's own results showed is counted.
   */
  readonly editedPaths?: (runIds: readonly string[]) => readonly string[];
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
  /** What happened in runs since the launcher started, newest first, at most {@link RECENT_RUN_EVENTS}. */
  recent(): readonly RunEvent[];
  /** Resolves when no run is active. */
  idle(): Promise<void>;
}

/** Why a turn was ended from outside. */
type Ending =
  | { readonly kind: 'stopped'; readonly by: string }
  | { readonly kind: 'asked'; readonly slug: string }
  | { readonly kind: 'expired' }
  /** Not the builder's attempt: the provider failed, or the model never acted. */
  | { readonly kind: 'provider'; readonly note: string; readonly reason: string };

/** The part of a turn's progress set as it happens; the rest is derived when read. */
type RunBase = Pick<RunProgress, 'taskId' | 'runId' | 'attempt' | 'startedAt' | 'lastTool' | 'lastToolAt' | 'approvals' | 'turn'>;

interface Active {
  readonly intentId: number;
  readonly appId: string;
  controller: AbortController | null;
  runId: string | null;
  taskId: number | null;
  /** What the turn in hand began with; the rest of {@link RunProgress} is derived when it is read. */
  run: RunBase | null;
  questions: RunQuestion[];
  /** The turn's tool events, in order, for {@link stageOf}. */
  events: StageEvent[];
  /** The last tool call or result of the turn, or its start. */
  quietSince: number;
  /** Paths this task's turns in this run showed as edited. */
  taskFiles: Set<string>;
  /** The newest refusal of the turn. */
  lastRefusal: RefusalGroup | null;
  ending: Ending | null;
  /** The calls of this turn whose tool is running now. */
  inFlight: Set<string>;
  /** The turn's idle clock, while a turn runs. */
  clock: IdleClock | null;
  /** The first `error` event of this turn: the AI layer's own reduced sentence. */
  providerError: string | null;
  /** How many tool calls this turn made. */
  toolCalls: number;
  /** This turn's refusals by route and kind: the first of each, how many, and the landed edits when it began. */
  refusals: Map<string, { group: RefusalGroup; count: number; landedAt: number }>;
  /** Edits of this turn that changed the workspace, as their results showed. */
  landed: number;
  /** The workspace revision when the turn began. */
  turnRev: string;
  /** Set when {@link MAX_SAME_REFUSALS} ended the turn. */
  stuck: { group: RefusalGroup; count: number } | null;
}

/** The sentence the AI layer gives a tool that failed for no reason it can show; not a refusal. */
const TOOL_FAILED = 'The tool failed.';

/** Whether a tool result shows an edit that changed the workspace: what 15d counts as an edit. */
function landedEdit(tool: string, output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false;
  const record = output as { error?: unknown; denied?: unknown; applied?: { changed?: unknown } };
  if (tool === 'source.edit' || tool === 'source.change') return record.error === undefined && record.denied !== true;
  if (tool !== 'candidate.cycle') return false;
  return Array.isArray(record.applied?.changed) && record.applied.changed.length > 0;
}

/**
 * The refusal a tool result carries, grouped as the verdict groups them, or
 * `null` when it is not one.
 *
 * A refusal is a tool the gate let run that answered with an error of its
 * own: a malformed input, a hunk that matched nothing, a path outside the
 * workspace. A person's no carries `denied`; a build that failed or a check
 * that did not pass is a result, not an error; a failure the AI layer reduced
 * to its fixed sentence names nothing the builder could fix.
 */
function refusalOf(tool: string, output: unknown, denied: boolean): RefusalGroup | null {
  if (denied || typeof output !== 'object' || output === null) return null;
  const error = (output as { error?: unknown }).error;
  if (typeof error !== 'string' || error === TOOL_FAILED) return null;
  return refusalsOf([{ route: tool, decision: 'allowed', outcome: 'failed', error }])[0] ?? null;
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
  /** What happened in runs, newest last; the overview reads it for alerts. */
  const recentEvents: RunEvent[] = [];

  /** Remember one run event, once per key. */
  const remember = (event: Omit<RunEvent, 'at'>): void => {
    if (recentEvents.some((seen) => seen.key === event.key)) return;
    recentEvents.push({ ...event, at: Date.now() });
    if (recentEvents.length > RECENT_RUN_EVENTS) recentEvents.splice(0, recentEvents.length - RECENT_RUN_EVENTS);
  };

  /** The paths a result shows as edited: `changed` of an edit, `applied.changed` of a cycle. */
  const pathsIn = (tool: string, output: unknown): string[] => {
    if (!landedEdit(tool, output)) return [];
    const record = output as { changed?: unknown; applied?: { changed?: unknown } };
    const list = tool === 'candidate.cycle' ? record.applied?.changed : record.changed;
    return Array.isArray(list) ? list.filter((path): path is string => typeof path === 'string') : [];
  };

  /** Tell whoever keeps derived data that a task's attempt is over. Never a reason to fail. */
  const ended = (task: TaskRecord): void => {
    try {
      options.onTaskEnded?.(task);
    } catch (cause) {
      logger.error(`[autoapp] could not note the end of ${task.slug}: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  };

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
    if (to === 'completed' || to === 'failed' || to === 'interrupted') ended(moved);
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

  /**
   * Why a task cannot run on the model reference it names, or `null` when it
   * can or nobody can tell.
   *
   * A reference naming a provider asks that provider, with its own key and
   * address; a bare one asks the provider in use. A provider that is not
   * turned on is refused in `resolve`'s own words before anything is sent to
   * it. A list that cannot be read is not a refusal: the turn will say what
   * went wrong in the provider's words.
   */
  async function notOffered(ref: string): Promise<string | null> {
    const registry = options.ai().registry;
    const { provider, modelId } = parseModelRef(
      ref,
      registry.adapters.map((adapter) => adapter.id),
    );
    let reached: { adapter: ProviderAdapter; config: AdapterConfig } | null;
    if (provider === null) {
      reached = await registry.currentConfig();
    } else {
      reached = await registry.configOf(provider);
      if (reached === null) return `${registry.adapter(provider)?.label ?? provider} is not turned on in Settings.`;
    }
    if (reached === null) return null;
    try {
      const models = await reached.adapter.models(reached.config, AbortSignal.timeout(20_000));
      return models.some((model) => model.modelId === modelId)
        ? null
        : `The model ${modelId} is no longer offered by ${reached.adapter.label}.`;
    } catch {
      return null;
    }
  }

  /** What the tools refused in one turn, from the run store; nothing without one. */
  const refusedIn = (runId: string | undefined): RefusalGroup[] => {
    if (runId === undefined || options.runs === undefined) return [];
    try {
      return refusalsOf(options.runs.getRun(runId)?.steps ?? []);
    } catch (cause) {
      logger.error(`[autoapp] could not read what the tools refused: ${String(cause instanceof Error ? cause.message : cause)}`);
      return [];
    }
  };

  /** Ask the main model for advice on a failed task. Stores it, or nothing. */
  async function advise(task: TaskRecord, reasons: readonly string[], runIds: readonly string[]): Promise<void> {
    const failures = states.get(task.appId).cycle?.failures.map((failure) => failure.summary) ?? [];
    const refusals = { last: refusedIn(runIds[runIds.length - 1]), before: refusedIn(runIds[runIds.length - 2]) };
    // The advice question is a turn too, on the Settings model, and it costs
    // what it costs whether or not its answer can be read: one usage row,
    // partial with zeros when the provider never said.
    const started = Date.now();
    let used: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const model = await options.ai().model();
      const answer = await askAdvice(model, advicePrompt(task, reasons, failures, refusals), AbortSignal.timeout(ADVICE_TIMEOUT_MS), (usage) => {
        used = usage;
      });
      store.setAdvice(task.id, { ...answer, at: Date.now() });
      note(`task ${task.slug}: the main model advises ${answer.advice}`, task.appId);
    } catch (cause) {
      note(
        `task ${task.slug}: no advice could be read from the main model (${sanitise(String(cause instanceof Error ? cause.message : cause)).slice(0, 200)})`,
        task.appId,
      );
    }
    try {
      const modelId = (await options.ai().registry.settings()).modelId;
      recordUsage(store, {
        runId: `advice-${String(task.id)}-${String(started)}`,
        appId: task.appId,
        taskId: task.id,
        modelId,
        inputTokens: used?.inputTokens ?? 0,
        outputTokens: used?.outputTokens ?? 0,
        partial: used === undefined,
        steps: 0,
        ms: Date.now() - started,
        endedAt: Date.now(),
      });
    } catch (cause) {
      logger.error(`[autoapp] could not keep what the advice question used: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  }

  /**
   * The examples of every task of `appId` already completed, which a later
   * task may neither lose nor change, each with the hash kept when it finished.
   */
  function finishedExamples(appId: string): RequiredExample[] {
    const required: RequiredExample[] = [];
    for (const intent of store.list({ appId, limit: Number.MAX_SAFE_INTEGER })) {
      for (const task of store.runOrder(intent.id)) {
        if (task.stored !== 'completed') continue;
        for (const criterion of task.criteria) {
          required.push({ id: exampleIdFor(task.slug, criterion.id), hash: task.exampleHashes[criterion.id] ?? null });
        }
      }
    }
    return required;
  }

  /**
   * The hash of every example's steps, by id, in the specification `releaseId`
   * was built from — the build the checks ran on, not the workspace as it is
   * now, which may have moved since. Empty when nothing was built or the
   * release cannot be read, which the verdict reads as "cannot be shown
   * unchanged".
   */
  function builtExampleHashes(appId: string, releaseId: string | null): Record<string, string> {
    if (releaseId === null) return {};
    try {
      return Object.fromEntries(readRelease(layout, appId, releaseId).acceptance.map((example) => [example.id, stepsHash(example)]));
    } catch {
      return {};
    }
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

  /**
   * Count a tool result against {@link MAX_SAME_REFUSALS}, and end the turn at
   * the limit when nothing changed.
   *
   * The idle clock re-arms on every call and every result, so a refusal every
   * few seconds is a busy turn to it, and the repair limit counts builds, which
   * a refused input never reaches. A group's count starts again when an edit
   * has landed since its first refusal: every landed edit is a commit, so that
   * is the workspace revision moving, seen without asking git on every event.
   * The revision is read once, at the limit, for the one move the results
   * cannot show — a change no result reported, in a turn none reported one —
   * and a turn whose workspace moved at all is never ended by this.
   */
  function countRefusal(active: Active, event: ChatEvent): void {
    const tool = event.tool ?? '';
    if (landedEdit(tool, event.output)) {
      active.landed += 1;
      for (const path of pathsIn(tool, event.output)) active.taskFiles.add(path);
      return;
    }
    const group = refusalOf(tool, event.output, event.denied === true);
    if (group !== null) active.lastRefusal = group;
    if (group === null || active.stuck !== null || active.ending !== null) return;
    const key = `${group.route} ${group.kind}`;
    const seen = active.refusals.get(key);
    const entry = seen === undefined || active.landed > seen.landedAt ? { group, count: 0, landedAt: active.landed } : seen;
    entry.count += 1;
    active.refusals.set(key, entry);
    if (entry.count < MAX_SAME_REFUSALS) return;
    const rev = sourceRevision(layout.app(active.appId).source);
    if (active.landed === 0 && rev !== active.turnRev) {
      // Something moved the workspace that no result reported: not stuck.
      active.turnRev = rev;
      active.refusals.set(key, { group, count: 1, landedAt: active.landed });
      return;
    }
    active.stuck = { group: entry.group, count: entry.count };
    note(
      `the turn was refused ${String(entry.count)} times for the same reason by ${group.route} and was ended`,
      active.appId,
      active.runId ?? undefined,
      event.callId,
    );
    active.controller?.abort(new Error(stuckSentence(entry.count, entry.group)));
  }

  /** Follow the turn: the last tool, the approvals, questions settling or expiring. */
  function followerFor(active: Active) {
    return (event: ChatEvent): void => {
      const run = active.run;
      const callId = event.callId ?? '';
      const parent = callId.split('.')[0] ?? callId;
      // The AI layer has already reduced a provider's failure to a sentence
      // that is safe to keep; the raw text went to the launcher's log.
      if (event.type === 'error' && active.providerError === null) {
        active.providerError = event.message ?? 'The AI provider returned an error.';
      }
      if (event.type === 'tool-call') active.toolCalls += 1;
      if (event.type === 'tool-call' || event.type === 'tool-result' || event.type === 'confirm') {
        active.events.push({ type: event.type, tool: event.tool, output: event.output, denied: event.denied });
      }
      if (event.type === 'tool-call' || event.type === 'tool-result') active.quietSince = Date.now();
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
        countRefusal(active, event);
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

  /**
   * Build what a turn left unbuilt: one `candidate.cycle` with no hunks and no
   * files, the tool's own "verify the workspace as it is".
   *
   * The same tool through the same gate, under the turn's run id, answered by
   * the run's standing answer as the builder's own calls are. The host makes
   * the call because a turn that edited correctly and stopped before building
   * would otherwise be judged on no build at all; what it is judged on is still
   * the build and the checks, never the builder's closing words. Its request
   * id names it, and a log event says so. `true` when the cycle ran.
   */
  async function hostBuild(active: Active, runId: string, signal: AbortSignal): Promise<boolean> {
    const hostCycle = options.hostCycle;
    if (hostCycle === undefined) return false;
    const appId = active.appId;
    const where = `${appId} (intent ${String(active.intentId)})`;
    note(`the host built what turn ${runId} left unbuilt: one candidate.cycle with no hunks, for ${where}`, appId, runId, HOST_CALL_ID);
    try {
      await hostCycle({ appId, message: 'Build the workspace as the turn left it', hunks: [] }, {
        requestId: `${runId}:${HOST_CALL_ID}`,
        channel: 'ai',
        caller: `ai:${runId}`,
        signal,
        approver: {
          ask: (question) => {
            const approved = standingAnswer(appId, { tool: question.route, input: question.input }) === true;
            note(
              approved
                ? `the run's standing answer approved ${question.route} for ${where}`
                : `the run refused ${question.route} for ${where}: the host asks only for its own`,
              appId,
              runId,
              question.requestId.slice(runId.length + 1),
            );
            return Promise.resolve(approved);
          },
        },
      }, signal);
      return true;
    } catch (cause) {
      note(
        `the host could not build what turn ${runId} left: ${sanitise(String(cause instanceof Error ? cause.message : cause)).slice(0, 200)}`,
        appId,
        runId,
        HOST_CALL_ID,
      );
      return false;
    }
  }

  /** Run one task to completed, failed, interrupted or waiting; `true` when the run goes on. */
  async function runTask(active: Active, first: TaskRecord): Promise<boolean> {
    // A workspace that is not there stops the run before any model is asked
    // anything: every turn would only be refused by the same tool for the same
    // reason. The task is not moved — it is not failed, not interrupted, not an
    // attempt, and no refusal is counted — so when the folder is back, or
    // located, Run starts it as if nothing happened.
    const missing = sourceProblem(layout, active.appId);
    if (missing !== null) {
      stopIntent(active, missing);
      return false;
    }
    const sourceDir = layout.app(active.appId).source;
    let task = first;
    // What the last attempt ended with, from the task's own history, so that a
    // task resumed after a stop or a restart is told what a retry inside one
    // run is told. A move that was not an attempt is skipped: the builder is
    // told about attempts, and that was not one.
    let lastReasons: readonly string[] = [];
    for (const row of [...store.attemptNotes(task.id)].reverse()) {
      if (row.notAnAttempt) continue;
      lastReasons = reasonsFromNote(row.to, row.note);
      break;
    }
    const runIds: string[] = [];
    active.taskFiles = new Set();
    // Attempts that count against `maxAttempts`, and the most criteria any
    // attempt of this run has passed: an attempt that gets further than every
    // one before it is not counted, up to `maxTurns` turns.
    let counted = 0;
    let best: number | null = null;
    for (let turn = 1; ; turn += 1) {
      const modelId = modelFor(task, mapping());
      if (modelId !== null) {
        const reason = await notOffered(modelId);
        if (reason !== null) {
          task = move(task, 'failed', reason);
          store.setFailure(task.id, { reasons: [reason], runIds, at: Date.now() });
          stopIntent(active, `${task.slug} failed: ${reason}`);
          remember({
            key: `${task.slug}:${String(task.attempts)}:task-failed`,
            kind: 'task-failed',
            appId: active.appId,
            intentId: active.intentId,
            runId: null,
            taskSlug: task.slug,
            text: `${task.title} failed: ${reason}`,
          });
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
      active.providerError = null;
      active.toolCalls = 0;
      active.refusals = new Map();
      active.landed = 0;
      active.turnRev = revBefore;
      active.stuck = null;
      active.events = [];
      active.lastRefusal = null;
      const startedAt = Date.now();
      active.quietSince = startedAt;
      active.run = { taskId: task.id, runId, attempt: turnNumber, startedAt, lastTool: null, lastToolAt: null, approvals: 0, turn };

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
      let turnStatus: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
      try {
        const result = await options.ai().turn(
          { runId, message: builderMessage(task, lastReasons), ...(modelId === null ? {} : { modelId }) },
          { answer: answerFor(active, runId), signal: AbortSignal.any([controller.signal, limit]), onEvent: followerFor(active) },
        );
        error = result.error;
        turnStatus = result.status;
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

      // A turn the provider killed, or one that could not start, or one that
      // ended before the model did anything, is not the builder's attempt: a
      // verdict over it only re-reads what the last attempt left. It does not
      // go on to the next task either, which would meet the same provider.
      // Only when nothing here ended the turn: the idle clock and the limit
      // abort it too, and the AI layer reports that as an error of its own.
      if (!controller.signal.aborted && !limit.aborted) {
        const failure = active.providerError ?? (error === undefined ? null : sanitise(error).slice(0, 300));
        if (failure !== null) {
          active.ending = { kind: 'provider', note: `${NOT_AN_ATTEMPT}the AI provider failed: ${failure}`, reason: providerStopped(task.slug) };
        } else if (turnStatus === 'failed' && active.toolCalls === 0) {
          active.ending = {
            kind: 'provider',
            note: `${NOT_AN_ATTEMPT}the turn ended before the model did anything`,
            reason: nothingDoneStopped(task.slug),
          };
        }
        if (active.ending !== null) return finishEnded(active, task);
      }

      // A turn that ended on its own with edits nothing built is built once,
      // by the host. Never after an abort — the idle limit, the time limit or
      // a stop may have cut a turn between two halves of an edit — and never
      // for a provider ending or a question, which returned above. Unbuilt is
      // `editsSinceBuild`, derived from a fresh revision as the verdict's is;
      // a workspace never built counts when it changed since the task began.
      let hostBuilt = false;
      if (!controller.signal.aborted && !limit.aborted) {
        const revEnd = sourceRevision(sourceDir);
        const builtFromRev = states.get(active.appId).builtFromRev;
        const unbuilt = builtFromRev === null ? revEnd !== (task.revBefore ?? revBefore) : builtFromRev !== revEnd;
        if (unbuilt && options.hostCycle !== undefined) {
          const building = new AbortController();
          active.controller = building;
          try {
            hostBuilt = await hostBuild(active, runId, building.signal);
          } finally {
            active.controller = null;
          }
          task = store.task(task.id) ?? task;
          if (active.ending !== null) return finishEnded(active, task);
        }
      }

      const revNow = sourceRevision(sourceDir);
      // `editsSinceBuild` is derived from a revision the states cache for a
      // moment; the verdict is taken the instant a turn ends, so it is derived
      // here from the revision just read.
      const builtFrom = states.get(active.appId).builtFromRev;
      const status = { ...states.status(active.appId), editsSinceBuild: builtFrom !== null && builtFrom !== revNow };
      const built = builtExampleHashes(active.appId, status.releaseId);
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
          ...(active.stuck === null ? {} : { stuck: active.stuck }),
          ...(error === undefined ? {} : { error }),
        },
        finishedExamples(active.appId),
        refusedIn(runId),
        built,
      );
      task = store.recordResult(task.id, { passed: verdict.passed });
      if (verdict.completed) {
        // What each of this task's examples said in the build that completed
        // it: from here on a later task is held to it.
        const exampleHashes: Record<string, string> = {};
        for (const criterion of task.criteria) {
          const hash = built[exampleIdFor(task.slug, criterion.id)];
          if (hash !== undefined) exampleHashes[criterion.id] = hash;
        }
        task = store.recordResult(task.id, {
          exampleHashes,
          revAfter: revNow,
          releaseId: status.releaseId,
          actualLines: changedLines(sourceDir, task.revBefore ?? revBefore, revNow),
        });
        store.setAdvice(task.id, null);
        move(task, 'completed', hostBuilt ? HOST_BUILT_COMPLETED : 'a verified build passes an example for every criterion', runId);
        remember({
          key: `${runId}:task-completed`,
          kind: 'task-completed',
          appId: active.appId,
          intentId: active.intentId,
          runId,
          taskSlug: task.slug,
          text: `${task.title} is built and checked.`,
        });
        return true;
      }

      // A turn a limit ended is said on its own, whatever follows it: the
      // person hears that the clock or a loop ended a turn, and that a retry
      // may follow, before they hear whether the task failed.
      // Read again rather than narrowed: the follower sets it while the turn runs.
      const stuck = active.stuck as Active['stuck'];
      const limitSentence = limit.aborted
        ? 'The turn ran out of time.'
        : idle
          ? idleSentence(idleTimeoutMs)
          : stuck === null
            ? null
            : stuckSentence(stuck.count, stuck.group);
      if (limitSentence !== null) {
        remember({
          key: `${runId}:turn-limit`,
          kind: 'turn-limit',
          appId: active.appId,
          intentId: active.intentId,
          runId,
          taskSlug: task.slug,
          text: `${task.slug}: ${limitSentence}`,
        });
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
        await advise(task, verdict.reasons, runIds);
        // After the advice, so that when the person looks, it is there.
        remember({
          key: `${runId}:task-failed`,
          kind: 'task-failed',
          appId: active.appId,
          intentId: active.intentId,
          runId,
          taskSlug: task.slug,
          text: `${task.title} failed after ${plural(turn, 'attempt', 'attempts')}.`,
        });
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
    if (ending.kind === 'provider') {
      // Interrupted, which gives the attempt back; no verdict, no advice —
      // the advice question would go to the same provider.
      if (task?.stored === 'in-progress') move(task, 'interrupted', ending.note);
      stopIntent(active, ending.reason);
      const runId = task?.runIds[task.runIds.length - 1] ?? null;
      remember({
        key: `${runId ?? `intent-${String(active.intentId)}`}:provider-error`,
        kind: 'provider-error',
        appId: active.appId,
        intentId: active.intentId,
        runId,
        taskSlug: task?.slug ?? null,
        text: ending.reason,
      });
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
        if (task?.stored === 'in-progress') ended(store.moveTask(task.id, 'interrupted', 'the run stopped on an error'));
      } catch {
        // The intent is still stopped below.
      }
      stopIntent(active, `The run stopped on an error: ${sanitise(message).slice(0, 300)}`);
    } finally {
      runEnded(active);
    }
  }

  /**
   * The turn in hand's progress, derived now from what the executor holds:
   * no timer of its own, and nothing written.
   */
  function progressOf(active: Active): RunProgress | null {
    const base = active.run;
    if (base === null) return null;
    const task = store.task(base.taskId);
    // The criteria: the last check when it ran any of this task's examples,
    // else the last verdict's, else nothing yet.
    let passed = 0;
    const total = task?.criteria.length ?? 0;
    if (task !== null) {
      const checks = new Map(states.get(active.appId).checks?.results.map((check) => [check.id, check.passed]) ?? []);
      const ids = task.criteria.map((criterion) => exampleIdFor(task.slug, criterion.id));
      passed = ids.some((id) => checks.has(id))
        ? ids.filter((id) => checks.get(id) === true).length
        : task.criteria.filter((criterion) => criterion.passed === true).length;
    }
    const files = new Set(active.taskFiles);
    if (task !== null && options.editedPaths !== undefined) {
      try {
        for (const path of options.editedPaths(task.runIds)) files.add(path);
      } catch (cause) {
        logger.error(`[autoapp] could not read what a task edited: ${String(cause instanceof Error ? cause.message : cause)}`);
      }
    }
    const soFar = options.usageSoFar?.(base.runId) ?? null;
    const refusal = active.lastRefusal;
    return {
      ...base,
      stage: stageOf(active.events),
      maxTurns,
      maxAttempts,
      quietSince: active.quietSince,
      idleLimitMs: idleTimeoutMs,
      turnLimitMs: turnTimeoutMs,
      filesChanged: files.size,
      criteria: { passed, total },
      lastRefusal: refusal === null ? null : { tool: refusal.route, reason: refusalError(refusal, 160) },
      tokens: { input: soFar?.inputTokens ?? 0, output: soFar?.outputTokens ?? 0 },
    };
  }

  /** Remember that a run finished or stopped, with the sentence the intent was left with. */
  function runEnded(active: Active): void {
    try {
      const intent = store.get(active.intentId)?.intent;
      if (intent === undefined) return;
      const finished = intent.status === 'done';
      remember({
        key: `intent-${String(active.intentId)}-${String(intent.startedAt ?? 0)}:run-ended`,
        kind: 'run-ended',
        appId: active.appId,
        intentId: active.intentId,
        runId: null,
        taskSlug: null,
        text: finished ? RUN_FINISHED : `The run stopped: ${intent.stopReason ?? 'no reason was given'}`,
      });
    } catch (cause) {
      logger.error(`[autoapp] could not note the end of a run: ${String(cause instanceof Error ? cause.message : cause)}`);
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
        providerError: null,
        toolCalls: 0,
        refusals: new Map(),
        landed: 0,
        turnRev: 'no-git',
        stuck: null,
        events: [],
        quietSince: Date.now(),
        taskFiles: new Set(),
        lastRefusal: null,
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
      return { run: progressOf(active), question: active.questions[0] ?? null };
    },

    recent() {
      return [...recentEvents].reverse();
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
