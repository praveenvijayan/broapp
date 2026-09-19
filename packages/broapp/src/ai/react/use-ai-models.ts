/**
 * The models every provider turned on in Settings offers, in one list.
 *
 * Refetched whenever something that would change the answer changes — which
 * providers are on, any of their addresses, or whether each has a key. Not on
 * every settings write: choosing a model must not send the application back to
 * every provider to ask what the models are.
 *
 * Mounting asks `ai.modelsList`, which the host answers from a list read in the
 * last half minute when it has one, so three panels mounting together cost one
 * request per provider. `refresh()` asks `ai.modelsRefresh`, which always asks:
 * the Refresh button means it.
 *
 * While a new list is on its way the one already shown stays: `pending` says a
 * read is running, and an empty list with `pending` is the only "reading".
 */
import * as React from 'react';

import { BroappError } from '../../shared/errors.ts';
import type { BroappModel, UnavailableProvider } from '../shared/types.ts';

import { useAiContext } from './provider.tsx';

/** What {@link useAiModels} returns. */
export interface AiModelsHook {
  readonly models: BroappModel[];
  /** The providers that could not be read, or were cut short, each with its sentence. */
  readonly unavailable: UnavailableProvider[];
  readonly pending: boolean;
  readonly error: BroappError | null;
  refresh(): Promise<void>;
}

/** What {@link useAiModels} holds between renders. */
export interface ModelsState {
  readonly models: BroappModel[];
  readonly unavailable: UnavailableProvider[];
  readonly pending: boolean;
  readonly error: BroappError | null;
}

/** What happens to it. */
export type ModelsAction =
  | { readonly type: 'reading' }
  | { readonly type: 'read'; readonly models: BroappModel[]; readonly unavailable: UnavailableProvider[] }
  | { readonly type: 'failed'; readonly error: BroappError }
  | { readonly type: 'cleared' };

export const NO_MODELS: ModelsState = { models: [], unavailable: [], pending: false, error: null };

/**
 * The hook's state, as a function a test can call without a DOM. Reading
 * keeps the list already shown: a person choosing from it while a newer one
 * is on its way should not watch it empty and refill. Only a failure, which
 * means there is nothing to show, clears it.
 */
export function modelsReducer(state: ModelsState, action: ModelsAction): ModelsState {
  switch (action.type) {
    case 'reading':
      return { ...state, pending: true, error: null };
    case 'read':
      return { models: action.models, unavailable: action.unavailable, pending: false, error: null };
    case 'failed':
      return { models: [], unavailable: [], pending: false, error: action.error };
    case 'cleared':
      return NO_MODELS;
  }
}

export function useAiModels(): AiModelsHook {
  const shared = useAiContext();
  const [state, dispatch] = React.useReducer(modelsReducer, NO_MODELS);
  const generation = React.useRef(0);

  const provider = shared.settings?.provider ?? null;
  // One string for everything the answer depends on, so the effect runs when
  // one of them changes and not when a model is chosen.
  const reach = JSON.stringify(
    (shared.settings?.providers ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => [entry.id, entry.baseUrl, entry.hasKey]),
  );

  const load = React.useCallback(async (route: 'ai.modelsList' | 'ai.modelsRefresh'): Promise<void> => {
    if (provider === null) {
      generation.current += 1;
      dispatch({ type: 'cleared' });
      return;
    }
    const mine = (generation.current += 1);
    dispatch({ type: 'reading' });
    try {
      const connected = await shared.client();
      const result = await connected.call(route, undefined);
      // A slow answer for providers the user has since changed must not
      // replace the list they are looking at now.
      if (generation.current !== mine) return;
      dispatch({ type: 'read', models: result.models, unavailable: result.unavailable });
    } catch (cause) {
      if (generation.current !== mine) return;
      dispatch({
        type: 'failed',
        error:
          cause instanceof BroappError
            ? cause
            : new BroappError('internal', 'The model list could not be read.', cause),
      });
    }
  }, [shared, provider]);

  const refresh = React.useCallback((): Promise<void> => load('ai.modelsRefresh'), [load]);

  React.useEffect(() => {
    void load('ai.modelsList');
    // `reach` is not used inside `load`; it is here because changing it
    // changes what the providers will answer.
  }, [load, reach]);

  return { ...state, refresh };
}
