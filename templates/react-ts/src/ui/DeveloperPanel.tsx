/**
 * Technical detail, kept out of the way.
 *
 * A <details> element is closed by default, is keyboard operable without any
 * JavaScript, and is announced correctly — so the implementation vocabulary
 * that would be noise to a user is one keystroke away for a developer.
 */
import { useEffect } from 'react';
import { useConnection, useOperation } from 'broapp/react';

import type { AppContract } from '../shared/contract.ts';

export function DeveloperPanel(): React.ReactElement {
  const info = useOperation<AppContract, 'demo.hostInfo'>('demo.hostInfo');
  const connection = useConnection();
  const ready = connection.phase === 'ready';

  useEffect(() => {
    if (ready && info.data === null && !info.pending) void info.run(undefined);
  }, [ready, info]);

  return (
    <details className="details">
      <summary className="details__summary">Technical details</summary>
      <div className="details__body">
        <p>
          The application runs a local host process bound to the loopback interface. This page was
          served by that process over an authenticated session, and talks to it over a WebSocket on
          the same origin. Transport, authentication and session handling are{' '}
          <strong>Brobridge</strong>; the surrounding developer experience is <strong>Broapp</strong>.
        </p>

        {info.data === null ? (
          <p className="message">{info.error?.message ?? 'Reading host information…'}</p>
        ) : (
          <dl className="facts">
            <dt>Version</dt>
            <dd>{info.data.version}</dd>
            <dt>Platform</dt>
            <dd>
              {info.data.platform} / {info.data.arch}
            </dd>
            <dt>Bun</dt>
            <dd>{info.data.bunVersion}</dd>
            <dt>Lifecycle</dt>
            <dd>
              {info.data.lifecycle === 'interactive'
                ? 'interactive — the host exits shortly after the last tab closes'
                : 'background — the host keeps running when this tab closes'}
            </dd>
            <dt>Mode</dt>
            <dd>{info.data.development ? 'development (broapp dev)' : 'compiled executable'}</dd>
            <dt>Data directory</dt>
            <dd>
              <code>{info.data.dataDir}</code>
            </dd>
            <dt>Transport</dt>
            <dd>{connection.phase === 'ready' ? connection.transport : connection.phase}</dd>
          </dl>
        )}

        <p className="details__note">
          Loopback HTTP is not encrypted, and authentication is not a sandbox: the host runs with
          your permissions. See the project's security documentation for what that does and does not
          protect against.
        </p>
      </div>
    </details>
  );
}
