/**
 * Which kind of model a task needs, decided by the host.
 *
 * A model proposing a task also says how much reasoning it thinks the task
 * needs, but it never names the tier: that is this rule's answer, computed
 * from what the plan says, so a person can read why and a model cannot talk a
 * migration down to `light`. Every rule that fired leaves one sentence.
 */
import type { Label, Reasoning, Risk, Tier } from './types.ts';

/** The fields the rule reads. */
export interface TierInput {
  readonly risk: Risk;
  readonly labels: readonly Label[];
  readonly reasoning: Reasoning;
  readonly estimatedLines: number;
  readonly blockedBy: readonly string[];
}

/** The labels a `light` task may carry and nothing else. */
const LIGHT_LABELS: readonly Label[] = ['views', 'theme', 'copy'];

/** A task's tier and the sentences that say why. */
export function tierOf(task: TierInput): { tier: Tier; reasons: string[] } {
  const deep: string[] = [];
  if (task.risk === 'high') deep.push('It is marked high risk.');
  if (task.labels.includes('migration')) deep.push('It changes a migration.');
  if (task.reasoning === 'high') deep.push('It needs deep reasoning.');
  if (task.estimatedLines > 200) deep.push('It is estimated at more than 200 lines.');
  if (task.blockedBy.length >= 2) deep.push('It waits on two or more other tasks.');
  if (deep.length > 0) return { tier: 'deep', reasons: deep };

  const light =
    task.estimatedLines <= 60 &&
    task.reasoning === 'low' &&
    task.labels.every((label) => LIGHT_LABELS.includes(label));
  if (light) {
    return {
      tier: 'light',
      reasons: ['It is 60 lines or fewer, needs little reasoning, and touches only views, theme or copy.'],
    };
  }
  return { tier: 'standard', reasons: ['It is neither small enough to be light nor risky enough to be deep.'] };
}
