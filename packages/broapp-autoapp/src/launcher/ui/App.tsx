/**
 * The launcher's tab.
 *
 * Ordinary React, not the renderer. Two of the things it has to do — open a
 * browser tab at an address it was just handed, and show the problems from a
 * build that failed — are not expressible as a view specification, and this is
 * Broapp's own interface rather than something an engineer proposes changes to.
 *
 * The launch URLs are handled with some care. They arrive from `appOpen` and
 * `previewOpen`, go straight to `window.open`, and are not kept in state. A URL
 * in React state would end up in a devtools inspection, a re-render trace and
 * anything else that walks the tree.
 */
import { useCallback, useEffect, useState } from 'react';

import { AiChat, AiSettings } from 'broapp/ai/react';
import { useConnection, useOperation } from 'broapp/react';

import type { LauncherContract } from '../contract.ts';

import { AppsTable } from './AppsTable.tsx';
import { CandidatePanel } from './CandidatePanel.tsx';
import { ReleasesPanel } from './ReleasesPanel.tsx';

export function App(): React.ReactElement {
  const connection = useConnection();
  const apps = useOperation<LauncherContract, 'launcher.appsList'>('launcher.appsList');
  const open = useOperation<LauncherContract, 'launcher.appOpen'>('launcher.appOpen');
  const stop = useOperation<LauncherContract, 'launcher.appStop'>('launcher.appStop');

  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Bumped whenever something the engineer did may have changed what the
  // panels below show.
  const [changed, setChanged] = useState(0);

  const { run: refreshApps } = apps;
  const ready = connection.phase === 'ready';
  useEffect(() => {
    if (ready) void refreshApps(undefined);
  }, [ready, refreshApps, changed]);

  const rows = apps.data?.apps ?? [];
  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0]?.appId ?? null);
  }, [rows, selected]);

  /** Open one application in its own tab. The URL is used and forgotten. */
  const openApp = useCallback(
    async (appId: string): Promise<void> => {
      await open.run({ appId });
      setChanged((count) => count + 1);
    },
    [open],
  );

  // `open.data` is consumed here rather than rendered: the effect fires once
  // per successful call, opens the tab, and nothing keeps the address.
  useEffect(() => {
    const url = open.data?.url;
    if (url === undefined) return;
    globalThis.open(url, '_blank', 'noopener');
    open.reset();
  }, [open]);

  return (
    <div className="launcher">
      <header className="launcher__header">
        <div>
          <h1 className="launcher__title">Your applications</h1>
          <p className="launcher__lede">
            Each one runs as its own process on this computer, with your permissions.
          </p>
        </div>
        <div className="launcher__header-actions">
          <span className={`launcher__status launcher__status--${connection.phase}`} role="status">
            {connection.phase === 'ready' ? 'Connected' : connection.phase}
          </span>
          <button
            className="launcher__button"
            type="button"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((shown) => !shown)}
          >
            Settings
          </button>
        </div>
      </header>

      <main className="launcher__main">
        {showSettings && (
          <section className="launcher__card">
            <AiSettings />
          </section>
        )}

        <AppsTable
          apps={rows}
          selected={selected}
          onSelect={setSelected}
          onOpen={(appId) => void openApp(appId)}
          onStop={(appId) => void stop.run({ appId }).then(() => setChanged((count) => count + 1))}
        />
        {apps.error !== null && (
          <p className="launcher__message launcher__message--error" role="alert">
            {apps.error.message}
          </p>
        )}

        {selected !== null && (
          <>
            <CandidatePanel appId={selected} onChanged={() => setChanged((count) => count + 1)} />
            <ReleasesPanel appId={selected} reloadToken={changed} />
          </>
        )}
      </main>

      <aside className="launcher__aside">
        <h2 className="launcher__aside-title">Engineer</h2>
        <p className="launcher__lede">
          Ask for a change to {selected ?? 'an application'}. It will propose one, build it, and
          show you a preview running on a copy of your data before anything is replaced.
        </p>
        <AiChat
          refs={selected === null ? [] : [`app:${selected}`]}
          placeholder="Ask for a change…"
          onToolResult={(call) => {
            // Anything that built, previewed or activated changes what the
            // panels should be showing.
            if (call.status === 'done' && !call.tool.startsWith('source.read')) {
              setChanged((count) => count + 1);
            }
          }}
        />
      </aside>
    </div>
  );
}
