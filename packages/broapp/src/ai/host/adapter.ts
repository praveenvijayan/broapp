/**
 * What a provider package has to implement.
 *
 * An adapter is the only place in the AI layer that knows a provider exists.
 * It answers four questions — what do you need, what models do you have, does
 * this configuration work, and give me a model — and Broapp's host code is
 * written entirely against those four.
 *
 * Every adapter takes its `fetch` from {@link AdapterConfig} rather than
 * reaching for the global one. That is what makes a test able to prove no
 * request left the machine, and what makes the AI SDK's gateway trap
 * (see `reports/01-spike.md`) impossible to fall into by accident.
 */
import type { LanguageModel } from 'ai';

import { PublicError, publicError } from '../../shared/errors.ts';
import type { BroappModel } from '../shared/types.ts';

/** Everything an adapter needs to reach its provider. */
export interface AdapterConfig {
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  /** Injected so tests never touch the network. Defaults to `globalThis.fetch`. */
  readonly fetch: typeof fetch;
}

/** Why an adapter call failed, in terms the layer above can act on. */
export type AdapterErrorCode = 'auth' | 'network' | 'not_found' | 'rate_limited' | 'provider';

/**
 * A failure an adapter reports deliberately.
 *
 * `message` is shown to the user, so it must name the problem in plain words
 * and never include a key, a URL with credentials, or a raw provider response
 * body. Anything an adapter cannot describe safely should be thrown as an
 * ordinary error instead, and the host's error boundary will reduce it.
 */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AdapterError';
    this.code = code;
  }
}

/** One provider, as Broapp's host uses it. */
export interface ProviderAdapter {
  /** Stable id, stored in settings: `'anthropic'`, `'ollama'`, `'fake'`. */
  readonly id: string;
  readonly label: string;
  readonly needs: {
    readonly apiKey: 'required' | 'optional' | 'none';
    readonly baseUrl: 'required' | 'optional' | 'none';
  };
  readonly defaultBaseUrl: string | null;
  /** Whether requests stay on this machine under this config. */
  local(config: AdapterConfig): boolean;
  /** List models. Must reject with {@link AdapterError} on failure. */
  models(config: AdapterConfig, signal: AbortSignal): Promise<BroappModel[]>;
  /** Cheapest possible proof the config works. Must reject with {@link AdapterError}. */
  test(config: AdapterConfig, signal: AbortSignal): Promise<void>;
  /** The AI SDK model. Only `broapp/ai/host` calls this. */
  model(config: AdapterConfig, modelId: string): LanguageModel;
}

/** Hosts that mean "this machine". */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * True when a URL points at this machine.
 *
 * Used to tell the user whether their prompts leave the computer. An address
 * that cannot be parsed is not loopback: an unknown destination is exactly the
 * case where the honest answer is "no".
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // `URL.hostname` strips the brackets from an IPv6 literal, so both spellings
    // are in the set above.
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Translate an adapter failure into something the browser may see.
 *
 * Anything that is not an `AdapterError` is rethrown unchanged, so the host's
 * existing boundary logs it with its stack and the browser gets the fixed
 * internal sentence. An adapter that wants a message shown has to say so by
 * choosing an `AdapterError` code.
 */
export function toPublicError(cause: unknown): PublicError {
  if (!(cause instanceof AdapterError)) throw cause;
  switch (cause.code) {
    case 'auth':
      return publicError.rejected(cause.message);
    case 'not_found':
      return publicError.notFound(cause.message);
    case 'network':
    case 'rate_limited':
    case 'provider':
      return publicError.unavailable(cause.message);
  }
}
