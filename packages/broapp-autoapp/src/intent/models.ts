/**
 * Which model runs a task of each tier.
 *
 * One small file in the launcher's data directory, `{ light, standard, deep }`,
 * each a model reference or `null`. `null` means the model configured in
 * Settings, which is also what a missing or unreadable file means: a setting
 * nobody made should change nothing.
 *
 * A reference is the AI layer's convention (`broapp/ai`'s `parseModelRef`):
 * a bare id is a model of the provider in use, and `<provider>:<model>` —
 * `ollama:qwen3:27b` — a model of that provider, with its own key and address.
 * A task's `modelOverride` is the same. A reference naming a provider the
 * person has not turned on in Settings is refused before anything is sent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeAtomic } from '../spec/store.ts';

import type { Tier } from './types.ts';

/** The file, inside the launcher's own data directory. */
export const INTENT_MODELS_FILE = 'intent-models.json';

/** A model reference per tier; `null` is the Settings model. */
export type TierModels = Readonly<Record<Tier, string | null>>;

export const DEFAULT_TIER_MODELS: TierModels = { light: null, standard: null, deep: null };

function modelId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/** Read the mapping, or the default when there is none or it cannot be read. */
export function readTierModels(dataDir: string): TierModels {
  const path = join(dataDir, INTENT_MODELS_FILE);
  if (!existsSync(path)) return DEFAULT_TIER_MODELS;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_TIER_MODELS;
    const record = parsed as Record<string, unknown>;
    return { light: modelId(record['light']), standard: modelId(record['standard']), deep: modelId(record['deep']) };
  } catch {
    return DEFAULT_TIER_MODELS;
  }
}

/** Replace the mapping, atomically. */
export function writeTierModels(dataDir: string, models: TierModels): void {
  const clean: TierModels = { light: modelId(models.light), standard: modelId(models.standard), deep: modelId(models.deep) };
  writeAtomic(join(dataDir, INTENT_MODELS_FILE), `${JSON.stringify(clean, null, 2)}\n`);
}

/** The model a task runs on: its own override, else its tier's, else `null` for Settings. */
export function modelFor(task: { readonly modelOverride: string | null; readonly tier: Tier }, mapping: TierModels): string | null {
  return task.modelOverride ?? mapping[task.tier];
}
