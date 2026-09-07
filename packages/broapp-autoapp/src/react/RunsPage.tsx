/**
 * What agents have done, and turning one of those into something reusable.
 *
 * A built-in page rather than part of a view specification: it is the same for
 * every application, and an application should not have to describe it — or be
 * able to remove it. A person is entitled to see what was done on their behalf.
 */
import * as React from 'react';

import { useOperation } from 'broapp/react';

import type { AutoappContract } from '../shared/contract.ts';
import type { WorkflowDefinition } from '../workflows/types.ts';

import { formatValue } from './format.ts';

type Run = {
  id: string;
  channel: string;
  caller: string;
  status: string;
  startedAt: number;
  summary: string | null;
};

type Step = {
  id: number;
  route: string;
  effect: string;
  decision: string;
  outcome: string | null;
  input?: unknown;
  error: string | null;
};

/** One literal a person is turning into a parameter. */
interface Pick {
  readonly stepId: string;
  readonly inputPath: string;
  paramName: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
}

/** Every leaf of a step's input, as dotted paths, so a person can pick one. */
function leaves(value: unknown, prefix = ''): { path: string; value: unknown }[] {
  if (typeof value !== 'object' || value === null) return [{ path: prefix, value }];
  if (Array.isArray(value)) {
    return value.flatMap((member, index) =>
      leaves(member, prefix === '' ? String(index) : `${prefix}.${String(index)}`),
    );
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, member]) =>
    leaves(member, prefix === '' ? key : `${prefix}.${key}`),
  );
}

export function RunsPage(): React.ReactElement {
  const runs = useOperation<AutoappContract, 'autoapp.runsList'>('autoapp.runsList');
  const detail = useOperation<AutoappContract, 'autoapp.runGet'>('autoapp.runGet');
  const draft = useOperation<AutoappContract, 'autoapp.workflowDraft'>('autoapp.workflowDraft');
  const save = useOperation<AutoappContract, 'autoapp.workflowSave'>('autoapp.workflowSave');

  const [openRun, setOpenRun] = React.useState<string | null>(null);
  const [picks, setPicks] = React.useState<Pick[]>([]);
  const [name, setName] = React.useState('');
  // Agents by default. A person's own clicks are recorded too — every gate
  // decision is — but a list of "what agents did" that is mostly the person's
  // own clicks is a list nobody reads.
  const [mine, setMine] = React.useState(false);

  const { run: listRuns } = runs;
  React.useEffect(() => {
    void listRuns(mine ? {} : { channels: ['ai', 'mcp', 'workflow'] });
  }, [listRuns, mine]);

  const rows = (runs.data?.runs ?? []) as readonly Run[];
  const steps = (detail.data?.steps ?? []) as readonly Step[];
  const definition = draft.data?.definition as WorkflowDefinition | undefined;

  async function open(id: string): Promise<void> {
    setOpenRun(id);
    setPicks([]);
    draft.reset();
    await detail.run({ id });
  }

  return (
    <div className="autoapp-page" data-autoapp-page="autoapp-runs">
      <h1 className="autoapp-page__title">What agents did</h1>
      <label className="autoapp-field__label">
        <input
          type="checkbox"
          className="autoapp-field__check"
          checked={mine}
          onChange={(event) => setMine(event.target.checked)}
        />{' '}
        Include my own actions
      </label>

      <div className="autoapp-table">
        <table className="autoapp-table__grid">
          <thead>
            <tr>
              <th className="autoapp-col">When</th>
              <th className="autoapp-col">Who</th>
              <th className="autoapp-col autoapp-col--wide">What</th>
              <th className="autoapp-col autoapp-col--narrow">Status</th>
              <th className="autoapp-col autoapp-col--narrow" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="autoapp-empty" colSpan={5}>
                  Nothing has been done by an agent yet.
                </td>
              </tr>
            ) : (
              rows.map((run) => (
                <tr key={run.id}>
                  <td className="autoapp-col">{formatValue(run.startedAt, 'datetime')}</td>
                  <td className="autoapp-col">{run.caller}</td>
                  <td className="autoapp-col autoapp-col--wide">{run.summary ?? run.channel}</td>
                  <td className="autoapp-col autoapp-col--narrow">{run.status}</td>
                  <td className="autoapp-col autoapp-col--narrow">
                    <button
                      type="button"
                      className="autoapp-button autoapp-button--small"
                      onClick={() => void open(run.id)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openRun !== null && (
        <section className="autoapp-section" data-autoapp-id="run-detail">
          <h2 className="autoapp-section__title">Steps</h2>
          {steps.map((step) => (
            <div className="autoapp-run-step" key={step.id}>
              <code>{step.route}</code> · {step.effect} · {step.decision}
              {step.outcome === null ? '' : ` · ${step.outcome}`}
              {step.error !== null && (
                <span className="autoapp-message autoapp-message--error"> {step.error}</span>
              )}
              <pre className="autoapp-approvals__input">{JSON.stringify(step.input, null, 2)}</pre>
            </div>
          ))}

          {draft.error !== null && (
            <p className="autoapp-message autoapp-message--error" role="alert">
              {draft.error.message}
            </p>
          )}

          {definition === undefined ? (
            <button
              type="button"
              className="autoapp-button"
              onClick={() => void draft.run({ runId: openRun })}
            >
              Save as workflow
            </button>
          ) : (
            <div className="autoapp-draft" data-autoapp-id="workflow-draft">
              <h3 className="autoapp-section__title">New workflow</h3>
              <div className="autoapp-field">
                <label className="autoapp-field__label" htmlFor="wf-name">
                  Name
                </label>
                <input
                  id="wf-name"
                  className="autoapp-field__input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              {definition.steps.map((step) => (
                <div className="autoapp-draft__step" key={step.id}>
                  <code>{step.route}</code>
                  {leaves(step.input).map((leaf) => {
                    const picked = picks.find(
                      (pick) => pick.stepId === step.id && pick.inputPath === leaf.path,
                    );
                    return (
                      <div className="autoapp-draft__leaf" key={`${step.id}:${leaf.path}`}>
                        <span className="autoapp-draft__path">{leaf.path === '' ? '(whole input)' : leaf.path}</span>
                        <span className="autoapp-draft__value">{formatValue(leaf.value)}</span>
                        {picked === undefined ? (
                          <button
                            type="button"
                            className="autoapp-button autoapp-button--small"
                            onClick={() =>
                              setPicks((current) => [
                                ...current,
                                {
                                  stepId: step.id,
                                  inputPath: leaf.path,
                                  paramName: (leaf.path.split('.').pop() ?? 'value').replace(
                                    /[^A-Za-z0-9]/g,
                                    '',
                                  ),
                                  label: leaf.path === '' ? 'Value' : leaf.path,
                                  type: typeof leaf.value === 'number' ? 'number' : typeof leaf.value === 'boolean' ? 'boolean' : 'text',
                                },
                              ])
                            }
                          >
                            Ask each time
                          </button>
                        ) : (
                          <input
                            className="autoapp-field__input"
                            aria-label={`Parameter name for ${leaf.path}`}
                            value={picked.paramName}
                            onChange={(event) =>
                              setPicks((current) =>
                                current.map((pick) =>
                                  pick === picked ? { ...pick, paramName: event.target.value } : pick,
                                ),
                              )
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              {save.error !== null && (
                <p className="autoapp-message autoapp-message--error" role="alert">
                  {save.error.message}
                </p>
              )}
              <button
                type="button"
                className="autoapp-button"
                disabled={name.trim() === '' || save.pending}
                onClick={() => {
                  // Parameterising is done here, on the definition the host
                  // drafted, and the result is what gets saved. The host
                  // validates it again before it is written down.
                  void save.run({
                    name: name.trim(),
                    definition: withParams(definition, picks),
                    fromRunId: openRun,
                  });
                }}
              >
                Save workflow
              </button>
              {save.data !== null && <p className="autoapp-text">Saved.</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
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

/** Apply the person's picks to a drafted definition. */
function withParams(definition: WorkflowDefinition, picks: readonly Pick[]): WorkflowDefinition {
  let steps = definition.steps;
  for (const pick of picks) {
    const path = pick.inputPath === '' ? [] : pick.inputPath.split('.');
    steps = steps.map((step) =>
      step.id === pick.stepId
        ? { ...step, input: replaceAt(step.input, path, `$param.${pick.paramName}`) }
        : step,
    );
  }
  return {
    ...definition,
    steps,
    params: picks.map((pick) => ({
      name: pick.paramName,
      type: pick.type,
      label: pick.label,
      required: true,
    })),
  };
}
