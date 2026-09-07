/**
 * The launcher tab's browser entry.
 *
 * Two contracts on one connection: the launcher's own routes, and Broapp's AI
 * layer, which is where the engineer lives. There is no application contract
 * here — the launcher never speaks to an application over its own bridge, it
 * supervises processes and hands out addresses.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BroappProvider } from 'broapp/react';
import { aiContract, AiProvider } from 'broapp/ai/react';
import 'broapp/ai/react/ai.css';

import { launcherContract } from '../contract.ts';
import { App } from './App.tsx';
import './launcher.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from the document');

createRoot(container).render(
  <StrictMode>
    <BroappProvider contract={launcherContract} extensions={[aiContract]}>
      <AiProvider>
        <App />
      </AiProvider>
    </BroappProvider>
  </StrictMode>,
);
