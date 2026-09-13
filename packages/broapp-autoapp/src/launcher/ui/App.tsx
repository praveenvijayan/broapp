/**
 * The launcher's tab.
 *
 * Ordinary React, not the renderer. Two of the things it has to do — open a
 * browser tab at an address it was just handed, and show the problems from a
 * build that failed — are not expressible as a view specification, and this is
 * Broapp's own interface rather than something an engineer proposes changes to.
 *
 * The layout is a workspace rather than a page with a drawer: the rail and the
 * conversation list on the left, the chat in the middle, the applications on
 * the right, and Settings over the top of them on demand. Nothing in the grid
 * moves when Settings opens — a person answering a question about the table
 * should not have the table walk away from under the answer.
 *
 * The launch URLs are handled with some care. They arrive from `appOpen` and
 * `previewOpen`, go straight to `window.open`, and are not kept in state. A URL
 * in React state would end up in a devtools inspection, a re-render trace and
 * anything else that walks the tree.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { AiSettings } from 'broapp/ai/react';
import { useAiThreads } from 'broapp-ai-elements';
import {
  BroappChat,
  BroappChatMenu,
  BroappModelPicker,
  BroappSchemeToggle,
  BroappThreadList,
} from 'broapp-ai-elements/ui';
import type { BroappChatControls, BroappScheme } from 'broapp-ai-elements/ui';
import { useConnection, useOperation } from 'broapp/react';
import { announcePending, browserSurface } from 'broapp-autoapp/react';
import { BookOpen, History, PanelRight, Plus, ScrollText, SlidersHorizontal } from 'lucide-react';

import type { LauncherContract } from '../contract.ts';

import { AppsTable } from './AppsTable.tsx';
import { CandidatePanel } from './CandidatePanel.tsx';
import { KnowledgePanel } from './KnowledgePanel.tsx';
import { LogsPanel } from './LogsPanel.tsx';
import { ReleasesPanel } from './ReleasesPanel.tsx';
import { readScheme, applyScheme, SCHEME_KEY } from './scheme.ts';

/** Where the columns' open state and the chosen conversation are remembered. */
const HISTORY_OPEN = 'broapp-autoapp:history-open';
const APPS_OPEN = 'broapp-autoapp:apps-open';
const ACTIVE_THREAD = 'broapp-autoapp:thread';

/**
 * Four things the engineer can actually do, offered before anything is said.
 *
 * Each maps onto a tool it has: `apps.create`, `apps.list`, `source.read` plus
 * `source.edit`, and the journal behind `spec.read` — see
 * `engineer/instructions.ts`. The first is left unfinished on purpose: the
 * person completes the sentence, and what they write is the description.
 */
/**
 * What the running mark says between tool calls, while the engineer decides.
 *
 * Decoration for a wait that can run to minutes, changed every few seconds so
 * the panel is visibly alive; the tool that is running, the elapsed time and
 * the call count beside it are the status. Nothing here claims a stage the
 * turn has not reached.
 */
const ENGINEER_STATUS_LINES: readonly string[] = [
  'Thinking…',
  'Reading the workspace…',
  'Weighing the options…',
  'Mocking up a change…',
  'Working through it…',
  'Surviving the details…',
  'Putting it together…',
  'Still at it…',
];

const ENGINEER_SUGGESTIONS = [
  'Create a new application for…',
  'What applications do I have?',
  'Add a field to notes',
  'What changed in the last candidate?',
];

/** Read a remembered flag. Storage can be unavailable, and that is not a fault. */
function remembered(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === 'true';
  } catch {
    return fallback;
  }
}

/** Write one, ignoring a storage that refuses. The page still works. */
function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the launcher still works, it just forgets.
  }
}

export function App(): React.ReactElement {
  const connection = useConnection();
  const apps = useOperation<LauncherContract, 'launcher.appsList'>('launcher.appsList');
  const open = useOperation<LauncherContract, 'launcher.appOpen'>('launcher.appOpen');
  const stop = useOperation<LauncherContract, 'launcher.appStop'>('launcher.appStop');
  const selectOperation = useOperation<LauncherContract, 'launcher.appSelect'>('launcher.appSelect');
  const threads = useAiThreads();

  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(() => remembered(HISTORY_OPEN, true));
  const [appsOpen, setAppsOpen] = useState(() => remembered(APPS_OPEN, true));
  const [scheme, setScheme] = useState<BroappScheme>(() => readScheme());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Which side panel a narrow window is showing over the chat, if any. On a
  // desktop width both columns are simply there and this is ignored; under
  // 40rem they are overlays, and two of them open at once would bury the chat
  // the moment the window was resized.
  const [narrowPanel, setNarrowPanel] = useState<'history' | 'apps' | null>(null);

  // Bumped whenever something the engineer did may have changed what the
  // panels below show.
  const [changed, setChanged] = useState(0);
  // How many of the engineer's tool calls are waiting for an answer. The tab
  // renames itself while any are, because a question that arrives after ten
  // minutes of a model thinking arrives at a tab nobody is looking at.
  const waiting = useRef(0);
  // The same count as state, for the strip above the conversation. A renamed
  // tab reaches somebody who is elsewhere; the strip reaches somebody who is
  // here and has scrolled away from the card. On 2026-09-12 a card waited the
  // whole ten minutes unseen and the work of a forty-minute turn went with it.
  const [pending, setPending] = useState(0);
  const onAwaiting = useCallback((pending: number): void => {
    setPending(pending);
    const surface = browserSurface();
    if (surface === null) return;
    announcePending(surface, pending, waiting.current);
    waiting.current = pending;
  }, []);
  const showQuestion = useCallback((): void => {
    document.querySelector('.broapp-chat__confirm')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);
  // What the chat's own header reaches the conversation through.
  const controls = useRef<BroappChatControls | null>(null);

  const { run: refreshApps } = apps;
  const ready = connection.phase === 'ready';
  useEffect(() => {
    if (ready) void refreshApps(undefined);
  }, [ready, refreshApps, changed]);

  const rows = apps.data?.apps ?? [];
  useEffect(() => {
    if (selected === null && rows.length > 0) setSelected(rows[0]?.appId ?? null);
  }, [rows, selected]);

  // An application that has just been made, waiting for the list it is in.
  // Selecting it before `appsList` has been read again would put the panels
  // below on an id the table does not yet have a row for.
  const [awaitingSelection, setAwaitingSelection] = useState<string | null>(null);
  useEffect(() => {
    if (awaitingSelection === null) return;
    if (!rows.some((row) => row.appId === awaitingSelection)) return;
    setSelected(awaitingSelection);
    setAwaitingSelection(null);
  }, [rows, awaitingSelection]);

  /** A new application exists: refresh the list, then select it. */
  const noteCreated = useCallback((appId: string): void => {
    setAwaitingSelection(appId);
    setChanged((count) => count + 1);
  }, []);

  /**
   * One is gone: refresh the list, and stop showing the panels about it.
   *
   * Cleared rather than moved to a neighbour. The effect above selects the
   * first row when nothing is selected, which is the same rule that runs when
   * the launcher opens — and it is better than choosing an application on
   * somebody's behalf straight after they removed one.
   */
  const noteRemoved = useCallback((appId: string): void => {
    setSelected((current) => (current === appId ? null : current));
    setAwaitingSelection((current) => (current === appId ? null : current));
    setChanged((count) => count + 1);
  }, []);

  // A row the person clicked is what the engineer's next turn is about. Only a
  // click: the first row shown by default is not a choice anybody made.
  const { run: rememberSelection } = selectOperation;
  const chooseApp = useCallback(
    (appId: string): void => {
      setSelected(appId);
      void rememberSelection({ appId });
    },
    [rememberSelection],
  );

  const chooseThread = useCallback((id: string): void => {
    setActiveId(id);
    remember(ACTIVE_THREAD, id);
  }, []);

  // One conversation is always open, so the box is never asking to be typed
  // into a thread that does not exist. `starting` keeps a slow create from
  // being asked for twice while the list is still empty.
  const starting = useRef(false);
  const { create: createThread, loading: threadsLoading, threads: threadList } = threads;
  useEffect(() => {
    if (threadsLoading) return;
    if (activeId !== null && threadList.some((thread) => thread.id === activeId)) return;
    if (threadList.length === 0) {
      if (starting.current) return;
      starting.current = true;
      void createThread().then((thread) => {
        starting.current = false;
        if (thread !== null) chooseThread(thread.id);
      });
      return;
    }
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(ACTIVE_THREAD);
    } catch {
      stored = null;
    }
    const found = threadList.find((thread) => thread.id === stored) ?? threadList[0];
    if (found !== undefined) chooseThread(found.id);
  }, [threadsLoading, threadList, activeId, createThread, chooseThread]);

  const active = threadList.find((thread) => thread.id === activeId) ?? null;

  /** Open one application in its own tab. The URL is used and forgotten. */
  const openApp = useCallback(
    async (appId: string): Promise<void> => {
      await open.run({ appId });
      setChanged((count) => count + 1);
    },
    [open],
  );

  const newThread = useCallback(async (): Promise<void> => {
    const thread = await threads.create('New conversation', null);
    if (thread !== null) chooseThread(thread.id);
  }, [threads, chooseThread]);

  const deleteThread = useCallback(
    async (id: string): Promise<void> => {
      await threads.remove(id);
      if (id !== activeId) return;
      // The next most recent, or a fresh one: the panel always has somewhere
      // to put the next question.
      const next = threadList.find((thread) => thread.id !== id) ?? null;
      if (next === null) setActiveId(null);
      else chooseThread(next.id);
    },
    [threads, threadList, activeId, chooseThread],
  );

  const toggle = useCallback((key: string, set: (value: boolean) => void, value: boolean): void => {
    set(value);
    remember(key, String(value));
  }, []);

  /** A rail toggle: opens the column, and says which one a narrow window shows. */
  const toggleColumn = useCallback(
    (which: 'history' | 'apps', key: string, set: (value: boolean) => void, value: boolean): void => {
      toggle(key, set, value);
      setNarrowPanel(value ? which : null);
    },
    [toggle],
  );

  const chooseScheme = useCallback((next: BroappScheme): void => {
    setScheme(next);
    applyScheme(next);
    remember(SCHEME_KEY, next);
  }, []);

  // Escape closes Settings wherever the focus is inside it, and focus goes to
  // its first control on open and back to the button that opened it on close.
  const settingsRef = useRef<HTMLElement | null>(null);
  // The button that opened Settings, so closing it can hand focus back. Typed
  // as the element it is assigned from, which is also why no `instanceof` is
  // needed to use it — one is unsafe across an Autoapp release boundary.
  const settingsOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!showSettings) return undefined;
    settingsRef.current?.querySelector<HTMLElement>('select, button, input')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowSettings(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const previous = settingsOpener.current;
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, [showSettings]);

  // Escape closes the Knowledge panel, as it does Settings. Not while a field
  // inside it has focus and something to lose: a half-written lesson is closed
  // with its own Cancel.
  useEffect(() => {
    if (!showKnowledge) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      if (active !== null && (active.tagName === 'TEXTAREA' || active.closest('form') !== null)) return;
      setShowKnowledge(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showKnowledge]);

  // The host opens the tab; this page never sees the address. All it can be
  // told is that no browser could be opened.
  const notOpened = open.data?.opened === false;

  const shell = [
    'launcher',
    historyOpen ? '' : ' launcher--history-hidden',
    appsOpen ? '' : ' launcher--apps-hidden',
    narrowPanel === null ? '' : ` launcher--narrow-${narrowPanel}`,
  ].join('');

  return (
    <div className={shell}>
      <nav aria-label="Workspace" className="launcher__rail">
        <button
          aria-label="New conversation"
          className="launcher__rail-button"
          onClick={() => void newThread()}
          title="New conversation"
          type="button"
        >
          <Plus aria-hidden="true" size={17} />
        </button>
        <button
          aria-expanded={historyOpen}
          aria-label="Conversations"
          className="launcher__rail-button"
          onClick={() => toggleColumn('history', HISTORY_OPEN, setHistoryOpen, !historyOpen)}
          title="Conversations"
          type="button"
        >
          <History aria-hidden="true" size={17} />
        </button>
        <button
          aria-expanded={appsOpen}
          aria-label="Applications"
          className="launcher__rail-button"
          onClick={() => toggleColumn('apps', APPS_OPEN, setAppsOpen, !appsOpen)}
          title="Applications"
          type="button"
        >
          <PanelRight aria-hidden="true" size={17} />
        </button>
        <button
          aria-expanded={showLogs}
          aria-label="Log"
          className="launcher__rail-button"
          onClick={() => setShowLogs((open) => !open)}
          title="Log"
          type="button"
        >
          <ScrollText aria-hidden="true" size={17} />
        </button>
        <button
          aria-expanded={showKnowledge}
          aria-label="Knowledge"
          className="launcher__rail-button"
          onClick={() => setShowKnowledge((open) => !open)}
          title="Knowledge"
          type="button"
        >
          <BookOpen aria-hidden="true" size={17} />
        </button>
        <div className="launcher__rail-spacer" />
        {/*
          The switch is a component of the panel's, drawn outside the panel:
          `.broapp-tokens` is what gives it the panel's colours here, and the
          rail is too narrow for three buttons on one line.
        */}
        <div className="broapp-tokens launcher__rail-scheme">
          <BroappSchemeToggle onChange={chooseScheme} orientation="vertical" value={scheme} />
        </div>
      </nav>

      {historyOpen ? (
        <aside aria-label="Conversations" className="launcher__history">
          <BroappThreadList
            activeId={activeId}
            loading={threads.loading}
            onCollapse={() => toggleColumn('history', HISTORY_OPEN, setHistoryOpen, false)}
            onDelete={(id) => void deleteThread(id)}
            onNew={() => void newThread()}
            onRename={(id, title) => void threads.rename(id, title)}
            onSelect={chooseThread}
            threads={threadList}
          />
          {threads.error === null ? null : (
            <p className="launcher__message launcher__message--error" role="alert">
              {threads.error.message}
            </p>
          )}
        </aside>
      ) : null}

      <section aria-label="Engineer" className="launcher__chat">
        <BroappChat
          controlsRef={controls}
          statusLines={ENGINEER_STATUS_LINES}
          emptyText={`Ask for a change to ${selected ?? 'an application'}. It will propose one, build it, and show you a preview running on a copy of your data before anything is replaced.`}
          frame="plain"
          modelId={active?.modelId ?? null}
          onAwaiting={onAwaiting}
          // The host derives a conversation's title from its first message, so
          // the list beside this one only learns the real title by reading it
          // back once the turn has been written.
          onTurnEnd={() => void threads.refresh()}
          onToolResult={(call) => {
            // Anything that built, previewed or activated changes what the
            // panels beside this one should be showing.
            if (call.status === 'done' && !call.tool.startsWith('source.read')) {
              setChanged((count) => count + 1);
            }
            // An application the engineer made is one the person is about to
            // want selected. The id comes from the call's own input, which is
            // the only place it is spelled out: the tool's output says what
            // was built, not what it was called.
            if (call.status === 'done' && call.tool === 'apps.create') {
              const made = (call.input as { appId?: unknown } | undefined)?.appId;
              if (typeof made === 'string') noteCreated(made);
            }
          }}
          placeholder="Ask for a change…"
          refs={selected === null ? [] : [`app:${selected}`]}
          suggestions={ENGINEER_SUGGESTIONS}
          threadId={activeId}
          topBar={
            <>
              <BroappModelPicker
                onChange={(modelId) => {
                  if (activeId !== null) void threads.setModel(activeId, modelId);
                }}
                value={active?.modelId ?? null}
              />
              <span className="launcher__spacer" />
              {pending > 0 ? (
                <button className="launcher__waiting" onClick={showQuestion} type="button">
                  {pending === 1 ? 'Waiting for your answer' : `${String(pending)} questions waiting`} · show
                </button>
              ) : null}
              <span
                className={`launcher__status launcher__status--${connection.phase}`}
                role="status"
              >
                {connection.phase === 'ready' ? 'Connected' : connection.phase}
              </span>
              <button
                aria-expanded={showSettings}
                aria-label="Settings"
                className="launcher__icon-button"
                onClick={(event) => {
                  settingsOpener.current = event.currentTarget;
                  setShowSettings((shown) => !shown);
                }}
                title="Settings"
                type="button"
              >
                <SlidersHorizontal aria-hidden="true" size={16} />
              </button>
              <button
                aria-label="New conversation"
                className="launcher__icon-button"
                onClick={() => void newThread()}
                title="New conversation"
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
              </button>
              <BroappChatMenu
                onClear={() => controls.current?.clear()}
                onCopy={() => {
                  void navigator.clipboard?.writeText(controls.current?.transcript() ?? '');
                }}
                onDelete={() => {
                  if (activeId !== null) void deleteThread(activeId);
                }}
              />
            </>
          }
        />
      </section>

      {appsOpen ? (
        <section aria-label="Your applications" className="launcher__apps">
          <h1 className="launcher__title">Your applications</h1>

          <AppsTable
            apps={rows}
            selected={selected}
            onSelect={chooseApp}
            onCreated={noteCreated}
            onRemoved={noteRemoved}
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
        </section>
      ) : null}

      {showLogs ? (
        <>
          <button aria-label="Close log" className="launcher__scrim" onClick={() => setShowLogs(false)} type="button" />
          <LogsPanel apps={rows.map((row) => row.appId)} onClose={() => setShowLogs(false)} />
        </>
      ) : null}

      {showKnowledge ? (
        <>
          <button
            aria-label="Close knowledge"
            className="launcher__scrim"
            onClick={() => setShowKnowledge(false)}
            type="button"
          />
          <KnowledgePanel apps={rows.map((row) => row.appId)} onClose={() => setShowKnowledge(false)} />
        </>
      ) : null}

      {showSettings ? (
        <>
          {/* The backdrop is a button so a pointer and a keyboard both close
              the drawer the same way; Escape is handled above. */}
          <button
            aria-label="Close settings"
            className="launcher__scrim"
            onClick={() => setShowSettings(false)}
            type="button"
          />
          <aside aria-label="Settings" className="launcher__settings" ref={settingsRef}>
            <div className="launcher__settings-header">
              <h2 className="launcher__card-title">Settings</h2>
              <button
                className="launcher__button launcher__button--small"
                onClick={() => setShowSettings(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <AiSettings />
            <section className="launcher__card">
              <h2 className="launcher__card-title">Conversations</h2>
              <p className="launcher__lede">
                Every conversation is kept on this computer, in the launcher&apos;s own data
                directory.
              </p>
              {confirmClear ? (
                <div className="launcher__row-actions">
                  <span>Delete every conversation?</span>
                  <button
                    className="launcher__button launcher__button--small"
                    onClick={() => {
                      setConfirmClear(false);
                      setActiveId(null);
                      void threads.clearAll();
                    }}
                    type="button"
                  >
                    Delete all
                  </button>
                  <button
                    className="launcher__button launcher__button--small"
                    onClick={() => setConfirmClear(false)}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="launcher__button launcher__button--small"
                  onClick={() => setConfirmClear(true)}
                  type="button"
                >
                  Clear all conversations
                </button>
              )}
            </section>
          </aside>
        </>
      ) : null}
    </div>
  );
}
