/**
 * The launcher's page, reduced to what `bun run theme-check` measures of it.
 *
 * The launcher draws with its own `--launcher-*` variables, in both schemes,
 * and until prompt 20a it drew no switch. This page puts the one it draws now —
 * *Work without asking*, off and on — and the engineer's top-bar line beside
 * it, under `launcher.css` as the launcher's own page loads it, so the harness
 * can read what the browser computed rather than what a stylesheet says.
 *
 * The same shell as the application page (`index.html`); a page of its own
 * because `launcher.css` styles the whole document, and would change what
 * every renderer and panel measurement is taken against.
 */
import * as React from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { StandingLine, StandingSwitch } from '../../packages/broapp-autoapp/src/launcher/ui/StandingSettings.tsx';

import '../../packages/broapp-autoapp/src/launcher/ui/launcher.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from the document');

createRoot(container).render(
  <StrictMode>
    <aside aria-label="Settings" className="launcher__settings">
      <div data-check="switch-off">
        <StandingSwitch error={null} onChange={() => undefined} pending={false} standing={false} />
      </div>
      <div data-check="switch-on">
        <StandingSwitch error={null} onChange={() => undefined} pending={false} standing />
      </div>
    </aside>
    <div data-check="top-bar">
      <StandingLine onAskAgain={() => undefined} pending={false} />
    </div>
  </StrictMode>,
);
