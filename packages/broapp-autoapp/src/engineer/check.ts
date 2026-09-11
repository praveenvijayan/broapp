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
import { isViewStep, type AcceptanceExample, type RouteStep, type ViewStep } from '../spec/index.ts';
import type { Component, Page, ViewsSpec } from '../views/index.ts';

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
export function stepFailure(step: RouteStep, output: unknown): string | null {
  if (step.expect !== undefined && canonicalJson(output) !== canonicalJson(step.expect)) {
    return `${step.route} returned ${JSON.stringify(output)}, not ${JSON.stringify(step.expect)}`;
  }
  if (step.match !== undefined && !contains(output, step.match)) {
    return `${step.route} returned ${JSON.stringify(output)}, which does not contain ${JSON.stringify(step.match)}`;
  }
  return null;
}

/** The component with this id anywhere on the page, or `null`. */
export function findComponent(page: Page, id: string): Component | null {
  const search = (components: readonly Component[]): Component | null => {
    for (const member of components) {
      if (member.id === id) return member;
      if (member.children !== undefined) {
        const found = search(member.children);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return search(page.children);
}

/**
 * Why the view specification does not satisfy a view step, or `null`.
 *
 * Judged against the specification the release carries, never against a page
 * in a browser: a step can say a button is declared with this label and this
 * operation, and cannot say the button is visible. {@link UNVERIFIED_BY_CHECKS}
 * is how a check reports that gap, every time.
 */
export function viewStepFailure(step: ViewStep, views: ViewsSpec | undefined): string | null {
  if (views === undefined) return 'the check was not given a view specification to judge against';
  const { page: pageId, component, exists = true, match } = step.view;
  const where = component === undefined ? `page ${pageId}` : `component ${component} on page ${pageId}`;
  const page = views.pages.find((candidate) => candidate.id === pageId);
  const target: Page | Component | null =
    page === undefined ? null : component === undefined ? page : findComponent(page, component);
  if (!exists) return target === null ? null : `${where} is declared, and the step says it must not be`;
  if (target === null) return `${where} is not declared`;
  if (match !== undefined && !contains(target, match)) {
    return `${where} is declared as ${JSON.stringify(target)}, which does not contain ${JSON.stringify(match)}`;
  }
  return null;
}

/** What no acceptance check can show, said the same way wherever results are reported. */
export const UNVERIFIED_BY_CHECKS =
  'What a browser shows. A route step proves the host, a view step proves the view specification; neither renders a page. Ask the person to open the preview and look.';

/** How many steps of each kind the examples hold, so a report can say what was covered. */
export function coverage(examples: readonly AcceptanceExample[]): { host: number; structure: number } {
  let host = 0;
  let structure = 0;
  for (const example of examples) {
    for (const step of example.steps) {
      if (isViewStep(step)) structure += 1;
      else host += 1;
    }
  }
  return { host, structure };
}

/**
 * Run each example's steps in order: view steps against the specification,
 * route steps over the child's IPC channel.
 *
 * Not over HTTP with its launch URL: that URL's token is single-use, and
 * spending it here is what left the person's Open preview answering 403.
 */
export async function runAcceptance(
  child: ChildHandle,
  examples: readonly AcceptanceExample[],
  views?: ViewsSpec,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const example of examples) {
    try {
      let detail: string | null = null;
      for (const step of example.steps) {
        if (isViewStep(step)) {
          detail = viewStepFailure(step, views);
          if (detail !== null) break;
          continue;
        }
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
