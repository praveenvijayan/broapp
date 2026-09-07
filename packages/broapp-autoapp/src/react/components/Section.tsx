/** A group of components with an optional heading. */
import * as React from 'react';

import type { Component } from '../../views/types.ts';

/** Props every rendered component takes. */
export interface ComponentProps {
  readonly component: Component;
  /** Rendered children, for the kinds that have any. */
  readonly children?: React.ReactNode;
}

export function Section({ component, children }: ComponentProps): React.ReactElement {
  return (
    <section className="autoapp-section" data-autoapp-id={component.id}>
      {component.label !== undefined && component.label !== '' && (
        <h2 className="autoapp-section__title">{component.label}</h2>
      )}
      {children}
    </section>
  );
}
