/**
 * File Processor.
 *
 * The interface is a list of what the host is allowed to see, a selection, and
 * a run with progress and a cancel. The reason the file list comes from the
 * host rather than from a file picker is explained in the contract and stated
 * plainly to the user below.
 */
import { useCallback, useEffect, useState } from 'react';
import { useConnection, useOperation, useStream } from 'broapp/react';

import { ConnectionBadge } from './ConnectionBadge.tsx';
import type { AppContract } from '../shared/types.ts';

export function App(): React.ReactElement {
  const connection = useConnection();
  const ready = connection.phase === 'ready';

  const describe = useOperation<AppContract, 'workspace.describe'>('workspace.describe');
  const list = useOperation<AppContract, 'workspace.list'>('workspace.list');
  const run = useStream<AppContract, 'process.count'>('process.count');

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [skipped, setSkipped] = useState<{ file: string; note: string }[]>([]);

  const refresh = useCallback(() => {
    void list.run(undefined);
  }, [list]);

  useEffect(() => {
    if (!ready) return;
    if (describe.data === null && !describe.pending) void describe.run(undefined);
    if (list.data === null && !list.pending) void list.run(undefined);
  }, [ready, describe, list]);

  // Collect skipped files as they arrive; the stream hook keeps only the latest
  // event, and a skip is exactly the thing a user needs the full list of.
  useEffect(() => {
    const event = run.last;
    if (event?.kind === 'skipped' && event.file !== null && event.note !== null) {
      const entry = { file: event.file, note: event.note };
      setSkipped((previous) =>
        previous.some((item) => item.file === entry.file) ? previous : [...previous, entry],
      );
    }
  }, [run.last]);

  const files = list.data?.files ?? [];
  const event = run.last;
  const percent = event === null || event.total === 0 ? 0 : Math.round((event.completed / event.total) * 100);

  function toggle(name: string): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function start(): void {
    setSkipped([]);
    void run.start({ files: [...selected] });
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">File Processor</h1>
          <p className="app__lede">
            Counts lines, words and characters across text files, and writes a report.
          </p>
        </div>
        <ConnectionBadge />
      </header>

      <main className="app__main">
        <section className="card" aria-labelledby="folder-heading">
          <h2 className="card__title" id="folder-heading">
            The folder this application may use
          </h2>
          {describe.data === null ? (
            <p className="message">{describe.error?.message ?? 'Reading…'}</p>
          ) : (
            <>
              <p className="path">
                <code>{describe.data.root}</code>
              </p>
              <p className="card__lede">
                {describe.data.explicit
                  ? 'Chosen with --root when the application was started.'
                  : 'The default folder inside this application’s own data directory. Start it with --root to point it somewhere else.'}{' '}
                Reports are written to <code>{describe.data.outputDirName}/</code> inside it.
              </p>
              <p className="card__lede">
                There is no file picker here on purpose. A browser does not tell a page where a
                chosen file lives on disk, so this application cannot be handed an arbitrary path —
                it can only work inside the folder it was started with.
              </p>
            </>
          )}
        </section>

        <section className="card" aria-labelledby="files-heading">
          <header className="card__head">
            <div>
              <h2 className="card__title" id="files-heading">
                Files
              </h2>
              <p className="card__lede">
                {files.length === 0
                  ? 'No text files in that folder yet. Add some and refresh.'
                  : `${String(files.length)} text file${files.length === 1 ? '' : 's'}.`}
              </p>
            </div>
            <button className="button" type="button" onClick={refresh} disabled={list.pending}>
              Refresh
            </button>
          </header>

          {list.error !== null && <p className="message message--error">{list.error.message}</p>}
          {list.data?.truncated === true && (
            <p className="message">Only the first files in that folder are shown.</p>
          )}

          <ul className="files">
            {files.map((file) => (
              <li className="files__item" key={file.name}>
                <label className="files__label">
                  <input
                    type="checkbox"
                    checked={selected.has(file.name)}
                    disabled={run.running}
                    onChange={() => toggle(file.name)}
                  />
                  <span className="files__name">{file.name}</span>
                  <span className="files__meta">{formatBytes(file.sizeBytes)}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="card" aria-labelledby="run-heading">
          <h2 className="card__title" id="run-heading">
            Run
          </h2>
          <div className="form__row">
            {run.running ? (
              <button className="button button--danger" type="button" onClick={run.cancel}>
                Cancel
              </button>
            ) : (
              <button
                className="button button--primary"
                type="button"
                onClick={start}
                disabled={selected.size === 0}
              >
                Process {selected.size === 0 ? 'selected files' : `${String(selected.size)} file${selected.size === 1 ? '' : 's'}`}
              </button>
            )}
          </div>

          <progress className="progress" max={100} value={percent} aria-labelledby="run-heading">
            {percent}%
          </progress>

          <p className="message" role="status" aria-live="polite">
            {run.error !== null
              ? run.error.message
              : run.running
                ? `Processed ${String(event?.completed ?? 0)} of ${String(event?.total ?? 0)}…`
                : event?.kind === 'finished'
                  ? `Done. ${String(event.totals.files)} files, ${event.totals.words.toLocaleString()} words. Report written to ${event.reportPath ?? ''}.`
                  : run.cancelled
                    ? 'Cancelled. No report was written.'
                    : 'Nothing running.'}
          </p>

          {skipped.length > 0 && (
            <ul className="skipped">
              {skipped.map((item) => (
                <li key={item.file}>
                  <strong>{item.file}</strong> — {item.note}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="app__footer">
        <details className="details">
          <summary className="details__summary">Technical details</summary>
          <div className="details__body">
            <p>
              Every name the browser sends is resolved against the authorized root and re-checked
              after resolution — so an absolute path, a <code>..</code> segment and a symlink
              pointing outside are all refused by the same test. Filtering the input string for{' '}
              <code>..</code> would catch only the second.
            </p>
            <p>
              Reports are never overwritten: a name that exists gets a numbered suffix, claimed
              atomically. A cancelled run writes nothing at all, so a partial report can never be
              mistaken for a finished one.
            </p>
          </div>
        </details>
      </footer>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
