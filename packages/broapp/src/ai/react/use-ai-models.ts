/**
 * The models every provider turned on in Settings offers, in one list.
 *
 * Refetched whenever something that would change the answer changes — which
 * providers are on, any of their addresses, or whether each has a key. Not on
 * every settings write: choosing a model must not send the application back to
 * every provider to ask what the models are.
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

export function useAiModels(): AiModelsHook {
  const shared = useAiContext();
  const [models, setModels] = React.useState<BroappModel[]>([]);
  const [unavailable, setUnavailable] = React.useState<UnavailableProvider[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<BroappError | null>(null);
  const generation = React.useRef(0);

  const provider = shared.settings?.provider ?? null;
  // One string for everything the answer depends on, so the effect runs when
  // one of them changes and not when a model is chosen.
  const reach = JSON.stringify(
    (shared.settings?.providers ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => [entry.id, entry.baseUrl, entry.hasKey]),
  );

  const refresh = React.useCallback(async (): Promise<void> => {
    if (provider === null) {
      setModels([]);
      setUnavailable([]);
      return;
    }
    const mine = (generation.current += 1);
    setPending(true);
    setError(null);
    try {
      const connected = await shared.client();
      const result = await connected.call('ai.modelsList', undefined);
      // A slow answer for providers the user has since changed must not
      // replace the list they are looking at now.
      if (generation.current !== mine) return;
      setModels(result.models);
      setUnavailable(result.unavailable);
    } catch (cause) {
      if (generation.current !== mine) return;
      setModels([]);
      setUnavailable([]);
      setError(
        cause instanceof BroappError
          ? cause
          : new BroappError('internal', 'The model list could not be read.', cause),
      );
    } finally {
      if (generation.current === mine) setPending(false);
    }
  }, [shared, provider]);

  React.useEffect(() => {
    void refresh();
    // `reach` is not used inside `refresh`; it is here because changing it
    // changes what the providers will answer.
  }, [refresh, reach]);

  return { models, unavailable, pending, error, refresh };
}
