/**
 * The browser entry.
 *
 * The pinned renderer over this application's contract, and nothing else. No
 * chat panel: the engineer lives in the launcher's own tab, and pulling an AI
 * layer in here would add three packages and a provider registry to an
 * application nobody has asked for one in yet.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BroappProvider } from 'broapp/react';
import { AutoappView, autoappContract } from 'broapp-autoapp/react';
import 'broapp-autoapp/react/tokens.css';
import 'broapp-autoapp/react/view.css';
import './styles.css';

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
