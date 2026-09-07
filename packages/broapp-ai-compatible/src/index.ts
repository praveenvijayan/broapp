/**
 * Anything that speaks the OpenAI chat API, behind Broapp's `ProviderAdapter`.
 *
 * One adapter covers OpenAI itself, Ollama, LM Studio, llama.cpp's server,
 * vLLM and OpenRouter, because they all answer `GET /models` with the same
 * envelope and accept the same chat request. What differs between them is a
 * base URL and whether a key is needed, so those are the options.
 *
 * Every request goes through `config.fetch`. Nothing here reaches for the
 * global one.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import type { BroappModel } from 'broapp/ai';
import { AdapterError, isLoopbackUrl } from 'broapp/ai/host';
import type { AdapterConfig, ProviderAdapter } from 'broapp/ai/host';

/** How to describe one OpenAI-compatible server. */
export interface CompatibleOptions {
  readonly id: string;
  readonly label: string;
  readonly needs: { apiKey: 'required' | 'optional' | 'none'; baseUrl: 'required' | 'optional' };
  readonly defaultBaseUrl: string | null;
  /** Sent as the OpenAI-compatible provider `name`. Default: `id`. */
  readonly name?: string;
  /**
   * How to learn whether a model can see. `'ollama'` asks the server's own
   * `/api/show`; `'by-id'` matches known model ids; `'assume'` reports true
   * and lets the provider answer if it cannot. Default `'assume'`.
   */
  readonly vision?: 'ollama' | 'by-id' | 'assume';
}

interface ModelEntry {
  readonly id?: unknown;
}

function baseUrlOf(options: CompatibleOptions, config: AdapterConfig): string {
  const url = config.baseUrl ?? options.defaultBaseUrl ?? '';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * OpenAI model ids that can read an image, by prefix.
 *
 * This will age. OpenAI names models faster than this file changes, so a new
 * one that can see reads as blind here until someone edits the line — which is
 * the direction that fails loudly rather than at the worst moment.
 */
const OPENAI_VISION_IDS = /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4|chatgpt-4o)/;

/**
 * The server's own API root, from its OpenAI-compatible base URL.
 *
 * Ollama serves the OpenAI surface under `/v1` and its native one under the
 * root, so dropping a single trailing `/v1` is the whole conversion.
 */
function nativeRootOf(baseUrl: string): string {
  return baseUrl.endsWith('/v1') ? baseUrl.slice(0, -'/v1'.length) : baseUrl;
}

/**
 * What Ollama's `/api/show` says one model can do, or `null` when it will not
 * say.
 *
 * Every failure — unreachable, non-2xx, a body that is not the expected shape
 * — is `null` and is not surfaced. This is a side channel: the model list must
 * not fail because it did.
 */
async function ollamaCapabilities(
  root: string,
  modelId: string,
  headers: Record<string, string>,
  config: AdapterConfig,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  try {
    const response = await config.fetch(`${root}/api/show`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { capabilities?: unknown };
    if (!Array.isArray(body.capabilities)) return null;
    return body.capabilities.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return null;
  }
}

/**
 * A status code, as a failure the user can do something about.
 *
 * The body never reaches the message. A self-hosted server's error page can be
 * anything at all, including a stack trace with a path on it.
 */
function toAdapterError(label: string, status: number, bodyText: string): AdapterError {
  const cause = { status, body: bodyText };
  if (status === 401 || status === 403) {
    return new AdapterError('auth', `${label} rejected the API key.`, { cause });
  }
  if (status === 404) return new AdapterError('not_found', 'That model was not found.', { cause });
  if (status === 429) {
    return new AdapterError('rate_limited', `${label} is rate limiting requests. Try again shortly.`, {
      cause,
    });
  }
  if (status >= 500) {
    return new AdapterError('provider', `${label} returned a server error.`, { cause });
  }
  return new AdapterError(
    'provider',
    `${label} returned an unexpected response (${String(status)}).`,
    { cause },
  );
}

/** Build an adapter for one OpenAI-compatible server. */
export function openaiCompatible(options: CompatibleOptions): ProviderAdapter {
  const label = options.label;

  return {
    id: options.id,
    label,
    needs: { apiKey: options.needs.apiKey, baseUrl: options.needs.baseUrl },
    defaultBaseUrl: options.defaultBaseUrl,

    local: (config) => isLoopbackUrl(baseUrlOf(options, config)),

    async models(config, signal) {
      const headers: Record<string, string> = {};
      // Sent only when there is one: a local server with no auth can refuse a
      // request that carries an empty bearer token.
      if (config.apiKey !== null && config.apiKey !== '') {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      let response: Response;
      try {
        response = await config.fetch(`${baseUrlOf(options, config)}/models`, {
          method: 'GET',
          headers,
          signal,
        });
      } catch (cause) {
        throw new AdapterError(
          'network',
          `Could not reach ${label}. Check your connection and the server URL.`,
          { cause },
        );
      }
      if (!response.ok) {
        throw toAdapterError(label, response.status, await response.text().catch(() => ''));
      }

      const body = (await response.json().catch(() => ({}))) as { data?: unknown };
      const entries = Array.isArray(body.data) ? (body.data as ModelEntry[]) : [];
      const vision = options.vision ?? 'assume';
      const listed = entries
        .filter((entry): entry is ModelEntry & { id: string } => typeof entry.id === 'string')
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(
          (entry): BroappModel => ({
            provider: options.id,
            modelId: entry.id,
            label: entry.id,
            // This endpoint says nothing about capabilities, so `vision` is
            // whatever `options.vision` can work out. Where it cannot work
            // anything out the answer is `true`, and deliberately: a false
            // refusal blocks a setup that works, while a false allowance costs
            // one request and returns the provider's own error, which is more
            // precise than a guess made here.
            capabilities: {
              tools: true,
              vision: vision === 'by-id' ? OPENAI_VISION_IDS.test(entry.id) : true,
              structuredOutput: false,
            },
          }),
        );
      if (vision !== 'ollama') return listed;

      // Ollama's own API knows, so ask it once per model, in parallel, and let
      // a model whose answer did not arrive keep the assumed `true`.
      const root = nativeRootOf(baseUrlOf(options, config));
      const answers = await Promise.all(
        listed.map((model) => ollamaCapabilities(root, model.modelId, headers, config, signal)),
      );
      return listed.map((model, index) => {
        const capabilities = answers[index] ?? null;
        if (capabilities === null) return model;
        return {
          ...model,
          capabilities: {
            ...model.capabilities,
            // The same answer carries both; `structuredOutput` it does not
            // mention, so that one is left alone.
            tools: capabilities.includes('tools'),
            vision: capabilities.includes('vision'),
          },
        };
      });
    },

    async test(config, signal) {
      await this.models(config, signal);
    },

    model(config, modelId): LanguageModel {
      const baseURL = baseUrlOf(options, config);
      if (options.needs.baseUrl === 'required' && baseURL === '') {
        throw new AdapterError('provider', 'A server URL is required.');
      }
      if (options.needs.apiKey === 'required' && (config.apiKey === null || config.apiKey === '')) {
        throw new AdapterError('auth', `An API key is required for ${label}.`);
      }
      const provider = createOpenAICompatible({
        name: options.name ?? options.id,
        baseURL,
        ...(config.apiKey === null || config.apiKey === '' ? {} : { apiKey: config.apiKey }),
        fetch: config.fetch,
        // Without this the server omits token counts from a streamed response,
        // and the interface can only report zero. Every server that implements
        // the API accepts the option; one that ignores it is no worse off.
        includeUsage: true,
      });
      return provider.chatModel(modelId);
    },
  };
}

/** Ollama, on this machine. Needs no key. */
export const ollama = (): ProviderAdapter =>
  openaiCompatible({
    id: 'ollama',
    label: 'Ollama (local)',
    needs: { apiKey: 'none', baseUrl: 'optional' },
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    vision: 'ollama',
  });

/** OpenAI itself. */
export const openai = (): ProviderAdapter =>
  openaiCompatible({
    id: 'openai',
    label: 'OpenAI',
    needs: { apiKey: 'required', baseUrl: 'optional' },
    defaultBaseUrl: 'https://api.openai.com/v1',
    vision: 'by-id',
  });

/**
 * Any other server speaking the same API. The user supplies the address.
 *
 * The key is optional rather than absent: a llama.cpp server on this machine
 * wants none, while a hosted gateway such as OpenRouter answers `GET /models`
 * without one and then rejects every chat request. Offering the field lets
 * both work.
 *
 * Vision is assumed: nothing here can know what an unnamed server runs, and
 * refusing an image turn on that ignorance would block a setup that works.
 */
export const customServer = (): ProviderAdapter =>
  openaiCompatible({
    id: 'openai-compatible',
    label: 'OpenAI-compatible server',
    needs: { apiKey: 'optional', baseUrl: 'required' },
    defaultBaseUrl: null,
  });
