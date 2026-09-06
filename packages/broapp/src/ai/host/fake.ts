/**
 * An adapter that answers without a provider.
 *
 * It exists for Broapp's own tests and for the tests of applications built on
 * Broapp: the AI layer is a lot of behaviour that has nothing to do with any
 * particular vendor, and none of it should need a key or a network to test.
 *
 * The model it returns is the AI SDK's own `MockLanguageModelV4` from
 * `ai/test`, so `streamText` runs its real loop over it.
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
 * so the shapes are read off the class that has to accept them. That also
 * means a change in the AI SDK shows up here as a type error rather than as a
 * silently wrong chunk.
 */
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

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
  /** Scripted replies for chat. Used from prompt 04 on. */
  readonly script?: unknown;
}

function defaultModel(providerId: string): BroappModel {
  return {
    provider: providerId,
    modelId: 'fake-1',
    label: 'Fake 1',
    capabilities: { tools: true, vision: false, structuredOutput: true },
  };
}

/** The single text a fake model replies with until prompt 04 scripts it. */
const FAKE_REPLY = 'fake reply';

/** Build an adapter that needs no provider. */
export function createFakeAdapter(options: FakeAdapterOptions = {}): ProviderAdapter {
  const id = options.id ?? 'fake';
  const models = options.models ?? [defaultModel(id)];

  return {
    id,
    label: 'Fake provider',
    needs: { apiKey: options.needsKey === true, baseUrl: 'none' },
    defaultBaseUrl: null,
    // Nothing leaves the process, so this is true whatever the configuration.
    local: () => true,

    models: (_config: AdapterConfig, _signal: AbortSignal) => Promise.resolve([...models]),

    test: (_config: AdapterConfig, _signal: AbortSignal) =>
      options.failTestWith === undefined
        ? Promise.resolve()
        : Promise.reject(options.failTestWith),

    model(_config: AdapterConfig, modelId: string): LanguageModel {
      return new MockLanguageModelV4({
        provider: id,
        modelId,
        doStream: (): Promise<StreamResult> =>
          Promise.resolve({
            stream: simulateReadableStream<StreamPart>({
              // No delays: a test that waits for a fake to type is a slow test.
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: FAKE_REPLY },
                { type: 'text-end', id: '0' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 2, text: 2, reasoning: 0 },
                  },
                },
              ],
            }),
          }),
      });
    },
  };
}
