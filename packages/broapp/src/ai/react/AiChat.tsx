/**
 * The chat panel.
 *
 * The assistant's text is rendered as text. No markdown library, no
 * `dangerouslySetInnerHTML`: the content is written by a model that has just
 * been shown documents from the user's own machine, and a renderer that turns
 * some of that into markup is a way for a document to reach the page. A
 * `<pre>` with `white-space: pre-wrap` keeps the line breaks, which is most of
 * what markdown would have been used for anyway.
 */
import * as React from 'react';

import { countdown, isUrgent } from '../../shared/countdown.ts';

import { useAiChat, type AiChatOptions, type ToolCallState } from './use-ai-chat.ts';
import { useAiSettings } from './use-ai-settings.ts';

/** Props for {@link AiChat}. */
export interface AiChatProps {
  /** Records the user is looking at, sent with every message. */
  readonly refs?: readonly string[];
  readonly placeholder?: string;
  readonly emptyText?: string;
  /** Called when a tool call settles, so the application can refetch. */
  readonly onToolResult?: AiChatOptions['onToolResult'];
  /**
   * How many tool calls are waiting for the person, whenever that changes.
   *
   * The panel does not act on this itself: a tab that renamed itself or raised
   * a notification without being asked would do it in every application that
   * embeds a chat. The launcher asks, because its questions arrive after ten
   * minutes of silence and the person is not looking at the tab.
   */
  readonly onAwaiting?: (pending: number) => void;
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

function ToolCall({
  call,
  onConfirm,
}: {
  call: ToolCallState;
  onConfirm: (callId: string, approve: boolean) => void;
}): React.ReactElement {
  const waiting = call.status === 'awaiting-confirmation' && call.expiresAt !== undefined;
  const now = useTick(waiting);
  const urgent = call.expiresAt !== undefined && waiting && isUrgent(call.expiresAt, now);
  return (
    <div className="ai-chat__tool">
      <details>
        <summary>
          {call.status === 'denied' ? 'Declined' : 'Used'} {call.tool}
        </summary>
        <pre className="ai-chat__json">{JSON.stringify(call.input, null, 2)}</pre>
        {call.output === undefined ? null : (
          <pre className="ai-chat__json">{JSON.stringify(call.output, null, 2)}</pre>
        )}
      </details>
      {call.status !== 'awaiting-confirmation' ? null : (
        <div
          className={`ai-chat__confirm${urgent ? ' ai-chat__confirm--urgent' : ''}`}
          role="group"
          aria-label={`Allow ${call.asks ?? call.tool}?`}
        >
          {/* A question about one of this call's own steps says which step. */}
          <span>{call.asks === undefined ? 'Allow this?' : `Allow ${call.asks}?`}</span>
          {call.asks === undefined || call.asksInput === undefined ? null : (
            <pre className="ai-chat__json">{JSON.stringify(call.asksInput, null, 2)}</pre>
          )}
          {call.expiresAt === undefined ? null : (
            <span className="ai-chat__expires">expires in {countdown(call.expiresAt, now)}</span>
          )}
          <button
            className="button button--primary"
            type="button"
            onClick={() => onConfirm(call.confirmId ?? call.callId, true)}
          >
            Allow
          </button>
          <button className="button" type="button" onClick={() => onConfirm(call.confirmId ?? call.callId, false)}>
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

export function AiChat({
  refs,
  placeholder,
  emptyText,
  onToolResult,
  onAwaiting,
}: AiChatProps): React.ReactElement {
  const { settings } = useAiSettings();
  const chat = useAiChat({
    ...(refs === undefined ? {} : { refs }),
    ...(onToolResult === undefined ? {} : { onToolResult }),
  });
  const [draft, setDraft] = React.useState('');
  const input = React.useRef<HTMLTextAreaElement | null>(null);
  const busy = chat.status === 'streaming' || chat.status === 'awaiting-confirmation';

  const waiting = chat.messages.reduce(
    (count, message) =>
      message.role === 'assistant'
        ? count +
          message.toolCalls.filter((call) => call.status === 'awaiting-confirmation').length
        : count,
    0,
  );
  const announce = React.useRef(onAwaiting);
  announce.current = onAwaiting;
  React.useEffect(() => {
    announce.current?.(waiting);
  }, [waiting]);

  // Back to the box when the turn ends, so a conversation can be carried on
  // without reaching for the mouse.
  React.useEffect(() => {
    if (chat.status === 'idle') input.current?.focus();
  }, [chat.status]);

  if (settings === null || settings.configured !== true) {
    return (
      <section className="card ai-chat" aria-labelledby="ai-chat-title">
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

  const submit = (): void => {
    const text = draft;
    setDraft('');
    void chat.send(text);
  };

  return (
    <section className="card ai-chat" aria-labelledby="ai-chat-title">
      <h2 className="card__title" id="ai-chat-title">
        Assistant
      </h2>

      <div className="ai-chat__messages" role="log" aria-live="polite">
        {chat.messages.length === 0 ? (
          <p className="form__hint">{emptyText ?? 'Ask a question about what you are looking at.'}</p>
        ) : null}
        {chat.messages.map((message) =>
          message.role === 'user' ? (
            <div className="ai-chat__message ai-chat__message--user" key={message.id}>
              <pre className="ai-chat__text">{message.content}</pre>
            </div>
          ) : (
            <div className="ai-chat__message ai-chat__message--assistant" key={message.id}>
              {message.toolCalls.map((call) => (
                <ToolCall
                  call={call}
                  key={call.callId}
                  onConfirm={(callId, approve) => void chat.confirm(callId, approve)}
                />
              ))}
              <pre className="ai-chat__text">{message.content}</pre>
              {message.pending ? <span className="ai-chat__typing">…</span> : null}
            </div>
          ),
        )}
      </div>

      {chat.error === null ? null : (
        <p className="message message--error" role="alert">
          {chat.error}
        </p>
      )}
      {chat.usage === null ? null : (
        <p className="form__hint ai-chat__usage">
          {chat.usage.inputTokens} tokens in, {chat.usage.outputTokens} out
        </p>
      )}

      <div className="ai-chat__composer">
        <label className="form__label" htmlFor="ai-chat-input">
          Message
        </label>
        <textarea
          className="input ai-chat__input"
          id="ai-chat-input"
          ref={input}
          rows={3}
          placeholder={placeholder ?? 'Ask about these notes'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline. Anything with a modifier
            // is left alone, so the platform shortcuts still work.
            if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            if (!busy) submit();
          }}
        />
        <div className="ai-chat__actions">
          <button
            className="button button--primary"
            type="button"
            disabled={busy || draft.trim() === ''}
            onClick={submit}
          >
            Send
          </button>
          <button className="button" type="button" disabled={!busy} onClick={chat.cancel}>
            Stop
          </button>
          <button
            className="button"
            type="button"
            disabled={chat.messages.length === 0}
            onClick={chat.clear}
          >
            Clear
          </button>
        </div>
      </div>
    </section>
  );
}
