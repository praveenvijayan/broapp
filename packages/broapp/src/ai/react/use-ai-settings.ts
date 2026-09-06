/**
 * Reading and changing the AI settings.
 *
 * Every change is written straight through: there is no Save button, because
 * there is nothing to batch and a half-saved provider configuration is a state
 * worth not having. The result of each write replaces the shared settings, so
 * the rest of the interface updates without a second round trip.
 */
import * as React from 'react';

import type { OperationInput } from '../../shared/contract.ts';
import { BroappError } from '../../shared/errors.ts';
import type { AiContract } from '../shared/contract.ts';
import type { AiSettings, ProviderInfo } from '../shared/types.ts';

import { useAiContext } from './provider.tsx';

/** What `ai.settingsUpdate` accepts. */
export type UpdatePatch = OperationInput<AiContract, 'ai.settingsUpdate'>;

/** The result of a connection test. */
export interface ConnectionResult {
  readonly ok: boolean;
  readonly message: string;
  readonly latencyMs: number;
}

/** What {@link useAiSettings} returns. */
export interface AiSettingsHook {
  readonly settings: AiSettings | null;
  readonly providers: ProviderInfo[];
  readonly pending: boolean;
  readonly error: BroappError | null;
  update(patch: UpdatePatch): Promise<void>;
  test(): Promise<ConnectionResult | null>;
  refresh(): Promise<void>;
}

function asBroappError(cause: unknown, fallback: string): BroappError {
  return cause instanceof BroappError ? cause : new BroappError('internal', fallback, cause);
}

/** The settings, the providers this build has, and the two ways to change them. */
export function useAiSettings(): AiSettingsHook {
  const shared = useAiContext();
  const [providers, setProviders] = React.useState<ProviderInfo[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<BroappError | null>(null);

  // The provider list cannot change while the application runs — it is what
  // was compiled in — so it is fetched once.
  const fetched = React.useRef(false);
  React.useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    void (async () => {
      try {
        const connected = await shared.client();
        setProviders((await connected.call('ai.providersList', undefined)).providers);
      } catch (cause) {
        setError(asBroappError(cause, 'The provider list could not be read.'));
      }
    })();
  }, [shared]);

  const update = React.useCallback(
    async (patch: UpdatePatch): Promise<void> => {
      setPending(true);
      setError(null);
      try {
        const connected = await shared.client();
        shared.put(await connected.call('ai.settingsUpdate', patch));
      } catch (cause) {
        setError(asBroappError(cause, 'That setting could not be saved.'));
      } finally {
        setPending(false);
      }
    },
    [shared],
  );

  const test = React.useCallback(async (): Promise<ConnectionResult | null> => {
    setPending(true);
    setError(null);
    try {
      const connected = await shared.client();
      return await connected.call('ai.connectionTest', undefined);
    } catch (cause) {
      setError(asBroappError(cause, 'The connection could not be tested.'));
      return null;
    } finally {
      setPending(false);
    }
  }, [shared]);

  return {
    settings: shared.settings,
    providers,
    pending: pending || shared.loading,
    error: error ?? shared.error,
    update,
    test,
    refresh: shared.refresh,
  };
}
