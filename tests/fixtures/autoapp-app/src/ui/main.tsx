/**
 * The fixture's browser entry.
 *
 * The pinned renderer over the application's contract, and nothing else. No
 * chat panel: the fixture exists to exercise activation, and an AI layer would
 * only add a provider registry nobody in these tests configures.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BroappProvider } from 'broapp/react';
import { AutoappView, autoappContract } from 'broapp-autoapp/react';
import 'broapp-autoapp/react/view.css';

import { contract } from '../shared/contract.ts';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from the document');

createRoot(container).render(
  <StrictMode>
    <BroappProvider contract={contract} extensions={[autoappContract]}>
      <AutoappView />
    </BroappProvider>
  </StrictMode>,
);
