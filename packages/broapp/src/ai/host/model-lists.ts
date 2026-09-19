/**
 * What the host remembers of each provider's model list, and how long it waits
 * for a new one.
 *
 * A model list changes a few times a year, and three panels mount at once and
 * each ask for it. One provider that accepts a connection and then says
 * nothing — a local server loading a large model, a gateway having a bad
 * minute — used to hold every picker for the full connection-test deadline.
 * So a list has a deadline of its own, a list read recently is its own answer,
 * and a provider that does not answer in time gives the list it gave last,
 * marked as such.
 *
 * Kept in memory only, per provider, for the life of the process: a list from
 * last week is not worth a file, and the settings directory holds only what the
 * person typed. Never the key — only whether there was one, because a list read
 * with a key and a list read without one may not be the same list.
 */
import { publicError, type PublicError } from '../../shared/errors.ts';
import type { BroappModel } from '../shared/types.ts';

import { AdapterError, toPublicError, type AdapterConfig, type ProviderAdapter } from './adapter.ts';

/** The sentence a stale list's line ends with, after why it is stale. */
const LISTED_EARLIER = 'These are the models it listed earlier.';

/** What a list was read under: the address, and whether there was a key. */
interface ReadUnder {
  readonly baseUrl: string | null;
  readonly hasKey: boolean;
}

/** One provider's last list. */
interface Kept extends ReadUnder {
  readonly models: BroappModel[];
  readonly listedAt: number;
}

/** A request for one provider's list that has not settled yet. */
interface InFlight extends ReadUnder {
  readonly generation: number;
  readonly request: Promise<BroappModel[]>;
}

/** What asking one provider came to. */
export type ListOutcome =
  | { readonly kind: 'listed'; readonly models: BroappModel[] }
  | { readonly kind: 'stale'; readonly models: BroappModel[]; readonly listedAt: number; readonly message: string }
  | { readonly kind: 'failed'; readonly failure: PublicError };

export interface ModelListsOptions {
  /** How long a listing waits for a provider before it gives what it kept. */
  readonly deadlineMs: number;
  /** How young a kept list must be to be the answer without asking. */
  readonly freshMs: number;
  /**
   * How long the request itself may run. Longer than the deadline on purpose:
   * an answer that arrives after it is kept, so the next listing is right.
   */
  readonly requestTimeoutMs: number;
  readonly now: () => number;
}

export interface ModelLists {
  /**
   * One enabled provider's list, under `config`. With `fresh`, a list kept
   * from the last `freshMs` under the same address and key presence is the
   * answer and nothing is sent; without it, the provider is always asked.
   */
  list(adapter: ProviderAdapter, config: AdapterConfig, options: { readonly fresh: boolean }): Promise<ListOutcome>;
  /** Forget a provider's list, and ignore any answer already on its way. */
  drop(providerId: string): void;
}

function hasValue(value: string | null): boolean {
  return value !== null && value !== '';
}

function sameReach(left: ReadUnder, right: ReadUnder): boolean {
  return left.baseUrl === right.baseUrl && left.hasKey === right.hasKey;
}

export function createModelLists(options: ModelListsOptions): ModelLists {
  const kept = new Map<string, Kept>();
  const inFlight = new Map<string, InFlight>();
  // Bumped by `drop`, so an answer to a request made under the old address or
  // key cannot land after the person changed them and pass for the new one.
  const generations = new Map<string, number>();
  const generationOf = (id: string): number => generations.get(id) ?? 0;

  function keptUnder(id: string, under: ReadUnder): Kept | null {
    const list = kept.get(id);
    return list !== undefined && sameReach(list, under) ? list : null;
  }

  /** The request for a provider's list: the one already on its way, or a new one. */
  function ask(adapter: ProviderAdapter, config: AdapterConfig, under: ReadUnder): Promise<BroappModel[]> {
    const generation = generationOf(adapter.id);
    const current = inFlight.get(adapter.id);
    if (current !== undefined && current.generation === generation && sameReach(current, under)) {
      return current.request;
    }
    const request = Promise.resolve().then(() =>
      adapter.models(config, AbortSignal.timeout(options.requestTimeoutMs)),
    );
    const entry: InFlight = { ...under, generation, request };
    inFlight.set(adapter.id, entry);
    // Whoever is waiting may have stopped at the deadline, so the request
    // settles here as well: an answer is kept, and a failure after nobody is
    // listening is handled rather than left as an unhandled rejection.
    void request
      .then(
        (models) => {
          if (generationOf(adapter.id) === generation) {
            kept.set(adapter.id, { ...under, models, listedAt: options.now() });
          }
        },
        () => undefined,
      )
      .finally(() => {
        if (inFlight.get(adapter.id) === entry) inFlight.delete(adapter.id);
      });
    return request;
  }

  return {
    async list(adapter, config, { fresh }) {
      const under: ReadUnder = { baseUrl: config.baseUrl, hasKey: hasValue(config.apiKey) };
      const recent = keptUnder(adapter.id, under);
      if (fresh && recent !== null && options.now() - recent.listedAt < options.freshMs) {
        return { kind: 'listed', models: recent.models };
      }

      const request = ask(adapter, config, under);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), options.deadlineMs);
      });
      try {
        const answer = await Promise.race([request, late]);
        if (answer !== 'late') return { kind: 'listed', models: answer };
        const earlier = keptUnder(adapter.id, under);
        if (earlier === null) {
          return { kind: 'failed', failure: publicError.unavailable(`${adapter.label} did not answer.`) };
        }
        return {
          kind: 'stale',
          models: earlier.models,
          listedAt: earlier.listedAt,
          message: `${adapter.label} did not answer. ${LISTED_EARLIER}`,
        };
      } catch (cause) {
        // Anything that is not a deliberate adapter failure is a fault, and a
        // kept list must not hide it.
        if (!(cause instanceof AdapterError)) throw cause;
        const earlier = keptUnder(adapter.id, under);
        if (earlier === null) return { kind: 'failed', failure: toPublicError(cause) };
        return {
          kind: 'stale',
          models: earlier.models,
          listedAt: earlier.listedAt,
          message: `${cause.message} ${LISTED_EARLIER}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    drop(providerId) {
      kept.delete(providerId);
      inFlight.delete(providerId);
      generations.set(providerId, generationOf(providerId) + 1);
    },
  };
}
