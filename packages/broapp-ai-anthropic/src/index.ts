/**
 * Anthropic, behind Broapp's `ProviderAdapter`.
 *
 * The package is thin on purpose. It knows three things Broapp does not: which
 * headers Anthropic wants, what its model list looks like, and how to turn a
 * status code into a sentence a user can act on. Everything else — settings,
 * secrets, the run loop — belongs to `broapp/ai/host`.
 *
 * Every request goes through `config.fetch`. Nothing here reaches for the
 * global one, which is what lets a test prove no request left the machine and
 * what keeps the AI SDK's gateway out of the picture entirely.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

import type { BroappModel } from 'broapp/ai';
import { AdapterError, isLoopbackUrl } from 'broapp/ai/host';
import type { AdapterConfig, ProviderAdapter } from 'broapp/ai/host';

/** Where Anthropic lives unless the user says otherwise. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** The API version header Anthropic requires on every request. */
const API_VERSION = '2023-06-01';

/** How many pages of models to follow before giving up. */
const MAX_PAGES = 5;

/** One entry of Anthropic's model list, as much of it as matters here. */
interface ModelEntry {
  readonly id?: unknown;
  readonly display_name?: unknown;
  readonly created_at?: unknown;
}

interface ModelPage {
  readonly data?: unknown;
  readonly has_more?: unknown;
  readonly last_id?: unknown;
}

/**
 * A status code, as a failure the user can do something about.
 *
 * The body is never put in the message: it is a provider's prose, it can echo
 * the prompt back, and on an auth failure it can contain a fragment of the
 * key. It is attached as `cause` so the host log still has it.
 */
function toAdapterError(status: number, bodyText: string): AdapterError {
  const cause = { status, body: bodyText };
  if (status === 401 || status === 403) {
    return new AdapterError('auth', 'Anthropic rejected the API key.', { cause });
  }
  if (status === 404) return new AdapterError('not_found', 'That model was not found.', { cause });
  if (status === 429) {
    return new AdapterError(
      'rate_limited',
      'Anthropic is rate limiting requests. Try again shortly.',
      { cause },
    );
  }
  if (status >= 500) {
    return new AdapterError('provider', 'Anthropic returned a server error.', { cause });
  }
  return new AdapterError(
    'provider',
    `Anthropic returned an unexpected response (${String(status)}).`,
    { cause },
  );
}

/** Anything `fetch` itself throws is a connection problem, not a provider one. */
function toNetworkError(cause: unknown): AdapterError {
  return new AdapterError(
    'network',
    'Could not reach Anthropic. Check your connection and the server URL.',
    { cause },
  );
}

function baseUrlOf(config: AdapterConfig): string {
  const url = config.baseUrl ?? DEFAULT_BASE_URL;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Rank a model id by family.
 *
 * The list Anthropic returns is not in an order anybody would choose from, and
 * the first entry is what a settings dialog will select. Capable first.
 */
function familyRank(id: string): number {
  const lower = id.toLowerCase();
  if (lower.includes('opus')) return 0;
  if (lower.includes('sonnet')) return 1;
  if (lower.includes('haiku')) return 2;
  return 3;
}

function createdAt(entry: ModelEntry): number {
  const raw = typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : Number.NaN;
  return Number.isNaN(raw) ? 0 : raw;
}

async function readPage(
  config: AdapterConfig,
  signal: AbortSignal,
  afterId: string | null,
): Promise<{ entries: ModelEntry[]; hasMore: boolean; lastId: string | null }> {
  const url = new URL(`${baseUrlOf(config)}/v1/models`);
  url.searchParams.set('limit', '100');
  if (afterId !== null) url.searchParams.set('after_id', afterId);

  let response: Response;
  try {
    response = await config.fetch(url.href, {
      method: 'GET',
      headers: {
        'x-api-key': config.apiKey ?? '',
        'anthropic-version': API_VERSION,
      },
      signal,
    });
  } catch (cause) {
    throw toNetworkError(cause);
  }
  if (!response.ok) throw toAdapterError(response.status, await response.text().catch(() => ''));

  const page = (await response.json().catch(() => ({}))) as ModelPage;
  const entries = Array.isArray(page.data) ? (page.data as ModelEntry[]) : [];
  const lastId = typeof page.last_id === 'string' ? page.last_id : null;
  return { entries, hasMore: page.has_more === true && lastId !== null, lastId };
}

/** The Anthropic adapter. */
export function anthropic(): ProviderAdapter {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    needs: { apiKey: 'required', baseUrl: 'optional' },
    defaultBaseUrl: DEFAULT_BASE_URL,

    // False for the real service, and true for a proxy on this machine — which
    // is a real arrangement, and the user is entitled to be told.
    local: (config) => isLoopbackUrl(config.baseUrl ?? DEFAULT_BASE_URL),

    async models(config, signal) {
      const entries: ModelEntry[] = [];
      let afterId: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await readPage(config, signal, afterId);
        entries.push(...result.entries);
        if (!result.hasMore) break;
        afterId = result.lastId;
      }

      return entries
        .filter((entry): entry is ModelEntry & { id: string } => typeof entry.id === 'string')
        .sort((left, right) => {
          const byFamily = familyRank(left.id) - familyRank(right.id);
          return byFamily !== 0 ? byFamily : createdAt(right) - createdAt(left);
        })
        .map(
          (entry): BroappModel => ({
            provider: 'anthropic',
            modelId: entry.id,
            label: typeof entry.display_name === 'string' ? entry.display_name : entry.id,
            capabilities: { tools: true, vision: true, structuredOutput: true },
          }),
        );
    },

    // Listing models costs no tokens and still proves the key, which makes it
    // the cheapest honest test there is.
    async test(config, signal) {
      await this.models(config, signal);
    },

    model(config, modelId): LanguageModel {
      if (config.apiKey === null || config.apiKey === '') {
        throw new AdapterError('auth', 'An API key is required for Anthropic.');
      }
      const provider = createAnthropic({
        apiKey: config.apiKey,
        baseURL: baseUrlOf(config),
        fetch: config.fetch,
      });
      return provider(modelId);
    },
  };
}
