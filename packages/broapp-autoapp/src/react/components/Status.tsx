/** One value from a source, with a label. */
import * as React from 'react';

import { readPath } from '../bind.ts';
import { usePage } from '../context.tsx';
import { formatValue } from '../format.ts';
import type { Component } from '../../views/types.ts';

export function Status({ component }: { readonly component: Component }): React.ReactElement {
  const page = usePage();
  const source = component.source === undefined ? undefined : page.sources[component.source];
  const value = source === undefined ? undefined : readPath(source.data, component.path ?? '');

  return (
    <div className="autoapp-status" data-autoapp-id={component.id}>
      <span className="autoapp-status__label">{component.label ?? component.id}</span>
      <span className="autoapp-status__value">{formatValue(value, component.format)}</span>
      {source?.error != null && (
        <span className="autoapp-message autoapp-message--error" role="alert">
          {source.error}
        </span>
      )}
    </div>
  );
}
