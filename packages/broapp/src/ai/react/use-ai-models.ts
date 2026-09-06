/**
 * The models the configured provider offers.
 *
 * Refetched whenever something that would change the answer changes — the
 * provider, its address, or whether a key is set. Not on every settings write:
 * choosing a model must not send the application back to the provider to ask
 * what the models are.
 */
import * as React from 'react';

import { BroappError } from '../../shared/errors.ts';
import type { BroappModel } from '../shared/types.ts';

import { useAiContext } from './provider.tsx';

/** What {@link useAiModels} returns. */
export interface AiModelsHook {
  readonly models: BroappModel[];
  readonly pending: boolean;
  readonly error: BroappError | null;
  refresh(): Promise<void>;
}

export function useAiModels(): AiModelsHook {
  const shared = useAiContext();
  const [models, setModels] = React.useState<BroappModel[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<BroappError | null>(null);
  const generation = React.useRef(0);

  const provider = shared.settings?.provider ?? null;
  const baseUrl = shared.settings?.baseUrl ?? null;
  const hasKey = shared.settings?.hasKey ?? false;

  const refresh = React.useCallback(async (): Promise<void> => {
    if (provider === null) {
      setModels([]);
      return;
    }
    const mine = (generation.current += 1);
    setPending(true);
    setError(null);
    try {
      const connected = await shared.client();
      const result = await connected.call('ai.modelsList', undefined);
      // A slow answer for a provider the user has since changed must not
      // replace the list they are looking at now.
      if (generation.current !== mine) return;
      setModels(result.models);
    } catch (cause) {
      if (generation.current !== mine) return;
      setModels([]);
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
    // `baseUrl` and `hasKey` are not used inside `refresh`; they are here
    // because changing either changes what the provider will answer.
  }, [refresh, baseUrl, hasKey]);

  return { models, pending, error, refresh };
}
