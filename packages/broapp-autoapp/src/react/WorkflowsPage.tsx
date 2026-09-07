/**
 * Saved workflows: run one, put one on a page, delete one.
 *
 * Running one from here goes through `autoapp.workflowRun`, which is a `write`
 * that the person clicked — and every step *inside* it is a fresh
 * `workflow`-channel request that asks again. So a workflow with three writes
 * produces three questions in the approvals strip above, on every run, however
 * many times it has been run before.
 */
import * as React from 'react';

import { useOperation } from 'broapp/react';

import type { AutoappContract } from '../shared/contract.ts';

import { useViews } from './AutoappView.tsx';
import { formatValue } from './format.ts';

type Summary = {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  params: readonly { name: string; label: string; type: 'text' | 'number' | 'boolean' }[];
};

export function WorkflowsPage(): React.ReactElement {
  const list = useOperation<AutoappContract, 'autoapp.workflowsList'>('autoapp.workflowsList');
  const run = useOperation<AutoappContract, 'autoapp.workflowRun'>('autoapp.workflowRun');
  const remove = useOperation<AutoappContract, 'autoapp.workflowDelete'>('autoapp.workflowDelete');
  const promote = useOperation<AutoappContract, 'autoapp.workflowPromote'>('autoapp.workflowPromote');
  const detail = useOperation<AutoappContract, 'autoapp.runGet'>('autoapp.runGet');
  const { views } = useViews();

  const [open, setOpen] = React.useState<string | null>(null);
  const [params, setParams] = React.useState<Record<string, unknown>>({});
  const [anchor, setAnchor] = React.useState('');

  const { run: refresh } = list;
  React.useEffect(() => {
    void refresh(undefined);
  }, [refresh]);

  const workflows = (list.data?.workflows ?? []) as readonly Summary[];

  /** Every place a promoted workflow could be anchored. */
  const anchors = React.useMemo(
    () =>
      (views?.pages ?? []).flatMap((page) =>
        page.children.map((component) => ({
          page: page.id,
          component: component.id,
          label: `${page.title} → ${component.label ?? component.id}`,
        })),
      ),
    [views],
  );

  return (
    <div className="autoapp-page" data-autoapp-page="autoapp-workflows">
      <h1 className="autoapp-page__title">Saved workflows</h1>

      {workflows.length === 0 && (
        <p className="autoapp-empty">
          Nothing saved yet. Open a run under “What agents did” and save it.
        </p>
      )}

      {workflows.map((workflow) => (
        <section className="autoapp-section" key={workflow.id} data-autoapp-id={`wf-${workflow.id}`}>
          <h2 className="autoapp-section__title">{workflow.name}</h2>
          <p className="autoapp-text">
            version {String(workflow.version)} · saved {formatValue(workflow.updatedAt, 'datetime')}
          </p>

          {workflow.params.map((param) => (
            <div className="autoapp-field" key={param.name}>
              <label className="autoapp-field__label" htmlFor={`${workflow.id}-${param.name}`}>
                {param.label}
              </label>
              <input
                id={`${workflow.id}-${param.name}`}
                className="autoapp-field__input"
                value={String(params[param.name] ?? '')}
                onChange={(event) =>
                  setParams((current) => ({ ...current, [param.name]: event.target.value }))
                }
              />
            </div>
          ))}

          <div className="autoapp-button-row">
            <button
              type="button"
              className="autoapp-button"
              disabled={run.pending}
              onClick={() => {
                setOpen(workflow.id);
                void run.run({ id: workflow.id, params });
              }}
            >
              Run
            </button>
            <button
              type="button"
              className="autoapp-button autoapp-button--small"
              onClick={() => void remove.run({ id: workflow.id }).then(() => refresh(undefined))}
            >
              Delete
            </button>
          </div>

          <div className="autoapp-field">
            <label className="autoapp-field__label" htmlFor={`${workflow.id}-anchor`}>
              Put it on a page, after
            </label>
            <select
              id={`${workflow.id}-anchor`}
              className="autoapp-field__input"
              value={anchor}
              onChange={(event) => setAnchor(event.target.value)}
            >
              <option value="">Choose…</option>
              {anchors.map((candidate) => (
                <option
                  key={`${candidate.page}:${candidate.component}`}
                  value={`${candidate.page}:${candidate.component}`}
                >
                  {candidate.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="autoapp-button autoapp-button--small"
              disabled={anchor === ''}
              onClick={() => {
                const [page = '', component = ''] = anchor.split(':');
                void promote.run({
                  id: workflow.id,
                  page,
                  afterComponentId: component,
                  label: workflow.name,
                });
              }}
            >
              Add to the interface
            </button>
          </div>

          {open === workflow.id && run.data !== null && (
            <div className="autoapp-run-result" data-autoapp-id={`wf-result-${workflow.id}`}>
              <p className="autoapp-text">Run {run.data.status}.</p>
              {run.data.steps.map((step) => (
                <p className="autoapp-text" key={step.id}>
                  <code>{step.id}</code> · {step.status}
                  {step.error === undefined ? '' : ` · ${step.error}`}
                </p>
              ))}
              <button
                type="button"
                className="autoapp-button autoapp-button--small"
                onClick={() => void detail.run({ id: run.data?.runId ?? '' })}
              >
                See it under “What agents did”
              </button>
            </div>
          )}
          {open === workflow.id && run.error !== null && (
            <p className="autoapp-message autoapp-message--error" role="alert">
              {run.error.message}
            </p>
          )}
          {promote.error !== null && (
            <p className="autoapp-message autoapp-message--error" role="alert">
              {promote.error.message}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
