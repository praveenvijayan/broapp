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
  /** Test the provider in use, or, given an id, that provider with its own address and key. */
  test(provider?: string): Promise<ConnectionResult | null>;
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

  // The providers cannot change while the application runs — they are what
  // was compiled in — but whether each runs on this computer is a property of
  // its address, so the list is read again when an address changes.
  const addresses = JSON.stringify((shared.settings?.providers ?? []).map((entry) => [entry.id, entry.baseUrl]));
  React.useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const connected = await shared.client();
        const listed = (await connected.call('ai.providersList', undefined)).providers;
        if (current) setProviders(listed);
      } catch (cause) {
        if (current) setError(asBroappError(cause, 'The provider list could not be read.'));
      }
    })();
    return () => {
      current = false;
    };
  }, [shared, addresses]);

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

  const test = React.useCallback(async (provider?: string): Promise<ConnectionResult | null> => {
    setPending(true);
    setError(null);
    try {
      const connected = await shared.client();
      return provider === undefined
        ? await connected.call('ai.connectionTest', undefined)
        : await connected.call('ai.providerTest', { provider });
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
