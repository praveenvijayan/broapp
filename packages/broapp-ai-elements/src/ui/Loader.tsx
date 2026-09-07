/**
 * The "still thinking" mark.
 *
 * The AI Elements registry at 1.9.0 has no `loader` component; its spinner is
 * the shadcn primitive, which is what this wraps, with the label a screen
 * reader needs.
 */
import * as React from 'react';

import { Spinner } from './components/ui/spinner.tsx';

/** Shown while a turn is running and no word of the reply has arrived. */
export function Loader(): React.ReactElement {
  return (
    <p aria-live="polite" className="broapp-chat__loader">
      <Spinner aria-hidden="true" />
      <span>Thinking…</span>
    </p>
  );
}
