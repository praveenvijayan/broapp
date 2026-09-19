/**
 * What each turn used, and what that comes to.
 *
 * One row per turn in `intents.sqlite`'s `usage` table, written when the turn
 * ends. A turn cut short writes what its completed steps used and says it is
 * partial; a turn that used nothing anybody reported writes zeros and says
 * the same, because a turn that happened and whose cost is unknown is not a
 * turn that was free.
 *
 * Cost is never stored. It is computed when read, from the rows and the
 * prices the person has written today, so correcting a price corrects every
 * day before it. A total that includes a partial row or a running turn is a
 * floor and says so; a total that includes a model nobody priced says how many
 * tokens it left out; and a total with nothing priced has no cost at all,
 * never zero.
 */
import type { IntentStore } from './store.ts';
import type { Prices } from './prices.ts';

/** One turn's row. */
export interface UsageRow {
  readonly runId: string;
  readonly appId: string | null;
  readonly taskId: number | null;
  readonly modelId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly partial: boolean;
  /** Tool round trips the turn made. */
  readonly steps: number;
  readonly ms: number;
  readonly endedAt: number;
}

/** A whole number of tokens or milliseconds; anything else is none. */
function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Write one turn's row. A run id written twice keeps the newer row. */
export function recordUsage(store: Pick<IntentStore, 'db'>, row: UsageRow): void {
  store.db
    .query<null, [string, string | null, number | null, string | null, number, number, number, number, number, number]>(
      `INSERT OR REPLACE INTO usage
         (run_id, app_id, task_id, model_id, input_tokens, output_tokens, partial, steps, ms, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.runId,
      row.appId,
      row.taskId,
      row.modelId,
      whole(row.inputTokens),
      whole(row.outputTokens),
      row.partial ? 1 : 0,
      whole(row.steps),
      whole(row.ms),
      whole(row.endedAt),
    );
}

/**
 * A turn's row from what `onRunEnd` was told.
 *
 * `usage` is absent when no step of the turn completed; it carries
 * `partial: true` when some did and the turn did not finish.
 */
export function usageRowOf(input: {
  readonly runId: string;
  readonly appId: string | null;
  readonly taskId: number | null;
  readonly modelId: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
  readonly steps: number;
  readonly ms: number;
  readonly endedAt: number;
}): UsageRow {
  const usage = input.usage;
  const partial = usage === undefined || (usage as { partial?: unknown }).partial === true;
  return {
    runId: input.runId,
    appId: input.appId,
    taskId: input.taskId,
    modelId: input.modelId,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    partial,
    steps: input.steps,
    ms: input.ms,
    endedAt: input.endedAt,
  };
}

/** Tokens used by one model, and whether any of them is only a floor. */
export interface UsagePart {
  readonly modelId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Some of it came from a partial row or a running turn. */
  readonly partial: boolean;
}

/** A total, said honestly. */
export interface SpendTotal {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** US dollars for the priced part; `null` when nothing in it is priced. */
  readonly cost: number | null;
  /** True when a partial row or a running turn is in it: the real figure is at least this. */
  readonly atLeast: boolean;
  /** Tokens of models with no price, which `cost` does not cover. */
  readonly unpricedTokens: number;
}

/** What one model's part costs, or `null` when the person has not priced it. */
export function costOf(part: Pick<UsagePart, 'modelId' | 'inputTokens' | 'outputTokens'>, prices: Prices): number | null {
  const price = part.modelId === null ? undefined : prices.models[part.modelId];
  if (price === undefined) return null;
  return (part.inputTokens * price.input + part.outputTokens * price.output) / 1e6;
}

/**
 * Add parts up.
 *
 * Nothing at all is an exact zero. Anything that ran and whose model nobody
 * priced has no cost: `null`, never `0`, because `0` is a claim that it was
 * free.
 */
export function spendOf(parts: readonly UsagePart[], prices: Prices): SpendTotal {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let priced = false;
  let atLeast = false;
  let unpricedTokens = 0;
  for (const part of parts) {
    inputTokens += part.inputTokens;
    outputTokens += part.outputTokens;
    if (part.partial) atLeast = true;
    const partCost = costOf(part, prices);
    if (partCost === null) unpricedTokens += part.inputTokens + part.outputTokens;
    else {
      cost += partCost;
      priced = true;
    }
  }
  return {
    inputTokens,
    outputTokens,
    cost: priced ? cost : parts.length === 0 ? 0 : null,
    atLeast,
    unpricedTokens,
  };
}

/** Local midnight of the day `now` falls in, on the machine the launcher runs on. */
export function startOfToday(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The rows matching a condition, summed by model. */
function partsWhere(store: Pick<IntentStore, 'db'>, where: string, params: (string | number)[]): UsagePart[] {
  return store.db
    .query<{ model_id: string | null; i: number; o: number; p: number }, (string | number)[]>(
      `SELECT model_id, SUM(input_tokens) AS i, SUM(output_tokens) AS o, MAX(partial) AS p
         FROM usage WHERE ${where} GROUP BY model_id ORDER BY model_id`,
    )
    .all(...params)
    .map((row) => ({ modelId: row.model_id, inputTokens: row.i, outputTokens: row.o, partial: row.p === 1 }));
}

/** Everything used since local midnight, by model. */
export function usageToday(store: Pick<IntentStore, 'db'>, now: number): UsagePart[] {
  return partsWhere(store, 'ended_at >= ?', [startOfToday(now)]);
}

/** Everything one task's turns used, by model: its builder turns and the advice about it. */
export function usageOfTask(store: Pick<IntentStore, 'db'>, taskId: number): UsagePart[] {
  return partsWhere(store, 'task_id = ?', [taskId]);
}

/** Everything the tasks of one intent used since `since`: the run in hand. */
export function usageOfRun(store: Pick<IntentStore, 'db'>, intentId: number, since: number): UsagePart[] {
  return partsWhere(store, 'task_id IN (SELECT id FROM tasks WHERE intent_id = ?) AND ended_at >= ?', [intentId, since]);
}

/** Parts with the same model folded into one. */
export function mergeParts(parts: readonly UsagePart[]): UsagePart[] {
  const byModel = new Map<string | null, UsagePart>();
  for (const part of parts) {
    const seen = byModel.get(part.modelId);
    byModel.set(
      part.modelId,
      seen === undefined
        ? part
        : {
            modelId: part.modelId,
            inputTokens: seen.inputTokens + part.inputTokens,
            outputTokens: seen.outputTokens + part.outputTokens,
            partial: seen.partial || part.partial,
          },
    );
  }
  return [...byModel.values()];
}

/** What the rest of an application's backlog may take. */
export interface Estimate {
  readonly ms: number;
  readonly tokens: number;
  /** Always true: this is a mean of what went before, not a promise. */
  readonly estimate: true;
}

/** How many completed tasks an estimate needs before it says anything. */
export const ESTIMATE_MIN_TASKS = 2;

/**
 * The mean of an application's completed tasks' turns, times the tasks left.
 *
 * `null` until two tasks of this application have completed, and `null`
 * whenever any of them has a partial row or no row at all: a mean over
 * figures that are floors, or over a task whose cost nobody recorded, is a
 * number that looks known and is not. Never across applications, and never
 * from a plan's own guess at its size.
 */
export function estimateFor(store: Pick<IntentStore, 'db'>, appId: string, tasksLeft: number): Estimate | null {
  const rows = store.db
    .query<{ id: number; ms: number | null; tokens: number | null; p: number | null; n: number }, [string]>(
      `SELECT t.id AS id, SUM(u.ms) AS ms, SUM(u.input_tokens + u.output_tokens) AS tokens,
              MAX(u.partial) AS p, COUNT(u.run_id) AS n
         FROM tasks t LEFT JOIN usage u ON u.task_id = t.id
        WHERE t.app_id = ? AND t.status = 'completed'
        GROUP BY t.id`,
    )
    .all(appId);
  if (rows.length < ESTIMATE_MIN_TASKS) return null;
  if (rows.some((row) => row.n === 0 || row.p !== 0)) return null;
  const mean = (pick: (row: (typeof rows)[number]) => number): number => rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
  return {
    ms: Math.round(mean((row) => row.ms ?? 0) * tasksLeft),
    tokens: Math.round(mean((row) => row.tokens ?? 0) * tasksLeft),
    estimate: true,
  };
}
