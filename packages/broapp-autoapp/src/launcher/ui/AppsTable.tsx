/** The applications on this computer, and what each is doing. */
import type { ReactElement } from 'react';

/** One row, as `launcher.appsList` reports it. */
export interface AppRow {
  appId: string;
  name: string;
  currentRelease: string | null;
  serving: boolean;
  pid: number | null;
  schemaVersion: number | null;
  activationPending: boolean;
}

export interface AppsTableProps {
  readonly apps: readonly AppRow[];
  readonly selected: string | null;
  onSelect(appId: string): void;
  onOpen(appId: string): void;
  onStop(appId: string): void;
}

export function AppsTable({ apps, selected, onSelect, onOpen, onStop }: AppsTableProps): ReactElement {
  return (
    <section className="launcher__card" aria-labelledby="apps-heading">
      <h2 className="launcher__card-title" id="apps-heading">
        Applications
      </h2>
      <table className="launcher__table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Release</th>
            <th>Running</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {apps.length === 0 ? (
            <tr>
              <td className="launcher__empty" colSpan={4}>
                Nothing imported yet. Use <code>broapp-autoapp import</code> to add one.
              </td>
            </tr>
          ) : (
            apps.map((app) => (
              <tr
                key={app.appId}
                className={app.appId === selected ? 'launcher__row launcher__row--selected' : 'launcher__row'}
                onClick={() => onSelect(app.appId)}
              >
                <td>
                  {app.name}
                  {app.activationPending && (
                    <span className="launcher__badge" title="An update was interrupted">
                      unfinished update
                    </span>
                  )}
                </td>
                <td>
                  <code>{app.currentRelease?.slice(0, 8) ?? 'none'}</code>
                  {app.schemaVersion === null ? '' : ` · schema ${String(app.schemaVersion)}`}
                </td>
                <td>{app.serving ? `yes (pid ${String(app.pid ?? 0)})` : 'no'}</td>
                <td className="launcher__row-actions">
                  <button
                    className="launcher__button"
                    type="button"
                    disabled={app.currentRelease === null}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(app.appId);
                    }}
                  >
                    Open
                  </button>
                  <button
                    className="launcher__button launcher__button--small"
                    type="button"
                    disabled={!app.serving}
                    onClick={(event) => {
                      event.stopPropagation();
                      onStop(app.appId);
                    }}
                  >
                    Stop
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
