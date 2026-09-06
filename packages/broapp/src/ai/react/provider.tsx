/**
 * Shared AI state for everything below it.
 *
 * The settings panel and the chat panel both need to know whether AI is
 * configured, and they must not disagree — a chat that says "not set up" next
 * to a panel that just saved a key is worse than either alone. So the settings
 * are fetched once, here, and both read them from the same place.
 */
import * as React from 'react';

import type { BroappClient } from '../../client/client.ts';
import { BroappError } from '../../shared/errors.ts';
import { useBroapp, useBroappContract, useBroappReady, useConnection } from '../../react/hooks.tsx';
import type { AiContract } from '../shared/contract.ts';
import type { AiSettings } from '../shared/types.ts';

/** The AI client: the same connection, typed against the AI contract. */
export type AiClient = BroappClient<AiContract>;

interface AiContextValue {
  readonly settings: AiSettings | null;
  readonly error: BroappError | null;
  readonly loading: boolean;
  refresh(): Promise<void>;
  /** Write the settings other hooks just fetched, so one round trip serves all. */
  put(settings: AiSettings): void;
  client(): Promise<AiClient>;
}

const AiContext = React.createContext<AiContextValue | null>(null);

/** The route every installation of the AI contract has. */
const PROBE_ROUTE = 'ai.settingsGet';

const MISSING_CONTRACT =
  'AiProvider needs the AI contract: <BroappProvider contract={contract} extensions={[aiContract]}>';

/** Owns the AI settings for the components below it. */
export function AiProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const contract = useBroappContract();
  if (!Object.prototype.hasOwnProperty.call(contract.operations, PROBE_ROUTE)) {
    // Thrown at render rather than at the first call: the mistake is in the
    // provider setup, and that is where a developer should be sent.
    throw new Error(MISSING_CONTRACT);
  }

  const broapp = useBroapp<AiContract>();
  const ready = useBroappReady<AiContract>();
  const connection = useConnection();
  const [settings, setSettings] = React.useState<AiSettings | null>(null);
  const [error, setError] = React.useState<BroappError | null>(null);
  const [loading, setLoading] = React.useState(false);

  const client = React.useCallback(
    async (): Promise<AiClient> => broapp ?? (await ready),
    [broapp, ready],
  );

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const connected = await client();
      setSettings(await connected.call('ai.settingsGet', undefined));
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof BroappError
          ? cause
          : new BroappError('internal', 'The AI settings could not be read.', cause),
      );
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Once, when there is something to talk to. A settings read before the
  // connection settles would only fail and have to be retried.
  const fetched = React.useRef(false);
  React.useEffect(() => {
    if (connection.phase !== 'ready' || fetched.current) return;
    fetched.current = true;
    void refresh();
  }, [connection.phase, refresh]);

  const value = React.useMemo<AiContextValue>(
    () => ({ settings, error, loading, refresh, put: setSettings, client }),
    [settings, error, loading, refresh, client],
  );
  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

/** The shared AI state. Throws outside {@link AiProvider}. */
export function useAiContext(): AiContextValue {
  const value = React.useContext(AiContext);
  if (value === null) throw new Error('This hook must be used inside <AiProvider>');
  return value;
}
