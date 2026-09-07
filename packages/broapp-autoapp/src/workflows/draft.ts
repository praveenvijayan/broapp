/**
 * Turning a run that worked into something that can be run again.
 *
 * The draft is deliberately literal: the same routes, in the same order, with
 * exactly the arguments that were used. Nothing is generalised, because
 * guessing which argument was "the variable one" is how a saved workflow ends
 * up doing something slightly different from what the person watched it do.
 * Parameterising is a separate, explicit act.
 *
 * A run with an `unknown` step cannot be drafted at all. An unknown step is one
 * whose outcome nobody recorded — the process died between the call and the
 * record — and a workflow built from it would replay something that may already
 * have happened.
 */
import { publicError } from 'broapp/host';

import type { ContractExport } from '../spec/types.ts';
import type { RunStep, RunSummary } from '../host/run-store.ts';

import type { WorkflowDefinition, WorkflowParam, WorkflowStep } from './types.ts';
import { parseWorkflow } from './validate.ts';

/** One literal a person chose to turn into a parameter. */
export interface ParameterPick {
  readonly stepId: string;
  /** Dotted path into that step's `input`. Empty means the whole input. */
  readonly inputPath: string;
  readonly paramName: string;
  readonly type: WorkflowParam['type'];
  readonly label: string;
}

/** A step id derived from a route, so a draft reads as what it does. */
function stepIdFor(route: string, taken: ReadonlySet<string>): string {
  const base = route.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, '');
  let candidate = base === '' ? 'step' : base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${String(n)}`;
    n += 1;
  }
  return candidate;
}

/** Draft a workflow from a recorded run. */
export function draftFromRun(
  run: RunSummary,
  steps: readonly RunStep[],
  contract: ContractExport,
): WorkflowDefinition {
  if (run.status === 'unknown' || steps.some((step) => step.outcome === 'unknown')) {
    throw publicError.conflict(
      'this run has a step with an unknown outcome and cannot be saved as a workflow',
    );
  }

  const taken = new Set<string>();
  const drafted: WorkflowStep[] = [];
  for (const step of steps) {
    // Only what actually ran and worked. A denied step is a thing the person
    // said no to, and a failed one is a thing that did not happen.
    if (step.decision !== 'allowed' && step.decision !== 'confirmed') continue;
    if (step.outcome !== 'succeeded') continue;
    const id = stepIdFor(step.route, taken);
    taken.add(id);
    drafted.push({ id, route: step.route, input: step.input });
  }

  if (drafted.length === 0) {
    throw publicError.conflict('this run has no successful steps to save');
  }
  return parseWorkflow({ version: 1, params: [], steps: drafted, onFailure: 'stop' }, contract);
}

/** Replace one value inside a JSON structure, without touching the original. */
function replaceAt(value: unknown, path: readonly string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return value;
    return value.map((member, at) => (at === index ? replaceAt(member, rest, replacement) : member));
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    if (!(head in source)) return value;
    return { ...source, [head]: replaceAt(source[head], rest, replacement) };
  }
  return value;
}

/**
 * Turn chosen literals into parameters.
 *
 * Only the picks are touched. The same literal appearing elsewhere in the same
 * workflow is left exactly as it was — two arguments that happen to be equal
 * are not thereby the same argument, and deciding otherwise on a person's
 * behalf is the kind of cleverness that produces a workflow they did not mean.
 */
export function parameterise(
  definition: WorkflowDefinition,
  picks: readonly ParameterPick[],
): WorkflowDefinition {
  let steps: readonly WorkflowStep[] = definition.steps;
  const params: WorkflowParam[] = [...definition.params];

  for (const pick of picks) {
    if (!steps.some((step) => step.id === pick.stepId)) {
      throw publicError.invalidInput(`this workflow has no step ${JSON.stringify(pick.stepId)}`);
    }
    if (params.some((param) => param.name === pick.paramName)) {
      throw publicError.invalidInput(`parameter ${JSON.stringify(pick.paramName)} is declared twice`);
    }
    const path = pick.inputPath === '' ? [] : pick.inputPath.split('.');
    steps = steps.map((step) =>
      step.id === pick.stepId
        ? { ...step, input: replaceAt(step.input, path, `$param.${pick.paramName}`) }
        : step,
    );
    params.push({ name: pick.paramName, type: pick.type, label: pick.label, required: true });
  }

  return parseWorkflow({ ...definition, params, steps });
}
