/**
 * Running a saved workflow.
 *
 * Every step goes through `HostApp.invoke` with channel `workflow`, which means
 * every step goes through the gate — so a `write` or an `external` asks a person
 * again, on this run, for these arguments. Approvals recorded on the run this
 * workflow was drafted from are never consulted, and there is no code here that
 * could consult them. That is what makes a saved workflow safe to keep: it
 * remembers what to do, not permission to do it.
 *
 * `onFailure: 'stop'` is the only policy. The first failure ends the run and
 * everything after it is `skipped` — not attempted and not silently dropped,
 * because a person looking at the result needs to see where it stopped.
 */
import { fromTransportError, isPublicError } from 'broapp/shared';
import type { AnyContract, Effect } from 'broapp/shared';
import type { Approver, HostApp, HostLogger } from 'broapp/host';

import type { ContractExport } from '../spec/types.ts';

import type {
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStepResult,
} from './types.ts';

/** What one workflow run needs. */
export interface RunWorkflowParams {
  readonly app: HostApp<AnyContract>;
  readonly contract: ContractExport;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly params: Readonly<Record<string, unknown>>;
  readonly approver?: Approver;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly logger?: HostLogger;
}

/** Read a dotted path out of a JSON value. */
function readPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Resolve every `$param` and `$step` reference inside a value. */
function resolve(
  value: unknown,
  params: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown>,
): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    const cut = value.indexOf('.');
    const bucket = cut < 0 ? value.slice(1) : value.slice(1, cut);
    const rest = cut < 0 ? '' : value.slice(cut + 1);
    if (bucket === 'param') {
      if (!(rest in params)) throw new TypeError(`${value} was not supplied`);
      return params[rest];
    }
    if (bucket === 'step') {
      const head = rest.indexOf('.');
      const stepId = head < 0 ? rest : rest.slice(0, head);
      if (!outputs.has(stepId)) throw new TypeError(`${value} names a step that has not run`);
      return readPath(outputs.get(stepId), head < 0 ? '' : rest.slice(head + 1));
    }
    throw new TypeError(`${value} is not a reference a workflow understands`);
  }
  if (Array.isArray(value)) return value.map((member) => resolve(member, params, outputs));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolve(member, params, outputs);
    }
    return out;
  }
  return value;
}

/** True when a call failed because nobody allowed it. */
function wasDeclined(cause: unknown): boolean {
  if (isPublicError(cause)) return cause.code === 'rejected';
  return fromTransportError(cause).code === 'rejected';
}

/** A message safe to put in a result. */
function safeMessage(cause: unknown): string {
  if (isPublicError(cause)) return cause.message;
  const reduced = fromTransportError(cause);
  return reduced.code === 'internal' ? 'The step failed.' : reduced.message;
}

/** Run one workflow, start to finish. */
export async function runWorkflow(params: RunWorkflowParams): Promise<WorkflowRunResult> {
  const outputs = new Map<string, unknown>();
  const results: WorkflowStepResult[] = [];
  let status: WorkflowRunResult['status'] = 'succeeded';
  // A function rather than an expression: read inline, the compiler narrows it
  // after the first check and then insists the later one is unreachable — which
  // is exactly backwards, since the whole point is that it can change.
  const cancelled = (): boolean => params.signal?.aborted === true;

  for (const step of params.definition.steps) {
    if (status !== 'succeeded') {
      // Everything after the first failure is reported rather than dropped, so
      // the result says where it stopped.
      results.push({ id: step.id, status: 'skipped' });
      continue;
    }
    if (cancelled()) {
      status = 'cancelled';
      results.push({ id: step.id, status: 'skipped' });
      continue;
    }

    if (step.skipWhen !== undefined) {
      const seen = readPath(outputs.get(step.skipWhen.step), step.skipWhen.path);
      if (JSON.stringify(seen) === JSON.stringify(step.skipWhen.equals)) {
        results.push({ id: step.id, status: 'skipped' });
        continue;
      }
    }

    let input: unknown;
    try {
      input = resolve(step.input, params.params, outputs);
    } catch (cause) {
      // Reported in its own words rather than reduced. This is the workflow's
      // own configuration — a parameter nobody supplied, a step that did not
      // run — and there is nothing in it that came from the host.
      status = 'failed';
      results.push({
        id: step.id,
        status: 'failed',
        error: cause instanceof Error ? cause.message : 'This step is not configured correctly.',
      });
      continue;
    }

    const effect: Effect = (params.contract.operations[step.route]?.effect ?? 'write') as Effect;
    try {
      const output = await params.app.invoke(step.route as never, input, {
        // Built here, from what this runner knows. The channel is `workflow`
        // whatever the workflow says, because a workflow is a thing an agent
        // saved and not a person clicking.
        requestId: `${params.runId}:${step.id}`,
        channel: 'workflow',
        caller: `workflow:${params.workflowId}`,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
        ...(params.approver === undefined ? {} : { approver: params.approver }),
        effectHint: effect,
      });
      outputs.set(step.id, output);
      results.push({ id: step.id, status: 'succeeded', output });
    } catch (cause) {
      status = cancelled() ? 'cancelled' : 'failed';
      const declined = wasDeclined(cause);
      results.push({
        id: step.id,
        status: declined ? 'declined' : 'failed',
        error: safeMessage(cause),
      });
      params.logger?.warn(
        `[autoapp] workflow ${params.workflowId} stopped at ${step.id}: ${safeMessage(cause)}`,
      );
    }
  }

  return { runId: params.runId, status, steps: results };
}
