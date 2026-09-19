/**
 * One read for the person who has just come back to the launcher.
 *
 * What needs them, what is running and at what stage, what it has cost, what
 * is left, and what each application is doing — assembled from the stores the
 * panels already read, in one call. It starts nothing and writes nothing: every
 * part of it is a read of something another part of the launcher keeps.
 *
 * {@link needsYouOf} is the one rule for what needs the person, and it is pure,
 * so it can be tested without a launcher: four sources and no others.
 */
import { type Executor, type IntentStore, type RunEvent, type RunProgress, type RunQuestion, type TaskRecord } from '../intent/index.ts';
import { NO_PRICES, readPrices, type Prices } from '../intent/prices.ts';
import {
  estimateFor,
  mergeParts,
  spendOf,
  usageOfRun,
  usageOfTask,
  usageToday,
  type Estimate,
  type SpendTotal,
  type UsagePart,
} from '../intent/usage.ts';
import type { CandidateStates, StoredChecks } from '../engineer/state.ts';
import { readCurrent, readRelease, type Layout } from '../spec/index.ts';

import { listApps, type AppRow } from './apps.ts';
import type { Journal } from './journal.ts';
import type { Supervisor } from './supervisor.ts';

/** What a live turn has used so far, kept by the tab from the AI layer's `onUsageSoFar`. */
export interface LiveUsage {
  readonly runId: string;
  inputTokens: number;
  outputTokens: number;
  modelId: string | null;
  appId: string | null;
  taskId: number | null;
}

/** Which panel an item opens, and on which record. */
export interface NeedsYouTarget {
  readonly panel: 'backlog' | 'candidate';
  readonly appId: string;
  readonly intentId: number | null;
  readonly taskId: number | null;
  readonly releaseId: string | null;
}

/** The four things that need a person. */
export type NeedsYouKind = 'question' | 'answer' | 'advice' | 'activate';

/** One thing that needs the person. */
export interface NeedsYouItem {
  /** Stable while the thing itself is the same, so a page can tell a new item from an old one. */
  readonly key: string;
  readonly kind: NeedsYouKind;
  readonly appId: string;
  /** At most 80 characters. */
  readonly title: string;
  readonly detail: string;
  /** When it began needing them; the list is newest first by this. */
  readonly at: number;
  /** When a question stops waiting; `null` for anything else. */
  readonly expiresAt: number | null;
  readonly target: NeedsYouTarget;
}

/** A candidate as {@link needsYouOf} reads it. */
export interface CandidateView {
  readonly appId: string;
  readonly name: string;
  /** The last successful build, if any. */
  readonly releaseId: string | null;
  /** The release serving now. */
  readonly current: string | null;
  readonly checks: StoredChecks | null;
}

/** The longest title an item has. */
export const TITLE_CHARS = 80;
/** The longest detail line an item has. */
const DETAIL_CHARS = 400;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** A tool's name and the application it names, as a question's title. */
function questionTitle(question: RunQuestion, appId: string): string {
  const named = (question.input as { appId?: unknown } | null | undefined)?.appId;
  return typeof named === 'string' && named !== appId
    ? `The run asks to use ${question.tool} on ${named}`
    : `The run asks to use ${question.tool}`;
}

/** The advice stored on a failed task, when it is advice. */
function adviceOf(task: TaskRecord): { advice: string; note: string; at: number } | null {
  const advice = task.advice as { advice?: unknown; note?: unknown; at?: unknown } | null;
  if (advice === null || typeof advice !== 'object') return null;
  if (typeof advice.advice !== 'string' || typeof advice.note !== 'string') return null;
  return { advice: advice.advice, note: advice.note, at: typeof advice.at === 'number' ? advice.at : (task.endedAt ?? 0) };
}

/** Whether a candidate's checks all passed on its own build, and it is not what serves. */
export function readyToActivate(candidate: CandidateView): boolean {
  const { releaseId, checks } = candidate;
  if (releaseId === null || releaseId === candidate.current) return false;
  if (checks === null || checks.releaseId !== releaseId || checks.results.length === 0) return false;
  return checks.results.every((check) => check.passed);
}

/**
 * What needs the person, newest first, from four sources and no others: a
 * question a run is waiting on, a task that asked something, a task that
 * failed with advice nobody has answered yet, and a candidate whose checks all
 * passed and is not the serving release.
 *
 * A candidate is ready only on its own checks — checks run on the release it
 * is, every one passing — so a build that does not load, whose preview never
 * started, has no checks of its own and is not here.
 */
export function needsYouOf(input: {
  readonly question: (RunQuestion & { readonly appId: string; readonly intentId: number; readonly taskId: number | null }) | null;
  readonly tasks: readonly TaskRecord[];
  readonly candidates: readonly CandidateView[];
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const question = input.question;
  if (question !== null) {
    items.push({
      key: `question:${question.runId}:${question.callId}`,
      kind: 'question',
      appId: question.appId,
      title: cut(questionTitle(question, question.appId), TITLE_CHARS),
      detail: cut(`A backlog run on ${question.appId} is waiting for you to allow or deny ${question.tool}.`, DETAIL_CHARS),
      at: question.askedAt,
      expiresAt: question.expiresAt,
      target: { panel: 'backlog', appId: question.appId, intentId: question.intentId, taskId: question.taskId, releaseId: null },
    });
  }
  for (const task of input.tasks) {
    if (task.stored === 'needs-answer' && task.question !== null) {
      items.push({
        key: `answer:${String(task.id)}:${String(task.answers.length)}`,
        kind: 'answer',
        appId: task.appId,
        title: cut(task.question, TITLE_CHARS),
        detail: cut(`${task.slug} waits for your answer before it runs again.`, DETAIL_CHARS),
        at: task.endedAt ?? 0,
        expiresAt: null,
        target: { panel: 'backlog', appId: task.appId, intentId: task.intentId, taskId: task.id, releaseId: null },
      });
      continue;
    }
    if (task.stored !== 'failed') continue;
    const advice = adviceOf(task);
    if (advice === null) continue;
    // Answered once the person has said something since the advice came.
    if (task.answers.some((answer) => answer.at >= advice.at)) continue;
    items.push({
      key: `advice:${String(task.id)}:${String(advice.at)}`,
      kind: 'advice',
      appId: task.appId,
      title: cut(`${task.title} failed`, TITLE_CHARS),
      detail: cut(`Advice: ${advice.advice}. ${advice.note}`, DETAIL_CHARS),
      at: advice.at,
      expiresAt: null,
      target: { panel: 'backlog', appId: task.appId, intentId: task.intentId, taskId: task.id, releaseId: null },
    });
  }
  for (const candidate of input.candidates) {
    if (!readyToActivate(candidate) || candidate.checks === null || candidate.releaseId === null) continue;
    const total = candidate.checks.results.length;
    items.push({
      key: `activate:${candidate.appId}:${candidate.releaseId}`,
      kind: 'activate',
      appId: candidate.appId,
      title: cut(`${candidate.name} is ready to activate`, TITLE_CHARS),
      detail: cut(`Build ${candidate.releaseId.slice(0, 8)} passed ${String(total)} of ${String(total)} checks.`, DETAIL_CHARS),
      at: candidate.checks.at,
      expiresAt: null,
      target: { panel: 'candidate', appId: candidate.appId, intentId: null, taskId: null, releaseId: candidate.releaseId },
    });
  }
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** The run in hand, with where it is. */
export type RunningBlock = RunProgress & {
  readonly appId: string;
  readonly appName: string;
  readonly intentId: number;
  readonly taskSlug: string;
  readonly taskTitle: string;
  /** Where the task is in its intent's run order, from 1, removed tasks left out. */
  readonly taskIndex: number;
  readonly taskCount: number;
  /** The model the turn runs on: the task's own, else its tier's, else Settings'. */
  readonly modelId: string | null;
};

/** One application with an open intent: what is left of its backlog. */
export interface BacklogBlock {
  readonly appId: string;
  readonly appName: string;
  readonly intentIds: readonly number[];
  readonly done: number;
  readonly failed: number;
  readonly running: number;
  /** Planned, queued, interrupted or waiting for an answer: not running, not blocked. */
  readonly queued: number;
  readonly blocked: number;
  /** Every task not removed. */
  readonly total: number;
  readonly estimate: Estimate | null;
}

/** One application, as the overview shows it. */
export interface AppBlock extends AppRow {
  /**
   * `building` while a backlog run works on it; `needs-review` when something
   * about it needs the person; else whether it is serving.
   */
  readonly state: 'serving' | 'stopped' | 'building' | 'needs-review';
  /** Its candidate's own checks, when it has some. */
  readonly checks: { readonly passed: number; readonly total: number } | null;
  /** The newest of its serving release, its last build and its last check. */
  readonly changedAt: number | null;
}

/** Tokens and cost by model, for today. */
export interface ModelSpend {
  readonly modelId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number | null;
  readonly atLeast: boolean;
}

/** What `launcher.overview` returns. */
export interface Overview {
  readonly needsYou: readonly NeedsYouItem[];
  readonly running: RunningBlock | null;
  readonly spend: {
    /** The task in hand, its turns in every run; `null` with nothing running. */
    readonly task: SpendTotal | null;
    /** The run in hand, since it started; `null` with nothing running. */
    readonly run: SpendTotal | null;
    /** Since local midnight, every turn the launcher ran. */
    readonly today: SpendTotal;
    readonly budgetDay: number | null;
    readonly todayByModel: readonly ModelSpend[];
  };
  readonly backlog: readonly BacklogBlock[];
  readonly apps: readonly AppBlock[];
  /** What happened in runs since the launcher started, newest first: what alerts are raised from. */
  readonly recent: readonly RunEvent[];
}

/** What {@link readOverview} reads. */
export interface OverviewSources {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly states: CandidateStates;
  readonly intents?: IntentStore;
  readonly executor?: Executor;
  /** The live turns' subtotals. */
  readonly live?: () => readonly LiveUsage[];
  /** The tier models, to name the model a running task is on. */
  readonly modelOf?: (task: TaskRecord) => string | null;
  readonly now?: () => number;
}

function liveParts(live: readonly LiveUsage[]): UsagePart[] {
  return live.map((entry) => ({
    modelId: entry.modelId,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    partial: true,
  }));
}

/** Assemble the overview. Reads only. */
export function readOverview(sources: OverviewSources): Overview {
  const now = sources.now?.() ?? Date.now();
  const { layout, states, intents, executor } = sources;
  const rows = listApps(layout, sources.supervisor, sources.journal);
  const nameOf = new Map(rows.map((row) => [row.appId, row.name]));
  const live = sources.live?.() ?? [];
  const prices: Prices = intents === undefined ? NO_PRICES : readPrices(intents.dataDir);

  // The run in hand.
  const active = executor?.active() ?? null;
  const progress = active === null || executor === undefined ? null : executor.progress(active.intentId);
  let running: RunningBlock | null = null;
  let runTask: TaskRecord | null = null;
  if (active !== null && progress?.run != null && intents !== undefined) {
    const run = progress.run;
    runTask = intents.task(run.taskId);
    const order = intents.runOrder(active.intentId).filter((task) => task.stored !== 'removed');
    const index = order.findIndex((task) => task.id === run.taskId);
    running = {
      ...run,
      appId: active.appId,
      appName: nameOf.get(active.appId) ?? active.appId,
      intentId: active.intentId,
      taskSlug: runTask?.slug ?? '',
      taskTitle: runTask?.title ?? '',
      taskIndex: index + 1,
      taskCount: order.length,
      modelId: live.find((entry) => entry.runId === run.runId)?.modelId ?? (runTask === null ? null : (sources.modelOf?.(runTask) ?? null)),
    };
  }

  // Spend. A running turn's subtotal is in every total that covers it, and
  // makes that total a floor.
  const runningLive = running === null ? [] : live.filter((entry) => entry.runId === running.runId);
  const todayParts = intents === undefined ? [] : usageToday(intents, now);
  const allToday = mergeParts([...todayParts, ...liveParts(live)]);
  let taskSpend: SpendTotal | null = null;
  let runSpend: SpendTotal | null = null;
  if (running !== null && intents !== undefined) {
    const startedAt = intents.get(running.intentId)?.intent.startedAt ?? running.startedAt;
    taskSpend = spendOf(mergeParts([...usageOfTask(intents, running.taskId), ...liveParts(runningLive)]), prices);
    runSpend = spendOf(mergeParts([...usageOfRun(intents, running.intentId, startedAt), ...liveParts(runningLive)]), prices);
  }
  const todayByModel: ModelSpend[] = allToday.map((part) => {
    const total = spendOf([part], prices);
    return { modelId: part.modelId, inputTokens: part.inputTokens, outputTokens: part.outputTokens, cost: total.cost, atLeast: total.atLeast };
  });

  // What needs the person.
  const question = progress?.question ?? null;
  const candidates: CandidateView[] = rows.map((row) => {
    const state = states.get(row.appId);
    return { appId: row.appId, name: row.name, releaseId: state.releaseId, current: row.currentRelease, checks: state.checks };
  });
  const needsYou = needsYouOf({
    question:
      question === null || active === null
        ? null
        : { ...question, appId: active.appId, intentId: active.intentId, taskId: progress?.run?.taskId ?? null },
    tasks: intents === undefined ? [] : intents.tasksIn(['needs-answer', 'failed']),
    candidates,
  });

  // What is left, per application with an open intent.
  const backlog: BacklogBlock[] = [];
  if (intents !== undefined) {
    for (const row of rows) {
      const open = intents.live(row.appId);
      if (open.length === 0) continue;
      let done = 0;
      let failed = 0;
      let runningCount = 0;
      let queued = 0;
      let blocked = 0;
      for (const intent of open) {
        for (const task of intents.runOrder(intent.id)) {
          if (task.status === 'removed') continue;
          if (task.status === 'completed') done += 1;
          else if (task.status === 'failed') failed += 1;
          else if (task.status === 'in-progress') runningCount += 1;
          else if (task.status === 'blocked') blocked += 1;
          else queued += 1;
        }
      }
      const total = done + failed + runningCount + queued + blocked;
      backlog.push({
        appId: row.appId,
        appName: row.name,
        intentIds: open.map((intent) => intent.id),
        done,
        failed,
        running: runningCount,
        queued,
        blocked,
        total,
        estimate: estimateFor(intents, row.appId, total - done),
      });
    }
  }

  // Each application, and what it is doing.
  const needing = new Set(needsYou.map((item) => item.appId));
  const apps: AppBlock[] = rows.map((row) => {
    const candidate = states.get(row.appId);
    const own = candidate.checks !== null && candidate.checks.releaseId === candidate.releaseId ? candidate.checks : null;
    const state: AppBlock['state'] =
      active?.appId === row.appId ? 'building' : needing.has(row.appId) ? 'needs-review' : row.serving ? 'serving' : 'stopped';
    let released: number | null = null;
    const current = row.currentRelease ?? readCurrent(layout, row.appId);
    if (current !== null) {
      try {
        released = readRelease(layout, row.appId, current).manifest.createdAt;
      } catch {
        released = null;
      }
    }
    const times = [released, candidate.builtAt, candidate.checks?.at ?? null].filter((at): at is number => at !== null);
    return {
      ...row,
      state,
      checks: own === null ? null : { passed: own.results.filter((check) => check.passed).length, total: own.results.length },
      changedAt: times.length === 0 ? null : Math.max(...times),
    };
  });

  return {
    needsYou,
    running,
    spend: { task: taskSpend, run: runSpend, today: spendOf(allToday, prices), budgetDay: prices.budgetDay, todayByModel },
    backlog,
    apps,
    recent: executor?.recent() ?? [],
  };
}

