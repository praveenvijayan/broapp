/**
 * React bindings.
 *
 * Deliberately small: a provider that owns the connection, a hook that reads
 * it, a hook for one operation call, and a hook for one stream subscription.
 * Everything here is a convenience over `createClient`; nothing in Broapp
 * requires React, and a template that wanted Svelte would replace this file
 * and keep the rest.
 *
 * The connection lifecycle is the part that is easy to get wrong, so it is
 * handled once here: connect on mount, expose an honest state, and — the
 * important one — cancel every live stream when a component unmounts, because
 * dropping a subscription does not stop the host.
 */
import * as React from 'react';

import type {
  AnyContract,
  OperationInput,
  OperationName,
  OperationOutput,
  StreamEvent,
  StreamName,
  StreamParams,
} from '../shared/contract.ts';
import { mergeContracts } from '../shared/contract.ts';
import { BroappError } from '../shared/errors.ts';
import type { BridgeState, BroappClient, CreateClientOptions, Subscription } from '../client/client.ts';
import { createClient } from '../client/client.ts';

/** How the application should render its connection. */
export type ConnectionStatus =
  | { readonly phase: 'connecting' }
  /** Connected and usable. */
  | { readonly phase: 'ready'; readonly transport: BridgeState }
  /**
   * The socket dropped and is being re-established; live streams will resume.
   *
   * `since` is when the connection was lost, and `resumable` says whether a
   * successful reconnect could still restore live streams. Brobridge retains a
   * protocol session for `sessionTtlMs` after the last disconnect (60 seconds
   * by default); past that the session has been reaped and a reconnect starts
   * a fresh one. This is not an invented timeout — it is the host's documented
   * retention window, and it is the honest point at which an interface should
   * stop implying that work in progress is coming back.
   *
   * Note what it does *not* tell you: whether the host is still running. A
   * client cannot distinguish a host that died from one that is slow, so the
   * state stays `reconnecting` and the retries continue.
   */
  | { readonly phase: 'reconnecting'; readonly since: number; readonly resumable: boolean }
  /**
   * The connection is gone for good. In a local application the usual cause is
   * that the host process exited — which also destroys the session, so there
   * is nothing to reconnect to and the honest instruction is "start it again".
   */
  | { readonly phase: 'lost' }
  /** The first connection never succeeded. */
  | { readonly phase: 'failed'; readonly error: BroappError };

interface ContextValue<C extends AnyContract> {
  /** The connected client, once there is one. */
  readonly client: BroappClient<C> | null;
  /**
   * The client as a promise, resolved by the same connection attempt.
   *
   * `client` is null for the second or so between the first render and the
   * connection settling — and a user can click a button inside that window.
   * Failing those clicks with "not connected yet" is technically true and
   * useless: the application is starting, not broken. So the hooks await this
   * instead, and a genuinely failed connection surfaces as this promise
   * rejecting, which is a real error worth showing.
   */
  readonly ready: Promise<BroappClient<C>>;
  readonly status: ConnectionStatus;
  /**
   * The contract actually spoken, application plus extensions.
   *
   * Components below the provider read routes from here rather than from the
   * contract they were handed, because an extension's routes exist only after
   * the merge.
   */
  readonly contract: AnyContract;
}

const BroappContext = React.createContext<ContextValue<AnyContract> | null>(null);

/** Props for {@link BroappProvider}. */
export interface BroappProviderProps<C extends AnyContract> {
  readonly contract: C;
  /** Extra contracts to speak over the same connection, e.g. Broapp's `aiContract`. */
  readonly extensions?: readonly AnyContract[];
  readonly options?: CreateClientOptions;
  /**
   * How long the host retains a protocol session after a disconnect. Must
   * match the host's `sessionTtlMs`; the default is Brobridge's own default.
   * Used only to decide when `reconnecting` stops being `resumable`.
   */
  readonly sessionTtlMs?: number;
  readonly children: React.ReactNode;
}

function toStatus(state: BridgeState, since: number, now: number, ttlMs: number): ConnectionStatus {
  switch (state) {
    case 'open':
    case 'degraded':
      return { phase: 'ready', transport: state };
    case 'connecting':
      return { phase: 'connecting' };
    case 'resuming':
      return { phase: 'reconnecting', since, resumable: now - since < ttlMs };
    case 'closed':
      return { phase: 'lost' };
  }
}

/** Owns the connection for everything below it. */
export function BroappProvider<C extends AnyContract>({
  contract,
  extensions,
  options,
  sessionTtlMs = 60_000,
  children,
}: BroappProviderProps<C>): React.ReactElement {
  // Merged once and kept. Both contracts are module-level constants, and a
  // second merge would build a second client and drop the connection.
  const mergedRef = React.useRef<AnyContract | null>(null);
  if (mergedRef.current === null) {
    mergedRef.current = (extensions ?? []).reduce<AnyContract>(
      (left, right) => mergeContracts(left, right),
      contract,
    );
  }
  const merged = mergedRef.current as C;

  const [client, setClient] = React.useState<BroappClient<C> | null>(null);
  const [status, setStatus] = React.useState<ConnectionStatus>({ phase: 'connecting' });
  // Created before the effect runs, so the very first render already has
  // something for a hook to await.
  const gate = React.useRef<{
    promise: Promise<BroappClient<C>>;
    resolve: (client: BroappClient<C>) => void;
    reject: (cause: unknown) => void;
  } | null>(null);
  if (gate.current === null) {
    let resolve!: (client: BroappClient<C>) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<BroappClient<C>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nothing may await this before a hook does, and an unobserved rejection
    // would otherwise be reported as unhandled.
    promise.catch(() => undefined);
    gate.current = { promise, resolve, reject };
  }
  const ready = gate.current.promise;

  React.useEffect(() => {
    let live = true;
    let connected: BroappClient<C> | null = null;
    let unsubscribe: (() => void) | undefined;
    let lostAt = Date.now();
    // While reconnecting, the state stops changing but the *meaning* of it
    // does, so the status is refreshed on a slow tick rather than only on a
    // transport event.
    let tick: ReturnType<typeof setInterval> | undefined;

    void createClient(merged, options).then(
      (next) => {
        if (!live) {
          void next.close();
          return;
        }
        connected = next;
        gate.current?.resolve(next);
        setClient(next);
        setStatus(toStatus(next.state, lostAt, Date.now(), sessionTtlMs));
        unsubscribe = next.onState((state) => {
          if (state === 'resuming' || state === 'connecting') {
            // Only the first transition away from `open` starts the clock.
            if (connected?.state === 'open') lostAt = Date.now();
          } else {
            lostAt = Date.now();
          }
          setStatus(toStatus(state, lostAt, Date.now(), sessionTtlMs));
        });
        tick = setInterval(() => {
          const current = connected;
          if (current === null) return;
          setStatus(toStatus(current.state, lostAt, Date.now(), sessionTtlMs));
        }, 2_000);
      },
      (cause: unknown) => {
        const error =
          cause instanceof BroappError
            ? cause
            : new BroappError('unavailable', 'Could not reach the application host.', cause);
        gate.current?.reject(error);
        if (!live) return;
        setStatus({ phase: 'failed', error });
      },
    );

    return () => {
      live = false;
      if (tick !== undefined) clearInterval(tick);
      unsubscribe?.();
      void connected?.close();
    };
    // The contract is a module-level constant and the options object is
    // expected to be stable; re-running this effect would drop the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo<ContextValue<C>>(
    () => ({ client, ready, status, contract: merged }),
    [client, ready, status, merged],
  );
  return (
    <BroappContext.Provider value={value as ContextValue<AnyContract>}>
      {children}
    </BroappContext.Provider>
  );
}

function useContextValue<C extends AnyContract>(): ContextValue<C> {
  const value = React.useContext(BroappContext);
  if (value === null) throw new Error('useBroapp must be used inside <BroappProvider>');
  return value as ContextValue<C>;
}

/** The connection status, for a status indicator. */
export function useConnection(): ConnectionStatus {
  return useContextValue().status;
}

/**
 * The contract actually spoken over this connection, extensions included.
 *
 * An extension's own hooks use it to check that they were installed — asking
 * for a route that is not there fails at the first call otherwise, which is
 * later and further from the mistake.
 */
export function useBroappContract(): AnyContract {
  return useContextValue().contract;
}

/** The client, or `null` until the first connection settles. */
export function useBroapp<C extends AnyContract>(): BroappClient<C> | null {
  return useContextValue<C>().client;
}

/**
 * The client as a promise.
 *
 * Resolves once connected, rejects if the first connection fails. Useful for
 * code outside a hook that must not care whether startup has finished.
 */
export function useBroappReady<C extends AnyContract>(): Promise<BroappClient<C>> {
  return useContextValue<C>().ready;
}

/** What {@link useOperation} returns. */
export interface OperationHook<C extends AnyContract, K extends OperationName<C>> {
  /** Run it. Never rejects; the outcome lands in `data` or `error`. */
  run(input: OperationInput<C, K>): Promise<void>;
  readonly data: OperationOutput<C, K> | null;
  readonly error: BroappError | null;
  readonly pending: boolean;
  /** Clear `data` and `error`. */
  reset(): void;
}

/**
 * One operation, with its loading and error state.
 *
 * Only the most recent call may settle the state, so an earlier slow response
 * cannot overwrite a later one.
 */
export function useOperation<C extends AnyContract, K extends OperationName<C>>(
  name: K,
): OperationHook<C, K> {
  const { client, ready } = useContextValue<C>();
  const [data, setData] = React.useState<OperationOutput<C, K> | null>(null);
  const [error, setError] = React.useState<BroappError | null>(null);
  const [pending, setPending] = React.useState(false);
  const generation = React.useRef(0);

  const run = React.useCallback(
    async (input: OperationInput<C, K>): Promise<void> => {
      const mine = (generation.current += 1);
      setPending(true);
      setError(null);
      try {
        // Awaiting the connection rather than requiring it: a click during the
        // first second of startup should run, not fail.
        const connected = client ?? (await ready);
        const result = await connected.call(name, input);
        if (generation.current !== mine) return;
        setData(result);
      } catch (cause) {
        if (generation.current !== mine) return;
        setError(
          cause instanceof BroappError
            ? cause
            : new BroappError('internal', 'The operation failed.', cause),
        );
      } finally {
        if (generation.current === mine) setPending(false);
      }
    },
    [client, ready, name],
  );

  const reset = React.useCallback(() => {
    generation.current += 1;
    setData(null);
    setError(null);
    setPending(false);
  }, []);

  return { run, data, error, pending, reset };
}

/** What {@link useStream} returns. */
export interface StreamHook<C extends AnyContract, K extends StreamName<C>> {
  /** Open the stream. Cancels any stream this hook already had open. */
  start(params: StreamParams<C, K>): Promise<void>;
  /** Cancel it. The host stops producing. */
  cancel(): void;
  readonly last: StreamEvent<C, K> | null;
  readonly error: BroappError | null;
  readonly running: boolean;
  /** True when the previous run ended because `cancel()` was called. */
  readonly cancelled: boolean;
}

/**
 * One stream, with cancellation.
 *
 * The subscription is cancelled on unmount. That matters more here than in a
 * web application: the producer is a process on the user's machine, and a
 * stream nobody cancels goes on burning their CPU.
 */
export function useStream<C extends AnyContract, K extends StreamName<C>>(
  name: K,
): StreamHook<C, K> {
  const { client, ready } = useContextValue<C>();
  const [last, setLast] = React.useState<StreamEvent<C, K> | null>(null);
  const [error, setError] = React.useState<BroappError | null>(null);
  const [running, setRunning] = React.useState(false);
  const [cancelled, setCancelled] = React.useState(false);
  const active = React.useRef<Subscription | null>(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.cancel();
      active.current = null;
    };
  }, []);

  const cancel = React.useCallback(() => {
    if (active.current === null) return;
    active.current.cancel();
    active.current = null;
    setCancelled(true);
    setRunning(false);
  }, []);

  const start = React.useCallback(
    async (params: StreamParams<C, K>): Promise<void> => {
      active.current?.cancel();
      active.current = null;
      setError(null);
      setLast(null);
      setCancelled(false);
      setRunning(true);
      try {
        const connected = client ?? (await ready);
        if (!mounted.current) {
          setRunning(false);
          return;
        }
        const subscription = await connected.subscribe(name, params, {
          onEvent: (event) => {
            if (mounted.current) setLast(event);
          },
          onDone: () => {
            if (!mounted.current) return;
            active.current = null;
            setRunning(false);
          },
          onError: (cause) => {
            if (!mounted.current) return;
            active.current = null;
            setError(cause);
            setRunning(false);
          },
        });
        if (!mounted.current) {
          subscription.cancel();
          return;
        }
        active.current = subscription;
      } catch (cause) {
        if (!mounted.current) return;
        setRunning(false);
        setError(
          cause instanceof BroappError
            ? cause
            : new BroappError('internal', 'The stream could not be started.', cause),
        );
      }
    },
    [client, ready, name],
  );

  return { start, cancel, last, error, running, cancelled };
}
