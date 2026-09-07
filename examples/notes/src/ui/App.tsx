/**
 * Notes.
 *
 * There is almost nothing here. The list, the form and the details panel are
 * not React components in this application any more — they are entries in
 * `src/shared/views.ts`, drawn by `broapp-autoapp/react`, which is pinned and
 * the same for every Autoapp application. What is left in this file is the
 * frame: the heading, the connection badge, and the AI panels.
 *
 * That is the whole point of the arrangement. An AI engineer can propose a
 * different interface by proposing a different view specification, and nothing
 * that runs in the browser changes — so the page's content-security policy
 * stays pinned to the hashes the build computed.
 */
import { useEffect, useState } from 'react';
import { AutoappView } from 'broapp-autoapp/react';
import { AiSettings } from 'broapp/ai/react';
import { BroappChat } from 'broapp-ai-elements/ui';

import { ConnectionBadge } from './ConnectionBadge.tsx';

/** The note the person is looking at, from the hash: `#/note/12` is `note:12`. */
function useOpenNote(): readonly string[] {
  const read = (): readonly string[] => {
    const match = /^#\/note\/(\d+)/.exec(globalThis.location.hash);
    return match === null ? [] : [`note:${match[1] ?? ''}`];
  };
  const [refs, setRefs] = useState<readonly string[]>(read);
  useEffect(() => {
    const onChange = (): void => setRefs(read());
    globalThis.addEventListener('hashchange', onChange);
    return () => globalThis.removeEventListener('hashchange', onChange);
  }, []);
  return refs;
}

export function App(): React.ReactElement {
  const [showSettings, setShowSettings] = useState(false);
  // Bumped when an approved tool call may have changed the database, so the
  // renderer reloads rather than showing a list the model has already edited.
  const [changed, setChanged] = useState(0);
  const refs = useOpenNote();

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">Notes</h1>
          <p className="app__lede">
            Kept in a SQLite database on this computer. Nothing leaves it.
          </p>
          <p className="app__lede">
            AI features are optional and off until you set them up in Settings.
          </p>
        </div>
        <div className="app__header-actions">
          <a className="button" href="#/notes">
            Notes
          </a>
          <a className="button" href="#/status">
            Details
          </a>
          <button
            className="button"
            type="button"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((open) => !open)}
          >
            Settings
          </button>
          <ConnectionBadge />
        </div>
      </header>

      <main className="app__main">
        {showSettings && (
          <section className="card">
            <AiSettings />
          </section>
        )}

        <AutoappView reloadToken={changed} />

        {/* The note being looked at is what the model is shown. Everything else
            it needs it has to search for. */}
        <BroappChat
          refs={refs}
          placeholder="Ask about your notes…"
          onToolResult={(call) => {
            if (call.status === 'done' && call.tool !== 'notes.list' && call.tool !== 'notes.get') {
              setChanged((count) => count + 1);
            }
          }}
        />
      </main>
    </div>
  );
}
