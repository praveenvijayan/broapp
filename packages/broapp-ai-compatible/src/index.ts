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
  readonly needs: { apiKey: boolean; baseUrl: 'required' | 'optional' };
  readonly defaultBaseUrl: string | null;
  /** Sent as the OpenAI-compatible provider `name`. Default: `id`. */
  readonly name?: string;
}

interface ModelEntry {
  readonly id?: unknown;
}

function baseUrlOf(options: CompatibleOptions, config: AdapterConfig): string {
  const url = config.baseUrl ?? options.defaultBaseUrl ?? '';
  return url.endsWith('/') ? url.slice(0, -1) : url;
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
      return entries
        .filter((entry): entry is ModelEntry & { id: string } => typeof entry.id === 'string')
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(
          (entry): BroappModel => ({
            provider: options.id,
            modelId: entry.id,
            label: entry.id,
            // Conservative: the endpoint says nothing about what the model can
            // do, and claiming a capability it lacks fails at the worst moment.
            capabilities: { tools: true, vision: false, structuredOutput: false },
          }),
        );
    },

    async test(config, signal) {
      await this.models(config, signal);
    },

    model(config, modelId): LanguageModel {
      const baseURL = baseUrlOf(options, config);
      if (options.needs.baseUrl === 'required' && baseURL === '') {
        throw new AdapterError('provider', 'A server URL is required.');
      }
      if (options.needs.apiKey && (config.apiKey === null || config.apiKey === '')) {
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
    needs: { apiKey: false, baseUrl: 'optional' },
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
  });

/** OpenAI itself. */
export const openai = (): ProviderAdapter =>
  openaiCompatible({
    id: 'openai',
    label: 'OpenAI',
    needs: { apiKey: true, baseUrl: 'optional' },
    defaultBaseUrl: 'https://api.openai.com/v1',
  });

/** Any other server speaking the same API. The user supplies the address. */
export const customServer = (): ProviderAdapter =>
  openaiCompatible({
    id: 'openai-compatible',
    label: 'OpenAI-compatible server',
    needs: { apiKey: false, baseUrl: 'required' },
    defaultBaseUrl: null,
  });
