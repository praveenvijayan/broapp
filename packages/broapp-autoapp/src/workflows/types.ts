/**
 * A saved sequence of calls.
 *
 * A workflow is what a person keeps from a run that worked: the same routes, in
 * the same order, with the parts they want to vary turned into parameters. It
 * is data, like everything else an agent can propose — no expressions, no
 * conditionals beyond one skip, no loops.
 *
 * The important thing a workflow does *not* carry is approval. A run that was
 * approved once is not approved forever; every `write` and `external` step asks
 * again, every time. That is the whole reason a workflow is safe to keep.
 */

/** One value a person supplies when they run it. */
export interface WorkflowParam {
  readonly name: string;
  readonly type: 'text' | 'number' | 'boolean';
  readonly label: string;
  readonly required?: boolean;
}

/** One call. */
export interface WorkflowStep {
  readonly id: string;
  readonly route: string;
  /**
   * Literal input, where a string `$param.<name>` is replaced by a parameter
   * and `$step.<stepId>.<path>` by an earlier step's output. No other
   * substitution exists, and none will be added without saying so here.
   */
  readonly input: unknown;
  /** Skipped when the earlier output at `path` deep-equals `value`. */
  readonly skipWhen?: { readonly step: string; readonly path: string; readonly equals: unknown };
}

/** The whole thing. */
export interface WorkflowDefinition {
  readonly version: 1;
  readonly params: readonly WorkflowParam[];
  readonly steps: readonly WorkflowStep[];
  /** `stop` is the only policy in v1. */
  readonly onFailure: 'stop';
}

/** How one step of a run ended. */
export interface WorkflowStepResult {
  readonly id: string;
  readonly status: 'succeeded' | 'failed' | 'skipped' | 'declined';
  readonly output?: unknown;
  readonly error?: string;
}

/** How a whole run ended. */
export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly steps: readonly WorkflowStepResult[];
}
