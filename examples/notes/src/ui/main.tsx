/**
 * The browser entry point.
 *
 * Everything under `src/ui` is bundled into a single inline script by
 * `broapp build`. It may import from `src/shared`, and it must not import from
 * `src/host` — that would try to pull `node:fs` into a browser bundle, which
 * fails the build. There is a test that asserts this stays true.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BroappProvider } from 'broapp/react';
import { aiContract, AiProvider } from 'broapp/ai/react';
import { autoappContract } from 'broapp-autoapp/react';

import { contract } from '../shared/contract.ts';
import { App } from './App.tsx';
import './styles.css';
import 'broapp/ai/react/ai.css';
import 'broapp-autoapp/react/view.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from the document');

createRoot(container).render(
  <StrictMode>
    {/* Broapp's own contracts ride on the same connection: one socket, one
        session, three route tables. `AiProvider` owns the settings the AI
        panels share; the renderer reads its views over `autoapp`. */}
    <BroappProvider contract={contract} extensions={[aiContract, autoappContract]}>
      <AiProvider>
        <App />
      </AiProvider>
    </BroappProvider>
  </StrictMode>,
);
