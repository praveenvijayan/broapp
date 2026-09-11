/**
 * Running acceptance examples against a child.
 *
 * Every caller that decides whether an example passed comes through here: the
 * engineer's `candidate.check`, activation's check step, and a replay or an
 * evaluation judging a candidate by an example it was never allowed to change.
 * A second copy of this that compared outputs differently would be a second
 * definition of "passed" — 12d found exactly that, activation comparing by
 * `JSON.stringify` while the preview compared canonically, so an example could
 * pass one and fail the other on key order alone.
 */
import { canonicalJson } from 'broapp/host';

import type { ChildHandle } from '../launcher/supervisor.ts';
import type { AcceptanceExample, AcceptanceStep } from '../spec/index.ts';

import type { CheckResult } from './state.ts';

/** How long one acceptance step may take. */
export const CHECK_STEP_TIMEOUT_MS = 30_000;

/**
 * Whether `actual` contains `wanted`: every key `wanted` names, recursively; an
 * array of the same length, element by element; anything else equal.
 *
 * Arrays are matched by length on purpose. "The list holds this one note" must
 * fail when the list also holds the note that should have gone, and must fail
 * when the list is empty — which is what a stubbed route returns.
 */
export function contains(actual: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    return Array.isArray(actual) && actual.length === wanted.length && wanted.every((item, index) => contains(actual[index], item));
  }
  if (typeof wanted === 'object' && wanted !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(wanted).every(
      ([key, value]) => Object.prototype.hasOwnProperty.call(record, key) && contains(record[key], value),
    );
  }
  return canonicalJson(actual) === canonicalJson(wanted);
}

/**
 * Why one step's output does not satisfy it, or `null` when it does.
 *
 * `expect` is compared canonically, because the order of an object's keys means
 * nothing and an example that has been stored and read back has its keys
 * sorted. `match` is compared with {@link contains}.
 */
export function stepFailure(step: AcceptanceStep, output: unknown): string | null {
  if (step.expect !== undefined && canonicalJson(output) !== canonicalJson(step.expect)) {
    return `${step.route} returned ${JSON.stringify(output)}, not ${JSON.stringify(step.expect)}`;
  }
  if (step.match !== undefined && !contains(output, step.match)) {
    return `${step.route} returned ${JSON.stringify(output)}, which does not contain ${JSON.stringify(step.match)}`;
  }
  return null;
}

/**
 * Run each example's steps in order, over the child's IPC channel.
 *
 * Not over HTTP with its launch URL: that URL's token is single-use, and
 * spending it here is what left the person's Open preview answering 403.
 */
export async function runAcceptance(
  child: ChildHandle,
  examples: readonly AcceptanceExample[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const example of examples) {
    try {
      let detail: string | null = null;
      for (const step of example.steps) {
        const output: unknown = await child.invoke({
          route: step.route,
          input: step.input,
          client: 'launcher',
          requestId: crypto.randomUUID(),
          timeoutMs: CHECK_STEP_TIMEOUT_MS,
          as: 'check',
        });
        detail = stepFailure(step, output);
        if (detail !== null) break;
      }
      results.push({ id: example.id, title: example.title, passed: detail === null, ...(detail === null ? {} : { detail }) });
    } catch (cause) {
      results.push({
        id: example.id,
        title: example.title,
        passed: false,
        detail: String(cause instanceof Error ? cause.message : cause),
      });
    }
  }
  return results;
}
