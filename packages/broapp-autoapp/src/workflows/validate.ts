/**
 * Checking a workflow before anybody runs it.
 *
 * The shape checks are ordinary. The ones worth having are the structural
 * ones — a `$step` reference pointing forwards, a parameter nobody declared, a
 * route the application no longer has. Each of those is a workflow that looks
 * fine in a list and fails halfway through, after some of its steps have
 * already changed something.
 */
import { s, ValidationError } from 'broapp/shared';
import type { Issue } from 'broapp/shared';

import type { ContractExport } from '../spec/types.ts';

import type { WorkflowDefinition, WorkflowStep } from './types.ts';

/** A parameter name: a plain identifier, so `$param.<name>` is unambiguous. */
const PARAM_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
/** A step id, in the same shape as every other id a person sees. */
const STEP_PATTERN = /^[a-z][a-z0-9-]*$/;

const definitionShape = s.object({
  version: s.number({ int: true, min: 1, max: 1 }),
  params: s.array(
    s.object({
      name: s.string({ pattern: PARAM_PATTERN, max: 60 }),
      type: s.enum(['text', 'number', 'boolean']),
      label: s.string({ min: 1, max: 200 }),
      required: s.optional(s.boolean()),
    }),
    { max: 50 },
  ),
  steps: s.array(
    s.object({
      id: s.string({ pattern: STEP_PATTERN, max: 60 }),
      route: s.string({ min: 1, max: 200 }),
      input: s.unknown(),
      skipWhen: s.optional(
        s.object({
          step: s.string({ pattern: STEP_PATTERN, max: 60 }),
          path: s.string({ max: 200 }),
          equals: s.unknown(),
        }),
      ),
    }),
    { min: 1, max: 200 },
  ),
  onFailure: s.enum(['stop']),
});

/** Every `$param.x` and `$step.y.z` inside a value, however deeply nested. */
function referencesIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string' && value.startsWith('$')) found.push(value);
  else if (Array.isArray(value)) for (const member of value) referencesIn(member, found);
  else if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value as Record<string, unknown>)) referencesIn(member, found);
  }
  return found;
}

/** Everything that is about more than one field. */
function crossCheck(definition: WorkflowDefinition, contract: ContractExport | null): Issue[] {
  const issues: Issue[] = [];
  const params = new Set(definition.params.map((param) => param.name));
  /** Step ids seen *so far*, so a forward reference is one that is not in here yet. */
  const earlier = new Set<string>();

  for (const [index, step] of definition.steps.entries()) {
    const at = ['steps', index] as const;
    if (earlier.has(step.id)) {
      issues.push({ path: [...at, 'id'], message: `step id ${JSON.stringify(step.id)} is used twice` });
    }

    if (contract !== null && !Object.prototype.hasOwnProperty.call(contract.operations, step.route)) {
      issues.push({
        path: [...at, 'route'],
        message: `route ${JSON.stringify(step.route)} is not an operation in this application`,
      });
    }

    for (const reference of referencesIn(step.input)) {
      const problem = referenceProblem(reference, params, earlier);
      if (problem !== null) issues.push({ path: [...at, 'input'], message: problem });
    }

    if (step.skipWhen !== undefined && !earlier.has(step.skipWhen.step)) {
      issues.push({
        path: [...at, 'skipWhen', 'step'],
        message: `step ${JSON.stringify(step.skipWhen.step)} does not run before this one`,
      });
    }

    // Added *after* this step's own references are checked, so a step cannot
    // refer to itself.
    earlier.add(step.id);
  }
  return issues;
}

/** What is wrong with one reference, or `null`. */
function referenceProblem(
  reference: string,
  params: ReadonlySet<string>,
  earlier: ReadonlySet<string>,
): string | null {
  const cut = reference.indexOf('.');
  const bucket = cut < 0 ? reference.slice(1) : reference.slice(1, cut);
  const rest = cut < 0 ? '' : reference.slice(cut + 1);

  if (bucket === 'param') {
    return params.has(rest) ? null : `${reference} names a parameter this workflow does not declare`;
  }
  if (bucket === 'step') {
    const head = rest.indexOf('.');
    const stepId = head < 0 ? rest : rest.slice(0, head);
    return earlier.has(stepId)
      ? null
      : `${reference} names a step that does not run before this one`;
  }
  return `${reference} is not a reference a workflow understands`;
}

/**
 * Validate one workflow.
 *
 * `contract` is optional so a definition can be checked before it is known
 * which application it belongs to — drafting, mostly. When it is given, every
 * route has to exist.
 */
export function parseWorkflow(raw: unknown, contract: ContractExport | null = null): WorkflowDefinition {
  const definition = definitionShape.parse(raw) as unknown as WorkflowDefinition;
  const issues = crossCheck(definition, contract);
  if (issues.length > 0) throw new ValidationError(issues);
  return definition;
}

/** Exported for the drafting code, which builds steps and then checks them. */
export type { WorkflowStep };
