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
import { useCallback, useEffect, useRef, useState } from 'react';

import { AiSettings } from 'broapp/ai/react';
import { BroappChatDrawer, BroappChatToggle } from 'broapp-ai-elements/ui';
import { useConnection, useOperation } from 'broapp/react';
import { announcePending, browserSurface } from 'broapp-autoapp/react';

import type { LauncherContract } from '../contract.ts';

import { AppsTable } from './AppsTable.tsx';
import { CandidatePanel } from './CandidatePanel.tsx';
import { ReleasesPanel } from './ReleasesPanel.tsx';

/** Where the drawer's open state is remembered. */
const ENGINEER_OPEN = 'broapp-autoapp:engineer-open';

/**
 * Three things the engineer can actually do, offered before anything is said.
 *
 * Each maps onto a tool it has: `apps.list`, `source.read` plus `source.edit`,
 * and the journal behind `spec.read` — see `engineer/instructions.ts`.
 */
const ENGINEER_SUGGESTIONS = [
  'What applications do I have?',
  'Add a field to notes',
  'What changed in the last candidate?',
];

export function App(): React.ReactElement {
  const connection = useConnection();
  const apps = useOperation<LauncherContract, 'launcher.appsList'>('launcher.appsList');
  const open = useOperation<LauncherContract, 'launcher.appOpen'>('launcher.appOpen');
  const stop = useOperation<LauncherContract, 'launcher.appStop'>('launcher.appStop');

  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Whether the engineer's drawer is open, remembered across reloads: somebody
  // who works with it open should not have to open it again after every build.
  // Storage can be unavailable or full, and neither is worth a broken page.
  const [engineerOpen, setEngineerOpen] = useState(() => {
    try {
      return window.localStorage.getItem(ENGINEER_OPEN) === 'true';
    } catch {
      return false;
    }
  });
  const setEngineer = useCallback((open: boolean): void => {
    setEngineerOpen(open);
    try {
      window.localStorage.setItem(ENGINEER_OPEN, String(open));
    } catch {
      // Nothing to do: the drawer still works, it just forgets.
    }
  }, []);
  // Bumped whenever something the engineer did may have changed what the
  // panels below show.
  const [changed, setChanged] = useState(0);
  // How many of the engineer's tool calls are waiting for an answer. The tab
  // renames itself while any are, because a question that arrives after ten
  // minutes of a model thinking arrives at a tab nobody is looking at.
  const waiting = useRef(0);
  const onAwaiting = useCallback((pending: number): void => {
    const surface = browserSurface();
    if (surface === null) return;
    announcePending(surface, pending, waiting.current);
    waiting.current = pending;
  }, []);

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

  // The host opens the tab; this page never sees the address. All it can be
  // told is that no browser could be opened.
  const notOpened = open.data?.opened === false;

  return (
    <div className={`launcher${engineerOpen ? ' launcher--drawer-open' : ''}`}>
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
          <BroappChatToggle
            label="Ask AI"
            onToggle={() => setEngineer(!engineerOpen)}
            open={engineerOpen}
          />
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
        {open.error !== null && (
          <p className="launcher__message launcher__message--error" role="alert">
            {open.error.message}
          </p>
        )}
        {notOpened && (
          <p className="launcher__message launcher__message--error" role="alert">
            The application is running, but no browser could be opened. Its address is printed
            in the terminal the launcher runs in.
          </p>
        )}

        {selected !== null && (
          <>
            <CandidatePanel appId={selected} onChanged={() => setChanged((count) => count + 1)} />
            <ReleasesPanel appId={selected} reloadToken={changed} />
          </>
        )}
      </main>

      <BroappChatDrawer
        description={`Ask for a change to ${selected ?? 'an application'}. It will propose one, build it, and show you a preview running on a copy of your data before anything is replaced.`}
        onAwaiting={onAwaiting}
        onOpenChange={setEngineer}
        onToolResult={(call) => {
          // Anything that built, previewed or activated changes what the
          // panels should be showing.
          if (call.status === 'done' && !call.tool.startsWith('source.read')) {
            setChanged((count) => count + 1);
          }
        }}
        open={engineerOpen}
        placeholder="Ask for a change…"
        refs={selected === null ? [] : [`app:${selected}`]}
        suggestions={ENGINEER_SUGGESTIONS}
        title="Engineer"
      />
    </div>
  );
}
