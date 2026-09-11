/**
 * Running acceptance examples against a preview child.
 *
 * Two callers and one loop: the engineer's `candidate.check`, and a replay or
 * an evaluation judging a candidate by an example it was never allowed to
 * change. A second copy of this that compared outputs differently would be a
 * second definition of "passed".
 */
import { canonicalJson } from 'broapp/host';

import type { ChildHandle } from '../launcher/supervisor.ts';
import type { AcceptanceExample } from '../spec/index.ts';

import type { CheckResult } from './state.ts';

/** How long one acceptance step may take. */
export const CHECK_STEP_TIMEOUT_MS = 30_000;

/**
 * Run each example's steps in order, over the child's IPC channel.
 *
 * Not over HTTP with its launch URL: that URL's token is single-use, and
 * spending it here is what left the person's Open preview answering 403.
 */
export async function runAcceptance(
  preview: ChildHandle,
  examples: readonly AcceptanceExample[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const example of examples) {
    try {
      let detail = '';
      let passed = true;
      for (const step of example.steps) {
        const output: unknown = await preview.invoke({
          route: step.route,
          input: step.input,
          client: 'launcher',
          requestId: crypto.randomUUID(),
          timeoutMs: CHECK_STEP_TIMEOUT_MS,
          as: 'check',
        });
        // Compared canonically: the order of an object's keys means nothing,
        // and an example that has been stored and read back — a case's, by its
        // content hash — has its keys sorted.
        if (step.expect !== undefined && canonicalJson(output) !== canonicalJson(step.expect)) {
          passed = false;
          detail = `${step.route} returned ${JSON.stringify(output)}, not ${JSON.stringify(step.expect)}`;
          break;
        }
      }
      results.push({ id: example.id, title: example.title, passed, ...(detail === '' ? {} : { detail }) });
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
