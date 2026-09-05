/**
 * The starter interface.
 *
 * Three things, each showing one part of the pattern: a connection indicator,
 * a typed call, and a cancellable progress stream. The technical explanation
 * lives in a collapsed panel at the bottom, so the visible controls read as an
 * application rather than as a protocol demonstration.
 */
import { useEffect } from 'react';

import { ConnectionBadge } from './ConnectionBadge.tsx';
import { GreetCard } from './GreetCard.tsx';
import { PrimesCard } from './PrimesCard.tsx';
import { DeveloperPanel } from './DeveloperPanel.tsx';
import { useConnection } from 'broapp/react';

export function App(): React.ReactElement {
  const connection = useConnection();

  // Reflect the connection in the document title, so a user with the tab in
  // the background can see that the application stopped without switching to
  // it.
  useEffect(() => {
    const base = document.title.replace(/^\W+\s/, '');
    document.title = connection.phase === 'ready' ? base : `• ${base}`;
  }, [connection.phase]);

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">__APP_TITLE__</h1>
          <p className="app__lede">
            This is a local application. It runs as a process on this computer and uses your
            browser as its window — nothing here is sent over the internet.
          </p>
        </div>
        <ConnectionBadge />
      </header>

      <main className="app__main">
        <GreetCard />
        <PrimesCard />
      </main>

      <footer className="app__footer">
        <DeveloperPanel />
      </footer>
    </div>
  );
}
