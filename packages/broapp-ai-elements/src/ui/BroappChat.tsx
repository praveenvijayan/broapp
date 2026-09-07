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
  /** Render assistant text as markdown. Default true. */
  readonly markdown?: boolean;
  /** Offered while the transcript is empty; clicking one sends it. */
  readonly suggestions?: readonly string[];
  /** One line under the suggestions, e.g. the keyboard shortcut. */
  readonly suggestionTip?: string;
  /** Characters allowed in one message. Default 20,000 — the contract's cap. */
  readonly maxLength?: number;
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
  markdown = true,
  suggestions,
  suggestionTip,
  maxLength,
  frame = 'card',
  controlsRef,
}: BroappChatProps): React.ReactElement {
  const { settings } = useAiContext();
  const chat = useBroappChat({
    ...(refs === undefined ? {} : { refs }),
    ...(onToolResult === undefined ? {} : { onToolResult }),
    ...(onAwaiting === undefined ? {} : { onAwaiting }),
  });
  const {
    messages,
    status,
    error,
    confirmError,
    usage,
    awaiting,
    sendMessage,
    stop,
    confirm,
    clear,
  } = chat;

  const now = useTick(awaiting > 0);

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
        <p className="form__hint">
          {/* Until the first settings read returns there is nothing to say yet,
              and saying "not set up" would be a guess that is wrong as often as
              it is right. */}
          {settings === null
            ? 'Checking the AI settings…'
            : 'AI is not set up. Open Settings to choose a provider.'}
        </p>
      </Frame>
    );
  }

  return (
    <Frame frame={frame}>
      <BroappChatView
        emptyText={emptyText ?? 'Ask a question about what you are looking at.'}
        error={confirmError ?? error?.message ?? null}
        markdown={markdown}
        messages={messages}
        now={now}
        onConfirm={(callId, approve) => void confirm(callId, approve)}
        onSend={send}
        onStop={() => void stop()}
        placeholder={placeholder ?? 'Ask about these notes'}
        status={status}
        usage={usage}
        {...(suggestions === undefined ? {} : { suggestions })}
        {...(suggestionTip === undefined ? {} : { suggestionTip })}
        {...(maxLength === undefined ? {} : { maxLength })}
      />
    </Frame>
  );
}
