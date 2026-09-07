/** One action, on its own. */
import * as React from 'react';

import { usePage } from '../context.tsx';
import type { Component } from '../../views/types.ts';

export function Button({ component }: { readonly component: Component }): React.ReactElement | null {
  const page = usePage();
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const action = component.action;
  if (action === undefined) return null;

  return (
    <div className="autoapp-button-row" data-autoapp-id={component.id}>
      <button
        type="button"
        className="autoapp-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void page.run(action, { params: page.params }).then((outcome) => {
            setBusy(false);
            setFailure(outcome);
          });
        }}
      >
        {action.label}
      </button>
      {failure !== null && (
        <p className="autoapp-message autoapp-message--error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
