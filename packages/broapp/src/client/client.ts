/**
 * The browser side of a contract.
 *
 * A thin, typed wrapper over `@brobridgejs/client`. It adds four things and
 * nothing else: contract-derived types, output validation, the error
 * translation described in `shared/errors.ts`, and a stream subscription with
 * a `cancel()` that really cancels.
 *
 * Importing this module pulls in the contract, which is data. It does not pull
 * in anything under `host/` — that separation is what keeps host code and host
 * configuration out of the browser bundle, and there is a test that asserts it.
 */
import type { Bridge, BridgeState, ConnectOptions, Unsubscribe } from '@brobridgejs/client';
import { connect } from '@brobridgejs/client';

import type {
  AnyContract,
  OperationInput,
  OperationName,
  OperationOutput,
  StreamEvent,
  StreamName,
  StreamParams,
} from '../shared/contract.ts';
import { BroappError, fromTransportError } from '../shared/errors.ts';
import { NdjsonDecoder } from '../shared/ndjson.ts';

export type { BridgeState };

/** Callbacks for a stream subscription. */
export interface StreamCallbacks<E> {
  onEvent(event: E): void;
  /** The stream finished normally. Not called after `onError` or a cancel. */
  onDone?(): void;
  /** The stream failed. Not called for a cancellation the caller asked for. */
  onError?(error: BroappError): void;
}

/** A running stream subscription. */
export interface Subscription {
  /**
   * Stop the stream and tell the host to stop producing.
   *
   * This sends a `CANCEL` frame. Simply dropping the subscription would not:
   * abandoning an async iterator does not cancel the stream underneath it, and
   * the host would keep computing until it finished.
   */
  cancel(): void;
  /** True once `cancel()` ran or the stream ended. */
  readonly closed: boolean;
}

/** A connected, contract-typed client. */
export interface BroappClient<C extends AnyContract> {
  /** Invoke an operation. Rejects with {@link BroappError}. */
  call<K extends OperationName<C>>(
    name: K,
    input: OperationInput<C, K>,
  ): Promise<OperationOutput<C, K>>;

  /** Open a stream. Returns as soon as the stream is open. */
  subscribe<K extends StreamName<C>>(
    name: K,
    params: StreamParams<C, K>,
    callbacks: StreamCallbacks<StreamEvent<C, K>>,
  ): Promise<Subscription>;

  /** What the connection is doing right now. */
  readonly state: BridgeState;
  /** Subscribe to connection state changes. */
  onState(listener: (state: BridgeState) => void): Unsubscribe;
  /** Round-trip time to the host, in milliseconds. */
  ping(): Promise<number>;
  /** The underlying Brobridge client, for anything this wrapper does not cover. */
  readonly bridge: Bridge;
  /** Disconnect. */
  close(): Promise<void>;
}

/** Options for {@link createClient}. */
export interface CreateClientOptions extends ConnectOptions {
  /**
   * The URL to connect to, including any `?bt=` launch token. Defaults to
   * `location.href`, which is where the token is on first load.
   */
  readonly url?: string;
}

/**
 * Connect to the host that served this page.
 *
 * The launch token in `location.href` is redeemed once by Brobridge and never
 * retained. Reconnection is on by default and carries the session cookie, so a
 * dropped socket recovers without a second token.
 */
export async function createClient<C extends AnyContract>(
  contract: C,
  options: CreateClientOptions = {},
): Promise<BroappClient<C>> {
  const { url, ...connectOptions } = options;
  const bridge = await connect(url ?? globalThis.location.href, connectOptions);

  return {
    bridge,
    get state() {
      return bridge.state;
    },
    onState(listener) {
      return bridge.on('state', listener);
    },
    ping: () => bridge.ping(),
    close: () => bridge.close(),

    async call(name, input) {
      let raw: unknown;
      try {
        raw = await bridge.call(name, input);
      } catch (cause) {
        throw fromTransportError(cause);
      }
      const spec = contract.operations[name];
      if (spec === undefined) throw new BroappError('internal', 'unknown operation');
      try {
        // The host is trusted, so this is a contract check rather than a
        // security boundary: it catches a host and a browser built from
        // different versions of the contract, which otherwise shows up as a
        // confusing render bug far from its cause.
        return spec.output.parse(raw) as OperationOutput<C, typeof name>;
      } catch {
        throw new BroappError('internal', 'The host returned a response this app did not expect.');
      }
    },

    async subscribe(name, params, callbacks) {
      const spec = contract.streams[name];
      if (spec === undefined) throw new BroappError('internal', 'unknown stream');

      // Params are checked here as well as on the host, and the two checks do
      // different jobs. The host's is the security boundary and is not
      // optional. This one is for the developer: a stream's `OPEN` is
      // acknowledged before its handler runs, so a host-side rejection arrives
      // *after* `subscribe` has already resolved — through `onError`, one tick
      // later. Checking here as well means an obviously wrong parameter fails
      // where the call was made.
      try {
        spec.params.parse(params);
      } catch (cause) {
        throw new BroappError(
          'invalid_input',
          cause instanceof Error ? cause.message : 'invalid stream parameters',
          cause,
        );
      }

      let stream: Awaited<ReturnType<Bridge['openStream']>>;
      try {
        stream = await bridge.openStream(name, params as Readonly<Record<string, unknown>>, {
          mode: 'read',
        });
      } catch (cause) {
        throw fromTransportError(cause);
      }

      let cancelled = false;
      let closed = false;
      const decoder = new NdjsonDecoder();

      const subscription: Subscription = {
        get closed() {
          return closed || cancelled;
        },
        cancel() {
          if (cancelled || closed) return;
          cancelled = true;
          stream.cancel('cancelled by the user');
        },
      };

      void (async () => {
        try {
          for await (const chunk of stream) {
            if (cancelled) break;
            for (const event of decoder.push(chunk)) {
              callbacks.onEvent(spec.event.parse(event) as StreamEvent<C, typeof name>);
            }
          }
          if (cancelled) return;
          for (const event of decoder.flush()) {
            callbacks.onEvent(spec.event.parse(event) as StreamEvent<C, typeof name>);
          }
          closed = true;
          callbacks.onDone?.();
        } catch (cause) {
          closed = true;
          if (cancelled) return;
          callbacks.onError?.(fromTransportError(cause));
        }
      })();

      return subscription;
    },
  };
}
