/**
 * A paragraph with values substituted into it.
 *
 * The substitution is why this is a component rather than a string: the result
 * is built as an array of React children, so a value that happens to contain
 * markup is rendered as the text it is. There is no `dangerouslySetInnerHTML`
 * anywhere in this renderer, and a template cannot introduce one.
 */
import * as React from 'react';

import { readPath } from '../bind.ts';
import { usePage } from '../context.tsx';
import { formatValue } from '../format.ts';
import type { Component } from '../../views/types.ts';

/** `{{sourceId.path}}`, and nothing else. Validated at parse time; split on here. */
const PLACEHOLDER = /(\{\{[a-z][a-z0-9-]*(?:\.[A-Za-z0-9_]+)*\}\})/g;

export function Text({ component }: { readonly component: Component }): React.ReactElement {
  const page = usePage();
  const template = component.template ?? '';

  const parts = template.split(PLACEHOLDER).filter((part) => part !== undefined);
  const rendered = parts.map((part, index) => {
    if (!part.startsWith('{{') || !part.endsWith('}}')) return part;
    const reference = part.slice(2, -2);
    const cut = reference.indexOf('.');
    const sourceId = cut < 0 ? reference : reference.slice(0, cut);
    const path = cut < 0 ? '' : reference.slice(cut + 1);
    const source = page.sources[sourceId];
    // A source that has not loaded yet renders as nothing rather than as the
    // placeholder: the sentence around it is still readable while it arrives.
    const value = source === undefined ? undefined : readPath(source.data, path);
    return <React.Fragment key={`${String(index)}-${part}`}>{formatValue(value)}</React.Fragment>;
  });

  return (
    <p className="autoapp-text" data-autoapp-id={component.id}>
      {rendered}
    </p>
  );
}
