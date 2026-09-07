/**
 * One conversation, built out of the AI SDK's `useChat`.
 *
 * `useChat` owns the messages, the status and the errors; this hook owns the
 * three things it has no place for — a confirmation answered through the host,
 * the count of calls waiting for a person, and the usage the host reports at
 * the end of a turn.
 */
import * as React from 'react';

import { useChat } from '@ai-sdk/react';
import type { UseChatHelpers } from '@ai-sdk/react';
import { useAiContext } from 'broapp/ai/react';

import { createBroappChatTransport } from './transport.ts';
import type {
  BroappChatTransport,
  BroappChatTransportOptions,
  BroappUIMessage,
} from './transport.ts';

/** Options for {@link useBroappChat}. */
export interface BroappChatOptions {
  /** Records the user is looking at, sent with every message. */
  readonly refs?: readonly string[];
  /** Called when a tool call settles, so an application can refetch. */
  readonly onToolResult?: BroappChatTransportOptions['onToolResult'];
  /** Called whenever the number of calls waiting for a person changes. */
  readonly onAwaiting?: BroappChatTransportOptions['onAwaiting'];
  /** Stable chat id. Default: one per hook instance. */
  readonly id?: string;
}

/** What {@link useBroappChat} returns: `useChat`'s helpers, plus Broapp's own. */
export interface BroappChatHook extends UseChatHelpers<BroappUIMessage> {
  confirm(callId: string, approve: boolean): Promise<void>;
  /** Set when `confirm` was refused; cleared on the next send. */
  readonly confirmError: string | null;
  /** From the last assistant message's metadata. */
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  /** Calls waiting for a person, right now. */
  readonly awaiting: number;
  clear(): void;
}

export function useBroappChat(options: BroappChatOptions = {}): BroappChatHook {
  const shared = useAiContext();
  const [awaiting, setAwaiting] = React.useState(0);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);

  // Read inside the transport's callbacks, which are created once. Everything
  // the caller passes can change on any render; the transport must not.
  const refs = React.useRef<readonly string[]>(options.refs ?? []);
  refs.current = options.refs ?? [];
  const onToolResult = React.useRef<BroappChatOptions['onToolResult']>(undefined);
  onToolResult.current = options.onToolResult;
  const onAwaiting = React.useRef<BroappChatOptions['onAwaiting']>(undefined);
  onAwaiting.current = options.onAwaiting;
  const client = React.useRef(shared.client);
  client.current = shared.client;

  const transport = React.useRef<BroappChatTransport | null>(null);
  transport.current ??= createBroappChatTransport({
    client: () => client.current(),
    refs: () => refs.current,
    onToolResult: (call) => onToolResult.current?.(call),
    onAwaiting: (pending) => {
      // Our own state first: a caller's callback may render, and it should see
      // the same number this hook reports.
      setAwaiting(pending);
      onAwaiting.current?.(pending);
    },
  });
  const active = transport.current;

  const chat = useChat<BroappUIMessage>({
    transport: active,
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  const { messages, sendMessage, setMessages, stop } = chat;

  // Unmount cancels the turn: the producer is a process on this machine, and a
  // stream nobody cancels goes on running the model.
  React.useEffect(() => () => active.cancel(), [active]);

  const usage = React.useMemo<BroappChatHook['usage']>(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === undefined || message.role !== 'assistant') continue;
      return message.metadata?.usage ?? null;
    }
    return null;
  }, [messages]);

  const send = React.useCallback<UseChatHelpers<BroappUIMessage>['sendMessage']>(
    (...args) => {
      setConfirmError(null);
      return sendMessage(...args);
    },
    [sendMessage],
  );

  const confirm = React.useCallback(
    async (callId: string, approve: boolean): Promise<void> => {
      try {
        await active.confirm(callId, approve);
      } catch (cause) {
        setConfirmError(cause instanceof Error ? cause.message : 'That answer could not be sent.');
      }
    },
    [active],
  );

  const clear = React.useCallback((): void => {
    void stop();
    setMessages([]);
    setConfirmError(null);
    setAwaiting(0);
  }, [stop, setMessages]);

  return { ...chat, sendMessage: send, confirm, confirmError, usage, awaiting, clear };
}
