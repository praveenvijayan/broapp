/**
 * One conversation.
 *
 * `useStream` is not used here: it keeps only the most recent event, and a
 * chat needs every one of them in order. What it does copy exactly is
 * `useStream`'s unmount behaviour — cancelling the subscription — because the
 * producer is a process on the user's own machine and a stream nobody cancels
 * goes on running the model.
 */
import * as React from 'react';

import type { Subscription } from '../../client/client.ts';
import { BroappError } from '../../shared/errors.ts';
import type { ChatEvent, ChatTurn } from '../shared/types.ts';

import { useAiContext } from './provider.tsx';

/** What one tool call is doing. */
export interface ToolCallState {
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly status: 'running' | 'awaiting-confirmation' | 'done' | 'denied';
  readonly output?: unknown;
}

/** One message in the transcript. */
export type ChatMessage =
  | { readonly id: string; readonly role: 'user'; readonly content: string }
  | {
      readonly id: string;
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls: ToolCallState[];
      readonly pending: boolean;
    };

/** What {@link useAiChat} returns. */
export interface AiChatHook {
  readonly messages: ChatMessage[];
  readonly status: 'idle' | 'streaming' | 'awaiting-confirmation' | 'error';
  readonly error: string | null;
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  send(text: string): Promise<void>;
  cancel(): void;
  confirm(callId: string, approve: boolean): Promise<void>;
  clear(): void;
}

/** The contract caps history at 100 turns; the oldest are dropped. */
const MAX_HISTORY = 100;

/** A run id matching the contract's pattern. */
function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Every completed turn, as the model should see it. */
function toHistory(messages: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && (message.pending || message.content === '')) continue;
    turns.push({ role: message.role, content: message.content });
  }
  return turns.slice(-MAX_HISTORY);
}

export function useAiChat(options: { refs?: readonly string[] } = {}): AiChatHook {
  const shared = useAiContext();
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [status, setStatus] = React.useState<AiChatHook['status']>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [usage, setUsage] = React.useState<AiChatHook['usage']>(null);
  const active = React.useRef<Subscription | null>(null);
  const runId = React.useRef<string>('');
  const mounted = React.useRef(true);
  const refs = options.refs ?? [];
  // Read inside the subscription callbacks, which are created once per send.
  const refsRef = React.useRef<readonly string[]>(refs);
  refsRef.current = refs;

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.cancel();
      active.current = null;
    };
  }, []);

  /** Change the assistant message this turn is writing into. */
  const patchPending = React.useCallback(
    (change: (message: Extract<ChatMessage, { role: 'assistant' }>) => ChatMessage): void => {
      setMessages((current) => {
        const index = current.length - 1;
        const last = current[index];
        if (last === undefined || last.role !== 'assistant') return current;
        const next = [...current];
        next[index] = change(last);
        return next;
      });
    },
    [],
  );

  const apply = React.useCallback(
    (event: ChatEvent): void => {
      switch (event.type) {
        case 'text':
          patchPending((message) => ({ ...message, content: message.content + (event.text ?? '') }));
          break;
        case 'tool-call':
          patchPending((message) => ({
            ...message,
            toolCalls: [
              ...message.toolCalls,
              {
                callId: event.callId ?? '',
                tool: event.tool ?? '',
                input: event.input,
                status: 'running',
              },
            ],
          }));
          break;
        case 'confirm':
          setStatus('awaiting-confirmation');
          patchPending((message) => ({
            ...message,
            toolCalls: message.toolCalls.map((call) =>
              call.callId === event.callId ? { ...call, status: 'awaiting-confirmation' } : call,
            ),
          }));
          break;
        case 'tool-result':
          setStatus((current) => (current === 'awaiting-confirmation' ? 'streaming' : current));
          patchPending((message) => ({
            ...message,
            toolCalls: message.toolCalls.map((call) =>
              call.callId === event.callId
                ? {
                    ...call,
                    status: event.denied === true ? 'denied' : 'done',
                    output: event.output,
                  }
                : call,
            ),
          }));
          break;
        case 'usage':
          setUsage({
            inputTokens: event.inputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
          });
          break;
        case 'done':
          active.current = null;
          setStatus('idle');
          patchPending((message) => ({ ...message, pending: false }));
          break;
        case 'error':
          active.current = null;
          setStatus('error');
          setError(event.message ?? 'The AI provider returned an error.');
          patchPending((message) => ({ ...message, pending: false }));
          break;
      }
    },
    [patchPending],
  );

  const send = React.useCallback(
    async (text: string): Promise<void> => {
      // A second question while the first is still being answered would need a
      // second run and a second transcript. Ignored rather than queued.
      if (active.current !== null || status === 'streaming' || status === 'awaiting-confirmation') {
        return;
      }
      const trimmed = text.trim();
      if (trimmed === '') return;

      const history = toHistory(messages);
      const id = newRunId();
      runId.current = id;
      setError(null);
      setUsage(null);
      setStatus('streaming');
      setMessages((current) => [
        ...current,
        { id: `${id}-user`, role: 'user', content: trimmed },
        { id: `${id}-assistant`, role: 'assistant', content: '', toolCalls: [], pending: true },
      ]);

      try {
        const connected = await shared.client();
        if (!mounted.current) return;
        const subscription = await connected.subscribe(
          'ai.chat',
          { runId: id, message: trimmed, refs: [...refsRef.current], history },
          {
            onEvent: (event) => {
              if (mounted.current) apply(event);
            },
            onDone: () => {
              if (!mounted.current) return;
              active.current = null;
              setStatus((current) => (current === 'error' ? current : 'idle'));
              patchPending((message) => ({ ...message, pending: false }));
            },
            onError: (cause) => {
              if (!mounted.current) return;
              active.current = null;
              setStatus('error');
              setError(cause.message);
              patchPending((message) => ({ ...message, pending: false }));
            },
          },
        );
        if (!mounted.current) {
          subscription.cancel();
          return;
        }
        active.current = subscription;
      } catch (cause) {
        if (!mounted.current) return;
        active.current = null;
        setStatus('error');
        setError(
          cause instanceof BroappError ? cause.message : 'The conversation could not be started.',
        );
        patchPending((message) => ({ ...message, pending: false }));
      }
    },
    [shared, status, messages, apply, patchPending],
  );

  const cancel = React.useCallback((): void => {
    if (active.current === null) return;
    active.current.cancel();
    active.current = null;
    setStatus('idle');
    // The text so far is kept: the user asked to stop, not to undo.
    patchPending((message) => ({ ...message, pending: false }));
  }, [patchPending]);

  const confirm = React.useCallback(
    async (callId: string, approve: boolean): Promise<void> => {
      try {
        const connected = await shared.client();
        const result = await connected.call('ai.chatConfirm', {
          runId: runId.current,
          callId,
          approve,
        });
        if (!result.accepted) {
          // Nobody was waiting: the turn timed out or was cancelled while the
          // question was on screen.
          setError('That request has expired.');
        }
      } catch (cause) {
        setError(cause instanceof BroappError ? cause.message : 'That answer could not be sent.');
      }
    },
    [shared],
  );

  const clear = React.useCallback((): void => {
    active.current?.cancel();
    active.current = null;
    setMessages([]);
    setStatus('idle');
    setError(null);
    setUsage(null);
  }, []);

  return { messages, status, error, usage, send, cancel, confirm, clear };
}
