/**
 * Autoapp's host routes: the interface, the history, and the approvals.
 *
 * One host app in the reserved `autoapp` group, mounted beside the
 * application's own. It owns the one thing the `workflow` and `mcp` channels
 * need and cannot have of their own: somewhere for a question to wait until a
 * person answers it.
 *
 * The wrapper around that table is worth reading. An agent asking permission
 * when no tab is open is not a question that will be answered slowly — it is a
 * question nobody will ever see. Denying it at once is both more honest and
 * safer than holding it until a deadline, because a question sitting in memory
 * is a request that might be approved by whoever opens the tab next, for
 * reasons they no longer have any context for.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPendingApprovals, createReservedHostApp, publicError } from 'broapp/host';
import type {
  ApprovalQuestion,
  Approver,
  HostApp,
  HostLogger,
  PendingApprovals,
} from 'broapp/host';
import type { AnyContract } from 'broapp/shared';
import type { Bridge } from 'brobridge';

import { autoappContract, type AutoappContract } from '../shared/contract.ts';
import type { ContractExport } from '../spec/types.ts';
import { checkViewsAgainstContract } from '../views/check.ts';
import { withAutoappRoutes } from '../views/merge-contract.ts';
import { applyOverrides, NO_OVERRIDES, type Addition, type Overrides } from '../views/overrides.ts';
import type { Component, ViewsSpec } from '../views/types.ts';
import { draftFromRun } from '../workflows/draft.ts';
import { runWorkflow } from '../workflows/run.ts';
import type { WorkflowDefinition } from '../workflows/types.ts';
import { parseWorkflow } from '../workflows/validate.ts';

import type { RunStore } from './run-store.ts';

/** Options for {@link createAutoappHost}. */
export interface CreateAutoappHostOptions {
  /** The application's data directory. Overrides live in `autoapp/` under it. */
  readonly dataDir: string;
  /** The release's own view specification, already validated. */
  readonly views: ViewsSpec;
  readonly store: RunStore;
  /** The application's contract, so a workflow's routes can be checked. */
  readonly contract: ContractExport;
  /** The application's host app, which workflow steps are invoked through. */
  readonly app: HostApp<AnyContract>;
  /** True while a tab is open to answer a question. */
  isAttached(): boolean;
  /**
   * The table questions wait in. Supplied by the child runtime so that MCP
   * calls and workflow steps queue in the same place, and one
   * `autoapp.approvalsAnswer` answers either. One is created when it is absent.
   */
  readonly approvals?: PendingApprovals;
  readonly logger?: HostLogger;
}

/** Autoapp's host routes, ready to mount. */
export interface AutoappHost {
  mount(bridge: Bridge): void;
  /** The release's views, without overrides. For tests and for the engineer. */
  readonly views: ViewsSpec;
  /** The approver the `workflow` and `mcp` channels ask through. */
  readonly approver: Approver;
  /** The table underneath it, for the routes that answer questions. */
  readonly approvals: PendingApprovals;
}

/** Where a person's own changes are kept. */
function overridesPath(dataDir: string): string {
  return join(dataDir, 'autoapp', 'overrides.json');
}

/**
 * An approver that refuses when nobody is there to ask.
 *
 * A wrapper rather than a change to the table, so the table stays a table: it
 * knows how to hold a question and match an answer, and knowing whether anybody
 * is looking is not its business.
 */
export function attachedOnly(approvals: Approver, isAttached: () => boolean): Approver {
  return {
    ask(question: ApprovalQuestion, signal: AbortSignal): Promise<boolean> {
      if (!isAttached()) return Promise.resolve(false);
      return approvals.ask(question, signal);
    },
  };
}

/** Build Autoapp's host routes for one application. */
export function createAutoappHost(options: CreateAutoappHostOptions): AutoappHost {
  const logger: HostLogger = options.logger ?? console;
  const path = overridesPath(options.dataDir);
  const approvals = options.approvals ?? createPendingApprovals(logger);
  const approver = attachedOnly(approvals, options.isAttached);

  /** What this person has changed, or nothing when they have changed nothing. */
  function read(): Overrides {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return NO_OVERRIDES;
    }
    try {
      const parsed = JSON.parse(raw) as Overrides;
      // A file hand-edited into nonsense is not worth failing the whole
      // interface over: the release's own views are still renderable, and the
      // person gets their application back rather than a blank page.
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
        logger.warn(`[autoapp] ${path} is not a version 1 overrides file; ignoring it`);
        return NO_OVERRIDES;
      }
      return parsed;
    } catch {
      logger.warn(`[autoapp] ${path} could not be read as JSON; ignoring it`);
      return NO_OVERRIDES;
    }
  }

  /** Replace them, without ever leaving a half-written file behind. */
  function write(next: Overrides): void {
    mkdirSync(join(options.dataDir, 'autoapp'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temporary, path);
  }

  const host: HostApp<AutoappContract> = createReservedHostApp<AutoappContract>(autoappContract, {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  host.operation('autoapp.overridesGet', () => read());
  host.operation('autoapp.overridesSet', (next) => {
    write(next);
    return { ok: true };
  });
  host.operation('autoapp.viewsGet', () => {
    const applied = applyOverrides(options.views, read());
    return { views: applied.views, conflicts: [...applied.conflicts] };
  });

  host.operation('autoapp.approvalsList', () => ({ pending: [...approvals.pending] }));
  host.operation('autoapp.approvalsAnswer', (answer) => ({
    result: approvals.answer(answer),
  }));

  host.operation('autoapp.runsList', (input) => ({ runs: [...options.store.listRuns(input)] }));
  host.operation('autoapp.runGet', ({ id }) => {
    const found = options.store.getRun(id);
    if (found === null) throw publicError.notFound('There is no run with that identifier.');
    return { run: found.run, steps: [...found.steps] };
  });

  host.operation('autoapp.workflowDraft', ({ runId }) => {
    const found = options.store.getRun(runId);
    if (found === null) throw publicError.notFound('There is no run with that identifier.');
    return { definition: draftFromRun(found.run, found.steps, options.contract) };
  });

  host.operation('autoapp.workflowSave', ({ id, name, definition, fromRunId }) => {
    // Validated here rather than trusted: this arrived from a browser, and a
    // workflow with a forward reference would fail halfway through a run, after
    // some of its steps had already changed something.
    const checked = parseWorkflow(definition, options.contract);
    return options.store.saveWorkflow({
      ...(id === undefined ? {} : { id }),
      name,
      definition: checked,
      ...(fromRunId === undefined ? {} : { fromRunId }),
    });
  });

  host.operation('autoapp.workflowsList', () => ({
    workflows: options.store.listWorkflows().map((workflow) => ({
      ...workflow,
      params: [...workflow.params],
    })),
  }));
  host.operation('autoapp.workflowDelete', ({ id }) => ({
    removed: options.store.deleteWorkflow(id),
  }));

  host.operation('autoapp.workflowRun', async ({ id, params }, context) => {
    const saved = options.store.getWorkflow(id);
    if (saved === null) throw publicError.notFound('There is no workflow with that identifier.');
    // The run identifier is the request that started it, so every step's
    // record — `<runId>:<stepId>` — groups under one run in the store.
    const result = await runWorkflow({
      app: options.app,
      contract: options.contract,
      workflowId: id,
      definition: saved.definition,
      params: params ?? {},
      approver,
      runId: context.requestId,
      logger,
    });
    options.store.finishRun(context.requestId, result.status, `workflow: ${saved.name}`);
    return { runId: result.runId, status: result.status, steps: [...result.steps] };
  });

  host.operation('autoapp.workflowPromote', ({ id, page, afterComponentId, label }) => {
    const saved = options.store.getWorkflow(id);
    if (saved === null) throw publicError.notFound('There is no workflow with that identifier.');
    const current = read();
    const addition: Addition = {
      id: `wf-${id}`,
      page,
      afterComponentId,
      component: promotionComponent(id, label, saved.definition),
    };
    const next: Overrides = {
      ...current,
      additions: [
        ...(current.additions ?? []).filter((existing) => existing.id !== addition.id),
        addition,
      ],
    };

    // Applied before it is written, so a promotion onto a page or an anchor
    // that is not there is refused now rather than becoming a conflict line the
    // person has to work out later.
    const applied = applyOverrides(options.views, next);
    const problem = applied.conflicts.find((conflict) => conflict.componentId === addition.id);
    if (problem !== undefined) {
      throw publicError.invalidInput(`this workflow cannot go there: ${problem.reason}`);
    }
    // And checked against both route tables: the button calls
    // `autoapp.workflowRun`, which is Autoapp's route rather than the
    // application's.
    const problems = checkViewsAgainstContract(applied.views, withAutoappRoutes(options.contract));
    if (problems.length > 0) {
      throw publicError.invalidInput(`this workflow cannot go there: ${problems[0] ?? ''}`);
    }

    write(next);
    return { ok: true };
  });

  return {
    mount: (bridge: Bridge) => host.mount(bridge),
    views: options.views,
    approver,
    approvals,
  };
}

/**
 * The component a promoted workflow becomes.
 *
 * A form when it takes parameters and a button when it does not. Either way the
 * action calls `autoapp.workflowRun`, which the renderer treats like any other
 * `write`: it asks before running, and every step inside asks again on its own.
 */
function promotionComponent(
  workflowId: string,
  label: string,
  definition: WorkflowDefinition,
): Component {
  const confirmText = `Run ${label}?`;
  if (definition.params.length === 0) {
    return {
      id: `wf-${workflowId}`,
      kind: 'button',
      action: {
        id: `wf-run-${workflowId}`,
        label,
        operation: 'autoapp.workflowRun',
        input: { id: workflowId },
        confirmText,
      },
    };
  }
  return {
    id: `wf-${workflowId}`,
    kind: 'form',
    label,
    fields: definition.params.map((param) => ({
      id: param.name,
      label: param.label,
      type: param.type === 'number' ? ('number' as const) : param.type === 'boolean' ? ('boolean' as const) : ('text' as const),
      ...(param.required === true ? { required: true } : {}),
    })),
    submit: {
      id: `wf-run-${workflowId}`,
      label,
      operation: 'autoapp.workflowRun',
      input: {
        id: workflowId,
        params: Object.fromEntries(
          definition.params.map((param) => [param.name, `$field.${param.name}`]),
        ),
      },
      confirmText,
    },
  };
}
