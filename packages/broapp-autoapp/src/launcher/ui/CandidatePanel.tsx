/**
 * What the engineer has built, and the two decisions only a person can make.
 *
 * Granting is one of them and activating is the other. Both are the person's
 * own click, on channel `user`, and both show them exactly what they are
 * agreeing to before they agree to it: the capability list carries the release
 * it was read from, and the host refuses an answer about a different one.
 */
import { useCallback, useEffect } from 'react';
import type { ReactElement } from 'react';

import { useOperation } from 'broapp/react';

import type { LauncherContract } from '../contract.ts';

export interface CandidatePanelProps {
  readonly appId: string;
  onChanged(): void;
}

export function CandidatePanel({ appId, onChanged }: CandidatePanelProps): ReactElement | null {
  const status = useOperation<LauncherContract, 'launcher.candidateStatus'>(
    'launcher.candidateStatus',
  );
  const grants = useOperation<LauncherContract, 'launcher.grantsGet'>('launcher.grantsGet');
  const setGrants = useOperation<LauncherContract, 'launcher.grantsSet'>('launcher.grantsSet');
  const preview = useOperation<LauncherContract, 'launcher.previewOpen'>('launcher.previewOpen');
  const startPreview = useOperation<LauncherContract, 'launcher.previewStart'>('launcher.previewStart');
  const activate = useOperation<LauncherContract, 'launcher.activate'>('launcher.activate');

  const { run: refresh } = status;
  const { run: refreshGrants } = grants;
  const reload = useCallback(() => {
    void refresh({ appId });
    void refreshGrants({ appId });
  }, [appId, refresh, refreshGrants]);

  useEffect(() => {
    reload();
    // Polled while a build or a preview may be in progress: the engineer's
    // tools run on the host, and nothing pushes their results to this tab.
    const timer = setInterval(reload, 2_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The host opens the preview's tab; its address never reaches this page.
  const previewNotOpened = preview.data?.opened === false;

  const current = status.data;
  if (current === undefined || current === null) return null;
  const nothingYet =
    current.releaseId === null && current.problems.length === 0 && current.changed.length === 0;
  if (nothingYet) return null;

  const added = current.addedCapabilities;

  return (
    <section className="launcher__card" aria-labelledby="candidate-heading">
      <h2 className="launcher__card-title" id="candidate-heading">
        Proposed change
      </h2>

      {current.changed.length > 0 && (
        <p className="launcher__lede">
          Changed: {current.changed.map((path) => <code key={path}>{path} </code>)}
        </p>
      )}

      {current.problems.length > 0 && (
        <div className="launcher__message launcher__message--error" role="alert">
          <p>The build did not succeed:</p>
          <ul>
            {current.problems.map((problem) => (
              <li key={`${problem.stage}:${problem.message}`}>
                <strong>{problem.stage}</strong>: {problem.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {current.releaseId !== null && (
        <p className="launcher__lede">
          Built <code>{current.releaseId.slice(0, 8)}</code>
          {current.editsSinceBuild ? '; edited since this build.' : '.'}
        </p>
      )}
      {current.previewLost && (
        <p className="launcher__lede">The preview stopped when the launcher restarted.</p>
      )}

      {current.checks.length > 0 && !current.checksVerified && (
        <p className="launcher__lede">
          Passed {current.checks.filter((check) => check.passed).length} of {current.checks.length} for an
          earlier preview; run the checks again.
        </p>
      )}
      {current.checks.length > 0 && (
        <ul className="launcher__checks">
          {current.checks.map((check) => (
            <li key={check.id} className={check.passed ? 'launcher__check--pass' : 'launcher__check--fail'}>
              {check.passed ? '✓' : '✗'} {check.title}
              {check.detail === undefined ? '' : ` — ${check.detail}`}
            </li>
          ))}
        </ul>
      )}

      {added.length > 0 && (
        <div className="launcher__grants">
          <p className="launcher__lede">This change asks to be allowed to:</p>
          <ul>
            {added.map((capability) => (
              <li key={`${capability.kind}:${capability.reason}`}>
                <strong>{capability.kind}</strong>
                {capability.paths === undefined ? '' : ` ${capability.paths.join(', ')}`}
                {capability.hosts === undefined ? '' : ` ${capability.hosts.join(', ')}`} —{' '}
                {capability.reason}
              </li>
            ))}
          </ul>
          <button
            className="launcher__button"
            type="button"
            disabled={current.releaseId === null || setGrants.pending}
            onClick={() => {
              // The release the list was read from travels with the answer.
              void setGrants
                .run({
                  appId,
                  releaseId: current.releaseId ?? '',
                  capabilities: [...(grants.data?.granted ?? []), ...added],
                })
                .then(reload);
            }}
          >
            Allow these
          </button>
          {setGrants.error !== null && (
            <p className="launcher__message launcher__message--error" role="alert">
              {setGrants.error.message}
            </p>
          )}
        </div>
      )}

      <div className="launcher__row-actions">
        {current.previewLost && !current.previewRunning ? (
          // The child went with the launcher. Starting it again copies the data
          // and runs the candidate, which is a write — so it is its own route,
          // and only then is it opened.
          <button
            className="launcher__button"
            type="button"
            disabled={current.releaseId === null || startPreview.pending}
            onClick={() => {
              void startPreview
                .run({ appId })
                .then(() => preview.run({ appId }))
                .then(reload);
            }}
          >
            Start preview
          </button>
        ) : (
          <button
            className="launcher__button"
            type="button"
            disabled={!current.previewRunning}
            onClick={() => void preview.run({ appId })}
          >
            Open preview
          </button>
        )}
        {startPreview.error !== null && (
          <p className="launcher__message launcher__message--error" role="alert">
            {startPreview.error.message}
          </p>
        )}
        {previewNotOpened && (
          <p className="launcher__message launcher__message--error" role="alert">
            The preview is running, but no browser could be opened. Its address is printed in
            the terminal the launcher runs in.
          </p>
        )}
        <button
          className="launcher__button"
          type="button"
          disabled={current.releaseId === null || added.length > 0 || activate.pending}
          title={added.length > 0 ? 'Allow what it asks for first' : undefined}
          onClick={() => {
            void activate
              .run({ appId, releaseId: current.releaseId ?? '' })
              .then(() => {
                reload();
                onChanged();
              });
          }}
        >
          Activate
        </button>
      </div>

      {activate.data !== null && (
        <p className={activate.data.ok ? 'launcher__lede' : 'launcher__message launcher__message--error'}>
          {activate.data.ok
            ? activate.data.opened === true
              ? 'Activated and opened in a new tab. The tab that showed the previous release no longer answers; close it.'
              : 'Activated. Click Open to see it; the tab that showed the previous release no longer answers.'
            : `Not activated at ${activate.data.phase ?? 'an early step'}: ${activate.data.reason ?? ''}`}
        </p>
      )}
      {activate.error !== null && (
        <p className="launcher__message launcher__message--error" role="alert">
          {activate.error.message}
        </p>
      )}
    </section>
  );
}
