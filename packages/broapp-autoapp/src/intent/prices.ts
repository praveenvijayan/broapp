/**
 * What a model costs, in a file the person writes.
 *
 * `prices.json` in the launcher's data directory, beside `intent-models.json`
 * and read the same way: `{ "<modelId>": { "input": <USD per million
 * tokens>, "output": <USD per million tokens> }, "budget": { "day": <USD> } }`.
 * A missing file, an unreadable one and a model it does not name all mean the
 * same thing — no cost for that model, only its tokens.
 *
 * Nothing ships with a price in it and nothing fetches one. A price that is
 * wrong is worse than none: it is a number a person believes. A provider's
 * list changes without notice, a discount or a contract is not on it, and a
 * local model has no price at all. So the launcher counts tokens always and
 * dollars only where somebody said what a token costs.
 *
 * The budget is shown and never enforced. Stopping a run at a figure is a
 * decision about the person's work, and a backlog row, not a side effect.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { publicError } from 'broapp/host';

import { writeAtomic } from '../spec/store.ts';

/** The file, inside the launcher's own data directory. */
export const PRICES_FILE = 'prices.json';

/** The most models the file may price. */
export const MAX_PRICED_MODELS = 200;

/** One model's price, in US dollars per million tokens. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

/** Every price the person set, and the day's budget. */
export interface Prices {
  readonly models: Readonly<Record<string, ModelPrice>>;
  /** US dollars a day; `null` when none is set. */
  readonly budgetDay: number | null;
}

export const NO_PRICES: Prices = { models: {}, budgetDay: null };

/** A price's number: finite and not negative, or nothing. */
function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Read the prices, or none.
 *
 * A file that is not JSON, or not an object, prices nothing: a half-read
 * price list would put a cost on some models and silently not on others. An
 * entry that is not a price is left out, and its model has no cost.
 */
export function readPrices(dataDir: string): Prices {
  const path = join(dataDir, PRICES_FILE);
  if (!existsSync(path)) return NO_PRICES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return NO_PRICES;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_PRICES;
  const models: Record<string, ModelPrice> = {};
  let budgetDay: number | null = null;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (key === 'budget') {
      budgetDay = amount(record['day']);
      continue;
    }
    if (Object.keys(models).length >= MAX_PRICED_MODELS) break;
    const input = amount(record['input']);
    const output = amount(record['output']);
    if (key.length === 0 || key.length > 200 || input === null || output === null) continue;
    models[key] = { input, output };
  }
  return { models, budgetDay };
}

/** One row of a price list as a person sends it. */
export interface PriceEntry {
  readonly modelId: string;
  readonly input: number;
  readonly output: number;
}

/**
 * Replace the prices, atomically, after checking every number.
 *
 * Refused whole with a sentence naming the first thing wrong, rather than
 * written in part: a list that saved some rows and not others would show
 * costs the person never checked.
 */
export function writePrices(dataDir: string, entries: readonly PriceEntry[], budgetDay: number | null): Prices {
  if (entries.length > MAX_PRICED_MODELS) {
    throw publicError.invalidInput(`At most ${String(MAX_PRICED_MODELS)} models can be priced; ${String(entries.length)} were sent.`);
  }
  const models: Record<string, ModelPrice> = {};
  for (const entry of entries) {
    const id = entry.modelId.trim();
    if (id.length === 0 || id.length > 200) throw publicError.invalidInput('A model id is between 1 and 200 characters.');
    if (id === 'budget') throw publicError.invalidInput('"budget" is the name of the daily budget, not a model.');
    if (id in models) throw publicError.invalidInput(`${id} is priced twice.`);
    for (const [side, value] of [['input', entry.input], ['output', entry.output]] as const) {
      if (amount(value) === null) {
        throw publicError.invalidInput(`${id}: the ${side} price is a number of dollars per million tokens, zero or more.`);
      }
    }
    models[id] = { input: entry.input, output: entry.output };
  }
  if (budgetDay !== null && amount(budgetDay) === null) {
    throw publicError.invalidInput('The daily budget is a number of dollars, zero or more.');
  }
  const file: Record<string, unknown> = { ...models };
  if (budgetDay !== null) file['budget'] = { day: budgetDay };
  writeAtomic(join(dataDir, PRICES_FILE), `${JSON.stringify(file, null, 2)}\n`);
  return readPrices(dataDir);
}
