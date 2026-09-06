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

import { contract } from '../shared/contract.ts';
import { App } from './App.tsx';
import './styles.css';
import 'broapp/ai/react/ai.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from the document');

createRoot(container).render(
  <StrictMode>
    {/* The AI contract rides on the same connection: one socket, one session,
        two route tables. `AiProvider` owns the settings the panels share. */}
    <BroappProvider contract={contract} extensions={[aiContract]}>
      <AiProvider>
        <App />
      </AiProvider>
    </BroappProvider>
  </StrictMode>,
);
