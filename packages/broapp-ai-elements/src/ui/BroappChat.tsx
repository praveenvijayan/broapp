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

export function BroappChat({
  refs,
  placeholder,
  emptyText,
  onToolResult,
  onAwaiting,
  markdown = true,
}: BroappChatProps): React.ReactElement {
  const { settings } = useAiContext();
  const chat = useBroappChat({
    ...(refs === undefined ? {} : { refs }),
    ...(onToolResult === undefined ? {} : { onToolResult }),
    ...(onAwaiting === undefined ? {} : { onAwaiting }),
  });
  const { messages, status, error, confirmError, usage, awaiting, sendMessage, stop, confirm } =
    chat;

  const now = useTick(awaiting > 0);

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
      <section aria-labelledby="ai-chat-title" className="card ai-chat">
        <h2 className="card__title" id="ai-chat-title">
          Assistant
        </h2>
        <p className="form__hint">
          {/* Until the first settings read returns there is nothing to say yet,
              and saying "not set up" would be a guess that is wrong as often as
              it is right. */}
          {settings === null
            ? 'Checking the AI settings…'
            : 'AI is not set up. Open Settings to choose a provider.'}
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="ai-chat-title" className="card ai-chat">
      <h2 className="card__title" id="ai-chat-title">
        Assistant
      </h2>
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
      />
    </section>
  );
}
