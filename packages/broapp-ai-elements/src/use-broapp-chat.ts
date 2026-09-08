/**
 * One conversation, built out of the AI SDK's `useChat`.
 *
 * `useChat` owns the messages, the status and the errors; this hook owns the
 * things it has no place for — a confirmation answered through the host, the
 * count of calls waiting for a person, the usage the host reports at the end of
 * a turn, and the thread the whole conversation is loaded from and saved back
 * to.
 */
import * as React from 'react';

import { useChat } from '@ai-sdk/react';
import type { UseChatHelpers } from '@ai-sdk/react';
import type { StoredMessage } from 'broapp/ai';
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
  /**
   * Called after a turn has ended and the conversation has been written back.
   *
   * A list of conversations shown beside the panel learns two things only from
   * the store: the title the host derived from the first message, and when the
   * conversation last changed. Neither can be predicted here, so the caller is
   * told when it is worth reading them again.
   */
  readonly onTurnEnd?: () => void;
  /** Stable chat id. Default: one per hook instance. */
  readonly id?: string;
  /**
   * Load this conversation on mount and save it after every turn.
   *
   * Null or absent keeps the conversation in memory only, which is what every
   * panel did before threads existed.
   */
  readonly threadId?: string | null;
  /** Sent with every turn. Null: whatever Settings says. */
  readonly modelId?: string | null;
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
  /** True while a conversation is being read; the panel shows a quiet state. */
  readonly loading: boolean;
  clear(): void;
}

/**
 * A message as the host stores it.
 *
 * `parts` cross the bridge as `unknown[]` because the host never reads inside
 * one. The cast is where that ends: on the way back in, they are the SDK's
 * parts again, which is the only thing they ever were.
 */
function toStored(message: BroappUIMessage): StoredMessage {
  return message.metadata === undefined
    ? { id: message.id, role: message.role, parts: message.parts }
    : { id: message.id, role: message.role, parts: message.parts, metadata: message.metadata };
}

function fromStored(message: StoredMessage): BroappUIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts as BroappUIMessage['parts'],
    ...(message.metadata === undefined
      ? {}
      : { metadata: message.metadata as BroappUIMessage['metadata'] }),
  };
}

/** A cause turned into the error a panel can show. */
function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

export function useBroappChat(options: BroappChatOptions = {}): BroappChatHook {
  const shared = useAiContext();
  const [awaiting, setAwaiting] = React.useState(0);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [threadError, setThreadError] = React.useState<Error | null>(null);

  // Read inside the transport's callbacks, which are created once. Everything
  // the caller passes can change on any render; the transport must not.
  const refs = React.useRef<readonly string[]>(options.refs ?? []);
  refs.current = options.refs ?? [];
  const onToolResult = React.useRef<BroappChatOptions['onToolResult']>(undefined);
  onToolResult.current = options.onToolResult;
  const onAwaiting = React.useRef<BroappChatOptions['onAwaiting']>(undefined);
  onAwaiting.current = options.onAwaiting;
  const onTurnEnd = React.useRef<BroappChatOptions['onTurnEnd']>(undefined);
  onTurnEnd.current = options.onTurnEnd;
  const client = React.useRef(shared.client);
  client.current = shared.client;
  const modelId = React.useRef<string | null>(options.modelId ?? null);
  modelId.current = options.modelId ?? null;

  const threadId = options.threadId ?? null;
  // Read from `onFinish`, which the SDK calls outside React's rendering, so it
  // must not close over a render's value of the thread.
  const thread = React.useRef<string | null>(threadId);
  thread.current = threadId;

  const transport = React.useRef<BroappChatTransport | null>(null);
  transport.current ??= createBroappChatTransport({
    client: () => client.current(),
    refs: () => refs.current,
    modelId: () => modelId.current,
    onToolResult: (call) => onToolResult.current?.(call),
    onAwaiting: (pending) => {
      // Our own state first: a caller's callback may render, and it should see
      // the same number this hook reports.
      setAwaiting(pending);
      onAwaiting.current?.(pending);
    },
  });
  const active = transport.current;

  /**
   * Write the conversation back.
   *
   * Called from `onFinish`, which the SDK runs in a `finally`: a turn that
   * finished, one the person stopped and one that errored all reach it, and
   * all three are worth keeping — the text so far is the answer to what
   * happened.
   */
  const persist = React.useCallback(
    async (messages: readonly BroappUIMessage[]): Promise<void> => {
      const id = thread.current;
      if (id === null) return;
      try {
        const connected = await client.current();
        await connected.call('ai.threadsSave', { id, messages: messages.map(toStored) });
      } catch (cause) {
        // Reported, never thrown: a conversation that could not be written is
        // not a reason to stop the person asking the next question.
        setThreadError(asError(cause, 'That conversation could not be saved.'));
      } finally {
        // After the write, whether it worked or not: a failed save is exactly
        // when a list showing what is stored should be read again.
        onTurnEnd.current?.();
      }
    },
    [],
  );

  const chat = useChat<BroappUIMessage>({
    transport: active,
    ...(options.id === undefined ? {} : { id: options.id }),
    onFinish: ({ messages }) => void persist(messages),
  });
  const { messages, sendMessage, setMessages, stop } = chat;

  // Unmount cancels the turn: the producer is a process on this machine, and a
  // stream nobody cancels goes on running the model.
  React.useEffect(() => () => active.cancel(), [active]);

  // A load that is still in flight when the thread changes again must not
  // replace the messages of the newer one, so each load carries a generation
  // and a stale answer is dropped — the same guard `useAiModels` uses.
  const generation = React.useRef(0);
  React.useEffect(() => {
    const mine = (generation.current += 1);
    void active.cancel();
    setMessages([]);
    setThreadError(null);
    setAwaiting(0);
    if (threadId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async (): Promise<void> => {
      try {
        const connected = await client.current();
        const loaded = await connected.call('ai.threadsGet', { id: threadId });
        if (generation.current !== mine) return;
        setMessages(loaded.messages.map(fromStored));
      } catch (cause) {
        if (generation.current !== mine) return;
        // The messages are already empty: a conversation that is gone leaves a
        // blank panel and a sentence, not somebody else's transcript.
        setThreadError(asError(cause, 'That conversation could not be read.'));
      } finally {
        if (generation.current === mine) setLoading(false);
      }
    })();
  }, [threadId, active, setMessages]);

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
      setThreadError(null);
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
    // Emptying a stored conversation has to reach the store: otherwise the
    // next load brings back everything the person just cleared.
    void persist([]);
  }, [stop, setMessages, persist]);

  return {
    ...chat,
    // The SDK's own error comes first — it is about the turn the person is
    // watching. A thread error is reported through the same field rather than
    // a second one a panel would have to learn about.
    error: chat.error ?? threadError ?? undefined,
    sendMessage: send,
    confirm,
    confirmError,
    usage,
    awaiting,
    loading,
    clear,
  };
}
