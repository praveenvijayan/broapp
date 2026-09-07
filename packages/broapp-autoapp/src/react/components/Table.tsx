/**
 * A table over one source's rows.
 *
 * The two things worth reading: a column may navigate, and a row may carry
 * actions. Both take their values out of the row by path, so a table never
 * needs to know what an application's records look like.
 */
import * as React from 'react';

import { readPath } from '../bind.ts';
import { buildHash, usePage } from '../context.tsx';
import { formatValue } from '../format.ts';
import type { Component } from '../../views/types.ts';

export function Table({ component }: { readonly component: Component }): React.ReactElement {
  const page = usePage();
  const [failure, setFailure] = React.useState<string | null>(null);

  const source = component.source === undefined ? undefined : page.sources[component.source];
  const raw = source === undefined ? undefined : readPath(source.data, component.rows ?? '');
  const rows: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const columns = component.columns ?? [];
  const rowActions = component.rowActions ?? [];

  return (
    <div className="autoapp-table" data-autoapp-id={component.id}>
      {component.label !== undefined && component.label !== '' && (
        <h2 className="autoapp-table__title">{component.label}</h2>
      )}
      {/* A source failure belongs under the thing that could not be drawn, not
          at the top of the page where it is disconnected from the cause. */}
      {source?.error != null && (
        <p className="autoapp-message autoapp-message--error" role="alert">
          {source.error}
        </p>
      )}
      {failure !== null && (
        <p className="autoapp-message autoapp-message--error" role="alert">
          {failure}
        </p>
      )}
      <table className="autoapp-table__grid">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} className={`autoapp-col autoapp-col--${column.width ?? 'normal'}`}>
                {column.header}
              </th>
            ))}
            {rowActions.length > 0 && <th className="autoapp-col autoapp-col--narrow" />}
          </tr>
        </thead>
        <tbody>
          {/* The headers stay when there is nothing to show. A table that
              collapses to one sentence loses the shape of what would be there,
              which is the thing a person is usually checking. */}
          {rows.length === 0 ? (
            <tr>
              <td className="autoapp-empty" colSpan={columns.length + (rowActions.length > 0 ? 1 : 0)}>
                {component.emptyText ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={String(index)}>
                {columns.map((column) => {
                  const value = formatValue(readPath(row, column.path), column.format);
                  const link = column.link;
                  return (
                    <td key={column.id} className={`autoapp-col autoapp-col--${column.width ?? 'normal'}`}>
                      {link === undefined ? (
                        value
                      ) : (
                        <a
                          className="autoapp-link"
                          href={buildHash(
                            link.page,
                            link.params.map((path) => String(readPath(row, path) ?? '')),
                          )}
                        >
                          {value}
                        </a>
                      )}
                    </td>
                  );
                })}
                {rowActions.length > 0 && (
                  <td className="autoapp-col autoapp-col--narrow autoapp-row-actions">
                    {rowActions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className="autoapp-button autoapp-button--small"
                        data-autoapp-id={action.id}
                        onClick={() => {
                          void page.run(action, { params: page.params, row }).then(setFailure);
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
