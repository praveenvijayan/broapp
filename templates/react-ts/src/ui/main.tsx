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

import { contract } from '../shared/contract.ts';
import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from the document');

createRoot(container).render(
  <StrictMode>
    <BroappProvider contract={contract}>
      <App />
    </BroappProvider>
  </StrictMode>,
);
