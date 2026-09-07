/**
 * Broapp's `ai.chat` stream, as the AI SDK's `useChat` wants to see it.
 *
 * The host is unchanged and stays the only source of truth: a turn is one
 * `ai.chat` subscription, a confirmation is answered with `ai.chatConfirm`,
 * and the browser learns what happened only from the events that come back.
 * What this file adds is a translation — `ChatEvent` in, `UIMessageChunk`
 * out — so a panel can be built from standard parts.
 *
 * The AI SDK's own `addToolApprovalResponse` and `sendAutomaticallyWhen` are
 * deliberately unused: they mark a call answered in client state before the
 * host has decided, and their follow-up would start a second run.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import type { ChatEvent, ChatTurn } from 'broapp/ai';
// Types only. The forbidden direction is `broapp` importing the AI SDK, not a
// package beside it importing `broapp`'s own types.
import type { AiClient, ToolCallState } from 'broapp/ai/react';

/** Per-message metadata this transport writes. */
export interface BroappMessageMetadata {
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export type BroappUIMessage = UIMessage<BroappMessageMetadata>;

/** What the confirmation card needs, carried in `approvalDescriptor`. */
export interface BroappApprovalDescriptor {
  readonly tool: string;
  readonly expiresAt?: number;
}

/** How a {@link BroappChatTransport} is built. */
export interface BroappChatTransportOptions {
  /** How to reach the bridge. `useAiContext().client` fits. */
  client(): Promise<AiClient>;
  /** Records the user is looking at, read when a turn starts. */
  refs?(): readonly string[];
  /** A tool call settled — done or denied. Called from the event, never from state. */
  onToolResult?(call: ToolCallState): void;
  /** How many calls are waiting for a person, whenever that changes. */
  onAwaiting?(pending: number): void;
  /** For tests. Default: `crypto.randomUUID().replace(/-/g, '')`. */
  runId?(): string;
}

/** The transport, plus the two things a panel needs that `useChat` has no place for. */
export interface BroappChatTransport extends ChatTransport<BroappUIMessage> {
  /** Answer a `confirm`. Rejects with 'That request has expired.' when nobody is waiting. */
  confirm(callId: string, approve: boolean): Promise<void>;
  /** Cancel the running turn, if any. Text so far stays. */
  cancel(): void;
  /** True while a turn is running. */
  readonly active: boolean;
}

/** The contract caps history at 100 turns; the oldest are dropped. */
const MAX_HISTORY = 100;

/** A run id matching the contract's pattern. */
function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** The text of a message, as one string. */
function textOf(message: BroappUIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/** Whether the message carries anything the host cannot take yet. */
function hasFile(message: BroappUIMessage): boolean {
  return message.parts.some((part) => part.type === 'file');
}

/**
 * Every earlier message, as the model should see it.
 *
 * Only text travels. An image is named but not resent — the host takes one
 * turn's attachments with that turn, and a transcript of base64 would blow the
 * contract's 20,000-character bound apart. Tool, reasoning and data parts are
 * left out for the same reason `toHistory` in `use-ai-chat.ts` leaves them
 * out: the host rebuilds its own tool transcript from the run.
 */
function toHistory(messages: readonly BroappUIMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const lines: string[] = [];
    const text = textOf(message);
    if (text !== '') lines.push(text);
    if (message.role === 'user') {
      for (const part of message.parts) {
        if (part.type !== 'file') continue;
        lines.push(`[image: ${part.filename ?? part.mediaType}]`);
      }
    }
    const content = lines.join('\n');
    // An assistant message with nothing in it is a turn that never happened —
    // one that errored, or was cancelled before its first token.
    if (message.role === 'assistant' && content === '') continue;
    turns.push({ role: message.role, content });
  }
  return turns.slice(-MAX_HISTORY);
}

/** A stream carrying one chunk and nothing else. */
function only(chunk: UIMessageChunk): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** What the transport remembers about a call while the turn runs. */
interface Call {
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  /** Set once a `confirm` arrived, so the response chunk can name the same id. */
  approvalId?: string;
}

export function createBroappChatTransport(
  options: BroappChatTransportOptions,
): BroappChatTransport {
  const makeRunId = options.runId ?? newRunId;
  /** The subscription of the turn in progress, if any. */
  let running: { cancel(): void } | null = null;
  let runId = '';
  /** The calls of the turn in progress, by call id. */
  let calls = new Map<string, Call>();
  /** The calls waiting for a person, by call id. */
  let awaiting = new Set<string>();

  const transport: BroappChatTransport = {
    get active() {
      return running !== null;
    },

    sendMessages({ messages, abortSignal }) {
      // A second question while the first is still being answered would need a
      // second run and a second transcript. Refused, not queued.
      if (running !== null) {
        return Promise.resolve(
          only({ type: 'error', errorText: 'A reply is still being written.' }),
        );
      }

      const last = messages[messages.length - 1];
      if (last === undefined || last.role !== 'user') {
        return Promise.resolve(only({ type: 'error', errorText: 'Nothing to send.' }));
      }
      const message = textOf(last).trim();
      if (message === '') {
        return Promise.resolve(only({ type: 'error', errorText: 'Nothing to send.' }));
      }
      if (hasFile(last)) {
        // Refused rather than dropped: sending the words and silently losing
        // the picture answers a question nobody asked.
        return Promise.resolve(
          only({ type: 'error', errorText: 'This version cannot send attachments yet.' }),
        );
      }

      const history = toHistory(messages.slice(0, -1));
      const id = makeRunId();
      runId = id;
      calls = new Map();
      awaiting = new Set();
      const refs = [...(options.refs?.() ?? [])];
      // The turn owns `running` from here, before the subscription is open:
      // `client()` and `subscribe` both await, and a second send inside that
      // window would otherwise start a second run.
      const turn = { cancel: (): void => stop() };
      running = turn;

      let texts = 0;
      let openText: string | null = null;
      let sink: ReadableStreamDefaultController<UIMessageChunk> | null = null;
      let subscription: { cancel(): void } | null = null;
      let closed = false;

      /**
       * Called rather than read: TypeScript narrows `abortSignal.aborted` at
       * the first check and keeps that narrowing across an `await`, which is
       * exactly when the value changes.
       */
      const aborted = (): boolean => abortSignal?.aborted === true;
      const emit = (chunk: UIMessageChunk): void => {
        if (closed || sink === null) return;
        try {
          sink.enqueue(chunk);
        } catch {
          // The reader let go first. Nothing to say to a stream nobody reads.
          closed = true;
        }
      };
      const endText = (): void => {
        if (openText === null) return;
        emit({ type: 'text-end', id: openText });
        openText = null;
      };
      const settleAwaiting = (): void => {
        if (awaiting.size === 0) return;
        awaiting.clear();
        options.onAwaiting?.(0);
      };
      /** Close once. The producer can reach the end by several routes. */
      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (running === turn) running = null;
        try {
          sink?.close();
        } catch {
          // Already closed by the reader's own `cancel()`.
        }
        sink = null;
      };
      /**
       * Stop the host as well as the reader.
       *
       * Abandoning the iterator would not: the producer is a process on this
       * machine, and a stream nobody cancels goes on running the model. A
       * cancelled turn ends without `finish` and without `error`, so the SDK
       * keeps the text so far and returns to `ready`.
       */
      const stop = (): void => {
        subscription?.cancel();
        subscription = null;
        settleAwaiting();
        finish();
      };

      const apply = (event: ChatEvent): void => {
        if (closed) return;
        switch (event.type) {
          case 'text': {
            if (openText === null) {
              openText = `${id}-t${String(texts)}`;
              texts += 1;
              emit({ type: 'text-start', id: openText });
            }
            emit({ type: 'text-delta', id: openText, delta: event.text ?? '' });
            break;
          }
          case 'tool-call': {
            // A tool call interrupts whatever the model was saying, and the
            // SDK's parts are ordered: close the text part first, or the card
            // lands inside the sentence.
            endText();
            const callId = event.callId ?? '';
            const tool = event.tool ?? '';
            calls.set(callId, { callId, tool, input: event.input });
            emit({ type: 'tool-input-start', toolCallId: callId, toolName: tool });
            emit({
              type: 'tool-input-available',
              toolCallId: callId,
              toolName: tool,
              input: event.input,
            });
            break;
          }
          case 'confirm': {
            const callId = event.callId ?? '';
            const started = calls.get(callId);
            const tool = event.tool ?? started?.tool ?? '';
            // The request id names what the gate is waiting on; falling back to
            // the call id keeps request and response agreeing, which is how the
            // SDK finds the part again.
            const approvalId = event.requestId ?? callId;
            calls.set(callId, {
              callId,
              tool,
              input: started?.input ?? event.input,
              approvalId,
            });
            awaiting.add(callId);
            const descriptor: BroappApprovalDescriptor = {
              tool,
              ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
            };
            emit({
              type: 'tool-approval-request',
              approvalId,
              toolCallId: callId,
              reason: `Allow ${tool}?`,
              approvalDescriptor: descriptor,
            });
            options.onAwaiting?.(awaiting.size);
            break;
          }
          case 'tool-result': {
            const callId = event.callId ?? '';
            const started = calls.get(callId);
            const denied = event.denied === true;
            if (awaiting.has(callId)) {
              emit({
                type: 'tool-approval-response',
                approvalId: started?.approvalId ?? callId,
                approved: !denied,
              });
              awaiting.delete(callId);
              options.onAwaiting?.(awaiting.size);
            }
            emit(
              denied
                ? { type: 'tool-output-denied', toolCallId: callId }
                : { type: 'tool-output-available', toolCallId: callId, output: event.output },
            );
            const settled: ToolCallState = {
              callId,
              tool: event.tool ?? started?.tool ?? '',
              input: started?.input,
              status: denied ? 'denied' : 'done',
              output: event.output,
            };
            calls.set(callId, {
              callId,
              tool: settled.tool,
              input: settled.input,
              ...(started?.approvalId === undefined ? {} : { approvalId: started.approvalId }),
            });
            // From the event, never from a React state updater: React runs
            // those when it chooses, and the application needs this now.
            options.onToolResult?.(settled);
            break;
          }
          case 'usage': {
            emit({
              type: 'message-metadata',
              messageMetadata: {
                usage: {
                  inputTokens: event.inputTokens ?? 0,
                  outputTokens: event.outputTokens ?? 0,
                },
              },
            });
            break;
          }
          case 'done': {
            endText();
            emit({ type: 'finish' });
            settleAwaiting();
            finish();
            break;
          }
          case 'error': {
            endText();
            emit({
              type: 'error',
              errorText: event.message ?? 'The AI provider returned an error.',
            });
            settleAwaiting();
            finish();
            break;
          }
        }
      };

      const stream = new ReadableStream<UIMessageChunk>({
        async start(controller) {
          sink = controller;
          if (aborted()) {
            finish();
            return;
          }
          abortSignal?.addEventListener('abort', stop, { once: true });
          emit({ type: 'start', messageId: `${id}-assistant` });

          try {
            const client = await options.client();
            if (closed) return;
            const opened = await client.subscribe(
              'ai.chat',
              { runId: id, message, refs, history },
              {
                onEvent: apply,
                onDone: () => {
                  // A stream that ends without saying `done` still ended.
                  if (closed) return;
                  endText();
                  emit({ type: 'finish' });
                  settleAwaiting();
                  finish();
                },
                onError: (cause) => {
                  if (closed) return;
                  endText();
                  emit({ type: 'error', errorText: cause.message });
                  settleAwaiting();
                  finish();
                },
              },
            );
            if (closed) {
              opened.cancel();
              return;
            }
            subscription = opened;
            if (aborted()) stop();
          } catch (cause) {
            endText();
            emit({
              type: 'error',
              errorText:
                cause instanceof Error ? cause.message : 'The conversation could not be started.',
            });
            settleAwaiting();
            finish();
          }
        },
        cancel() {
          stop();
        },
      });

      return Promise.resolve(stream);
    },

    /** Nothing to resume: a turn belongs to the tab that started it. */
    reconnectToStream() {
      return Promise.resolve(null);
    },

    async confirm(callId: string, approve: boolean): Promise<void> {
      if (running === null || !awaiting.has(callId)) {
        throw new Error('That request has expired.');
      }
      const client = await options.client();
      const result = await client.call('ai.chatConfirm', { runId, callId, approve });
      // Nobody was waiting: the turn timed out or was cancelled while the
      // question was on screen.
      if (!result.accepted) throw new Error('That request has expired.');
    },

    cancel(): void {
      // Closing the stream matters as much as cancelling the host: a reader
      // waiting on a stream that never ends leaves `useChat` streaming for
      // ever. The text so far stays; the user asked to stop, not to undo.
      running?.cancel();
      running = null;
    },
  };

  return transport;
}
