/**
 * An adapter that answers without a provider.
 *
 * It exists for Broapp's own tests and for the tests of applications built on
 * Broapp: the AI layer is a lot of behaviour that has nothing to do with any
 * particular vendor, and none of it should need a key or a network to test.
 *
 * The model it returns is the AI SDK's own `MockLanguageModelV4` from
 * `ai/test`, so `streamText` runs its real loop — tool calls, steps, finish
 * reasons and all — over a scripted set of chunks.
 */
import { simulateReadableStream } from 'ai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import type { BroappModel } from '../shared/types.ts';

import { AdapterError, type AdapterConfig, type ProviderAdapter } from './adapter.ts';

/**
 * The provider-level stream types, taken from the mock rather than imported.
 *
 * `@ai-sdk/provider` is not a dependency of `broapp` — it arrives under `ai` —
 * so the shapes are read off the class that has to accept them. A change in
 * the AI SDK then shows up here as a type error rather than a wrong chunk.
 */
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type CallOptions = Parameters<MockLanguageModelV4['doStream']>[0];

/** One scripted model step. */
export type FakeStep =
  | { readonly kind: 'text'; readonly chunks: readonly string[] }
  /** `then` runs after the tool result comes back. */
  | { readonly kind: 'tool'; readonly name: string; readonly input: unknown; readonly then: readonly FakeStep[] };

/** How to shape a fake adapter for one test. */
export interface FakeAdapterOptions {
  /** Default `'fake'`. */
  readonly id?: string;
  /** Default: one model, `fake-1`. */
  readonly models?: readonly BroappModel[];
  /** Default `false`. */
  readonly needsKey?: boolean;
  /** When set, `test()` rejects with it. */
  readonly failTestWith?: AdapterError;
  /** What the model says, step by step. Default: one text step. */
  readonly script?: readonly FakeStep[];
  /** Delay between chunks, so a cancel test can catch a stream mid-flight. */
  readonly chunkDelayMs?: number;
}

/** A fake adapter, plus what the test wants to know about it afterwards. */
export interface FakeAdapter extends ProviderAdapter {
  /** Every prompt the model was given, in order. */
  readonly calls: readonly unknown[];
  /** How many times `model()` was called. Proves no string model id was used. */
  readonly modelCalls: number;
  /** How many times a call was abandoned because its signal aborted. */
  readonly aborted: number;
}

function defaultModel(providerId: string): BroappModel {
  return {
    provider: providerId,
    modelId: 'fake-1',
    label: 'Fake 1',
    capabilities: { tools: true, vision: false, structuredOutput: true },
  };
}

/** The usage every fake step reports. Small and constant, so tests can assert it. */
const USAGE = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
} as const;

/**
 * Flatten a script into the sequence of steps `streamText` will ask for.
 *
 * `doStream` is called once per step of the agent loop, so a `tool` step's
 * `then` steps are simply the ones that follow it. Nesting is how a test
 * writes "and after the tool comes back, say this".
 */
function flatten(script: readonly FakeStep[]): FakeStep[] {
  const out: FakeStep[] = [];
  for (const step of script) {
    out.push(step);
    if (step.kind === 'tool') out.push(...flatten(step.then));
  }
  return out;
}

/** The chunks for one step. */
function chunksFor(step: FakeStep, callIndex: number): StreamPart[] {
  if (step.kind === 'text') {
    const parts: StreamPart[] = [{ type: 'text-start', id: String(callIndex) }];
    for (const chunk of step.chunks) {
      parts.push({ type: 'text-delta', id: String(callIndex), delta: chunk });
    }
    parts.push({ type: 'text-end', id: String(callIndex) });
    parts.push({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: USAGE,
    });
    return parts;
  }
  // A tool call arrives whole: this mock has no reason to dribble the input
  // out in deltas, and the loop under test does not care if it did.
  const toolCallId = `call-${String(callIndex)}`;
  return [
    {
      type: 'tool-call',
      toolCallId,
      toolName: step.name,
      input: JSON.stringify(step.input),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: USAGE,
    },
  ];
}

/** Build an adapter that needs no provider. */
export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const id = options.id ?? 'fake';
  const models = options.models ?? [defaultModel(id)];
  const script = options.script ?? [{ kind: 'text', chunks: ['fake reply'] } as const];
  const steps = flatten(script);
  const delay = options.chunkDelayMs ?? 0;

  const calls: unknown[] = [];
  let callIndex = 0;
  let modelCalls = 0;
  let aborted = 0;

  const adapter: FakeAdapter = {
    id,
    label: 'Fake provider',
    needs: { apiKey: options.needsKey === true ? 'required' : 'none', baseUrl: 'none' },
    defaultBaseUrl: null,
    // Nothing leaves the process, so this is true whatever the configuration.
    local: () => true,

    models: (_config: AdapterConfig, _signal: AbortSignal) => Promise.resolve([...models]),

    test: (_config: AdapterConfig, _signal: AbortSignal) =>
      options.failTestWith === undefined ? Promise.resolve() : Promise.reject(options.failTestWith),

    get calls() {
      return calls;
    },
    get modelCalls() {
      return modelCalls;
    },
    get aborted() {
      return aborted;
    },

    model(_config: AdapterConfig, modelId: string): LanguageModel {
      modelCalls += 1;
      return new MockLanguageModelV4({
        provider: id,
        modelId,
        doStream: (callOptions: CallOptions): Promise<StreamResult> => {
          calls.push(callOptions.prompt);
          if (callOptions.abortSignal?.aborted === true) {
            aborted += 1;
            // The name is what `streamText` checks for, so a cancelled turn
            // looks like a cancelled turn rather than a provider failure.
            const error = new Error('aborted');
            error.name = 'AbortError';
            return Promise.reject(error);
          }
          const step = steps[callIndex] ?? { kind: 'text' as const, chunks: [''] };
          const parts = chunksFor(step, callIndex);
          callIndex += 1;
          const stream = simulateReadableStream<StreamPart>({
            initialDelayInMs: delay === 0 ? 0 : delay,
            chunkDelayInMs: delay,
            chunks: parts,
          });
          // The signal has to reach the stream too: a cancel that arrives
          // while chunks are still being delivered must stop them, not wait
          // for the script to run out.
          return Promise.resolve({ stream: withAbort(stream, callOptions.abortSignal, () => {
            aborted += 1;
          }) });
        },
      });
    },
  };
  return adapter;
}

/** Wrap a stream so an aborted signal ends it instead of letting it run on. */
function withAbort<T>(
  stream: ReadableStream<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): ReadableStream<T> {
  if (signal === undefined) return stream;
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      if (signal.aborted) {
        onAbort();
        await reader.cancel().catch(() => undefined);
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
