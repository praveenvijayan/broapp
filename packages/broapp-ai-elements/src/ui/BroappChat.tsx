/**
 * The panel, wired to the host.
 *
 * A drop-in replacement for `broapp/ai/react`'s `AiChat`: the same props, the
 * same three settings states, the same sentences — and underneath, the AI
 * SDK's `useChat` over the Brobridge transport, so markdown, attachments and
 * tool cards come from standard components rather than from this file.
 */
import * as React from 'react';

import type { FileUIPart } from 'ai';
import { useAiContext } from 'broapp/ai/react';

import { useBroappChat } from '../use-broapp-chat.ts';
import type { BroappChatOptions } from '../use-broapp-chat.ts';

import { BroappChatView } from './BroappChatView.tsx';
import { transcriptOf } from './transcript.ts';

/**
 * The two things a surrounding chrome needs from the conversation.
 *
 * Published through a ref rather than returned, because the header that uses
 * them — the drawer's — is drawn above this component and cannot be below it.
 * Both are read from an event handler, long after the render that set them.
 */
export interface BroappChatControls {
  /** Forget the conversation. Stops a running turn first. */
  clear(): void;
  /** What has been said so far, as plain text. */
  transcript(): string;
}

/** Props for {@link BroappChat}. */
export interface BroappChatProps {
  /** Records the user is looking at, sent with every message. */
  readonly refs?: readonly string[];
  readonly placeholder?: string;
  readonly emptyText?: string;
  /** Called when a tool call settles, so the application can refetch. */
  readonly onToolResult?: BroappChatOptions['onToolResult'];
  /** How many tool calls are waiting for a person, whenever that changes. */
  readonly onAwaiting?: BroappChatOptions['onAwaiting'];
  /** After a turn has ended and the conversation has been written back. */
  readonly onTurnEnd?: BroappChatOptions['onTurnEnd'];
  /** Render assistant text as markdown. Default true. */
  readonly markdown?: boolean;
  /** Offered while the transcript is empty; clicking one sends it. */
  readonly suggestions?: readonly string[];
  /** One line under the suggestions, e.g. the keyboard shortcut. */
  readonly suggestionTip?: string;
  /** Characters allowed in one message. Default 20,000 — the contract's cap. */
  readonly maxLength?: number;
  /** Phrases the running mark rotates between tool calls. See `Loader.tsx`. */
  readonly statusLines?: readonly string[];
  /**
   * Drawn above the conversation, inside the panel: a model picker, a menu,
   * whatever the surrounding application puts there. Shown in every settings
   * state, because the button that opens Settings is usually in it — and that
   * is exactly what somebody who has not set AI up needs to reach.
   */
  readonly topBar?: React.ReactNode;
  /**
   * The stored conversation to load on mount and save after every turn.
   * Null or absent keeps the conversation in memory only.
   */
  readonly threadId?: string | null;
  /** The model this conversation talks to. Null follows Settings. */
  readonly modelId?: string | null;
  /**
   * `"card"` (default) draws the panel as a titled card, as `AiChat` does.
   * `"plain"` draws the conversation alone, for a chrome that has its own
   * heading — the drawer.
   */
  readonly frame?: 'card' | 'plain';
  /** Filled in with {@link BroappChatControls} on every render. */
  readonly controlsRef?: React.MutableRefObject<BroappChatControls | null>;
}

/** Re-render once a second while `active`, so a countdown counts. */
function useTick(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The card around the conversation, or nothing at all.
 *
 * A drawer already has a heading and a border; a second one inside it would
 * say the panel's name twice and draw a box inside a box.
 */
function Frame({
  frame,
  children,
}: {
  frame: 'card' | 'plain';
  children: React.ReactNode;
}): React.ReactElement {
  if (frame === 'plain') return <>{children}</>;
  return (
    <section aria-labelledby="ai-chat-title" className="card ai-chat">
      <h2 className="card__title" id="ai-chat-title">
        Assistant
      </h2>
      {children}
    </section>
  );
}

export function BroappChat({
  refs,
  placeholder,
  emptyText,
  onToolResult,
  onAwaiting,
  onTurnEnd,
  markdown = true,
  suggestions,
  suggestionTip,
  maxLength,
  topBar,
  threadId,
  modelId,
  frame = 'card',
  controlsRef,
  statusLines,
}: BroappChatProps): React.ReactElement {
  const { settings } = useAiContext();
  const chat = useBroappChat({
    ...(refs === undefined ? {} : { refs }),
    ...(onToolResult === undefined ? {} : { onToolResult }),
    ...(onAwaiting === undefined ? {} : { onAwaiting }),
    ...(onTurnEnd === undefined ? {} : { onTurnEnd }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(modelId === undefined ? {} : { modelId }),
  });
  const {
    messages,
    status,
    error,
    confirmError,
    usage,
    awaiting,
    loading,
    sendMessage,
    stop,
    confirm,
    clear,
  } = chat;

  // Once a second while a countdown runs, and while a turn runs: the running
  // mark shows the turn's elapsed time and changes its phrase on the tick.
  const busy = status === 'submitted' || status === 'streaming';
  const now = useTick(awaiting > 0 || busy);

  // Assigned during render, the way `useBroappChat` keeps its own callbacks
  // current: an effect would leave the first paint's buttons pointing at
  // nothing, and these are only ever read from a click.
  if (controlsRef !== undefined) {
    controlsRef.current = { clear, transcript: () => transcriptOf(messages) };
  }

  const send = React.useCallback(
    (message: { text: string; files: FileUIPart[] }): void => {
      void sendMessage({
        text: message.text,
        ...(message.files.length === 0 ? {} : { files: message.files }),
      });
    },
    [sendMessage],
  );

  if (settings === null || settings.configured !== true) {
    return (
      <Frame frame={frame}>
        <div className="broapp-chat">
          {topBar === undefined ? null : <div className="broapp-chat__topbar">{topBar}</div>}
          {/* Until the first settings read returns there is nothing to say yet,
              and saying "not set up" would be a guess that is wrong as often as
              it is right. */}
          <p className="form__hint">
            {settings === null
              ? 'Checking the AI settings…'
              : 'AI is not set up. Open Settings to choose a provider.'}
          </p>
        </div>
      </Frame>
    );
  }

  return (
    <Frame frame={frame}>
      <BroappChatView
        emptyText={emptyText ?? 'Ask a question about what you are looking at.'}
        error={confirmError ?? error?.message ?? null}
        loading={loading}
        markdown={markdown}
        messages={messages}
        now={now}
        onConfirm={(callId, approve) => void confirm(callId, approve)}
        onSend={send}
        onStop={() => void stop()}
        placeholder={placeholder ?? 'Ask about these notes'}
        status={status}
        usage={usage}
        {...(topBar === undefined ? {} : { topBar })}
        {...(suggestions === undefined ? {} : { suggestions })}
        {...(suggestionTip === undefined ? {} : { suggestionTip })}
        {...(maxLength === undefined ? {} : { maxLength })}
        {...(statusLines === undefined ? {} : { statusLines })}
      />
    </Frame>
  );
}
