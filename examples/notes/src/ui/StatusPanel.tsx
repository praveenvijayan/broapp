/**
 * Where the data is, what version the schema is at, and how to back it up.
 *
 * Worth surfacing in the interface rather than only in a README: a user of a
 * local application owns the file, and "where is my data" is the first question
 * they ask when they want to move machines or when something goes wrong.
 */
import { useState } from 'react';
import { useOperation } from 'broapp/react';

import type { AppContract } from '../shared/types.ts';
import type { OperationHook } from 'broapp/react';

export interface StatusPanelProps {
  readonly status: OperationHook<AppContract, 'notes.status'>;
  readonly onBackedUp: () => void;
}

export function StatusPanel({ status, onBackedUp }: StatusPanelProps): React.ReactElement {
  const backup = useOperation<AppContract, 'notes.backup'>('notes.backup');
  const [message, setMessage] = useState<string | null>(null);

  async function runBackup(): Promise<void> {
    await backup.run(undefined);
    setMessage(null);
    onBackedUp();
  }

  const info = status.data;

  return (
    <details className="details">
      <summary className="details__summary">Data and backups</summary>
      <div className="details__body">
        {info === null ? (
          <p className="message">{status.error?.message ?? 'Reading…'}</p>
        ) : (
          <>
            <dl className="facts">
              <dt>Database</dt>
              <dd>
                <code>{info.databasePath}</code>
              </dd>
              <dt>Schema</dt>
              <dd>
                version {info.schemaVersion} of {info.latestSchemaVersion}
                {info.schemaVersion < info.latestSchemaVersion && ' — will migrate on next start'}
              </dd>
              <dt>Notes</dt>
              <dd>{info.noteCount}</dd>
              <dt>State</dt>
              <dd>{info.healthy ? 'Healthy' : 'Could not be opened'}</dd>
            </dl>

            <p>
              A backup is written with SQLite’s <code>VACUUM INTO</code>, which produces a
              consistent single-file copy while the application keeps running. Copying the file
              yourself while it is open does not — the write-ahead log lives beside it, and a copy
              taken mid-write can be missing recent changes.
            </p>

            <div className="form__row">
              <button
                className="button"
                type="button"
                onClick={() => void runBackup()}
                disabled={backup.pending || !info.healthy}
              >
                {backup.pending ? 'Backing up…' : 'Back up now'}
              </button>
            </div>

            {backup.error !== null && <p className="message message--error">{backup.error.message}</p>}
            {backup.data !== null && backup.error === null && (
              <p className="message message--ok">
                Written to <code>{backup.data.path}</code> ({(backup.data.bytes / 1024).toFixed(0)} KiB).
              </p>
            )}
            {message !== null && <p className="message">{message}</p>}

            <p className="details__note">
              To move your notes to another computer, quit the application and copy the database
              file. To start fresh, quit and move it aside — a new one is created on the next start.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
