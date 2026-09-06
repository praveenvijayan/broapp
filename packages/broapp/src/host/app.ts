/**
 * The host side of a contract.
 *
 * `createHostApp(contract)` returns a registry a developer fills in, and
 * `mount()` hands the result to a Brobridge bridge. The layer is thin by
 * design: it validates input, draws the error boundary, frames stream events,
 * and turns cancellation into an `AbortSignal`. Transport, authentication and
 * session handling stay entirely in Brobridge.
 *
 * Where to add an operation: declare it in the shared contract, then call
 * `app.operation(name, handler)` here. The compiler will not let those two
 * drift.
 */
import type { Bridge, StreamContext } from 'brobridge';
import type { BridgeStream } from '@brobridgejs/core';

import type {
  AnyContract,
  OperationInput,
  OperationName,
  OperationOutput,
  StreamEvent,
  StreamName,
  StreamParams,
} from '../shared/contract.ts';
import { assertNoReservedRoutes, splitRoute } from '../shared/contract.ts';
import { INTERNAL_ERROR_MESSAGE, isPublicBridgeError, PublicError } from '../shared/errors.ts';
import { encodeEvent } from '../shared/ndjson.ts';
import { ValidationError } from '../shared/schema.ts';

/**
 * What an operation handler is told about its caller.
 *
 * There is no session identifier here. Brobridge passes a session id to
 * *stream* handlers (`StreamContext`) but not to the methods of an exposed
 * service, and Broapp does not invent one. Every call has nonetheless already
 * passed Brobridge's trust fence and cookie check before a handler runs; the
 * missing piece is only *which* authenticated tab called, which a v1 starter
 * has no use for. An application that needs it should use a stream.
 */
export interface CallContext {
  /** The route name, for logging. */
  readonly route: string;
}

/** A unary operation implementation. */
export type OperationHandler<C extends AnyContract, K extends OperationName<C>> = (
  input: OperationInput<C, K>,
  context: CallContext,
) => OperationOutput<C, K> | Promise<OperationOutput<C, K>>;

/** What a stream handler is given to talk back with. */
export interface StreamSink<E> {
  /**
   * Send one event.
   *
   * Awaiting it is what applies backpressure: the promise settles when
   * Brobridge's flow control has room, so a browser that stops reading slows
   * the producer instead of filling a buffer. It rejects once the stream has
   * ended, which includes the browser cancelling.
   */
  emit(event: E): Promise<void>;
  /** Aborted when the browser cancels, the tab disconnects, or the host shuts down. */
  readonly signal: AbortSignal;
  /** The authenticated Brobridge session this stream belongs to. */
  readonly sessionId: string;
}

/** A stream implementation. Returning ends the stream cleanly. */
export type StreamHandlerFor<C extends AnyContract, K extends StreamName<C>> = (
  params: StreamParams<C, K>,
  sink: StreamSink<StreamEvent<C, K>>,
) => void | Promise<void>;

/** Diagnostics sink. Defaults to `console`. */
export interface HostLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** Options for {@link createHostApp}. */
export interface HostAppOptions {
  readonly logger?: HostLogger;
}

/** A contract with implementations attached, ready to mount on a bridge. */
export interface HostApp<C extends AnyContract> {
  /** Implement one operation from the contract. */
  operation<K extends OperationName<C>>(name: K, handler: OperationHandler<C, K>): HostApp<C>;
  /** Implement one stream from the contract. */
  stream<K extends StreamName<C>>(name: K, handler: StreamHandlerFor<C, K>): HostApp<C>;
  /**
   * Register everything with a bridge.
   *
   * Throws when the contract declares a route no handler implements: a route
   * that answers `NOT_FOUND` at runtime is a shipped bug, and startup is when
   * a developer is present to see it.
   */
  mount(bridge: Bridge): void;
  /**
   * Run one operation directly, without the bridge. Input is validated and
   * output is checked exactly as for a call from the browser, and the same
   * error boundary applies. This is how the AI layer lets a model call an
   * application's operations as tools.
   *
   * A route that is a stream, or one no handler implements, is a programming
   * error rather than a call failure, so it throws `TypeError` at the call
   * site instead of rejecting.
   */
  invoke<K extends OperationName<C>>(name: K, input: unknown): Promise<OperationOutput<C, K>>;
  /** Abort every stream this app currently has open. Called during shutdown. */
  abortAll(reason: string): void;
  /** How many streams are running right now. */
  readonly activeStreams: number;
}

/**
 * Build the host side of an application's contract.
 *
 * The reserved-group check lives here rather than in `defineContract` because
 * Broapp's own AI contract is built with `defineContract` and legitimately
 * uses the group. An application that declares `ai.*` would collide with the
 * AI layer on the same bridge, so it is refused while a developer is watching.
 */
export function createHostApp<C extends AnyContract>(
  contract: C,
  options: HostAppOptions = {},
): HostApp<C> {
  assertNoReservedRoutes(contract);
  return createReservedHostApp(contract, options);
}

/**
 * Build a host app without the reserved-group check.
 *
 * Not for applications. `broapp/ai/host` uses it to mount the AI contract,
 * which is the one contract allowed to own the `ai` group.
 */
export function createReservedHostApp<C extends AnyContract>(
  contract: C,
  options: HostAppOptions = {},
): HostApp<C> {
  const logger: HostLogger = options.logger ?? console;
  const operations = new Map<string, OperationHandler<C, never>>();
  const streams = new Map<string, StreamHandlerFor<C, never>>();
  const running = new Set<AbortController>();

  function known(kind: 'operation' | 'stream', name: string): void {
    const table = kind === 'operation' ? contract.operations : contract.streams;
    if (!Object.prototype.hasOwnProperty.call(table, name)) {
      throw new TypeError(`${kind} ${JSON.stringify(name)} is not declared in the contract`);
    }
  }

  /**
   * One operation call, from the bridge or from {@link HostApp.invoke}.
   *
   * Both paths must validate the same way and fail the same way — an AI tool
   * call is not more trusted than a browser call just because it originates
   * inside the host — so there is one implementation and two callers.
   */
  async function runOperation(route: string, raw: unknown): Promise<unknown> {
    const spec = contract.operations[route];
    const handler = operations.get(route);
    if (spec === undefined || handler === undefined) {
      throw new TypeError(`operation ${JSON.stringify(route)} has no implementation`);
    }
    const context: CallContext = { route };
    let input: unknown;
    try {
      input = spec.input.parse(raw);
    } catch (cause) {
      // A validation message names a field and a constraint from the contract
      // the browser already has. It carries nothing the caller did not send,
      // so it is safe to return and useful to see.
      throw new PublicError(
        'invalid_input',
        cause instanceof ValidationError ? cause.message : 'invalid input',
      ).toBridgeError();
    }
    try {
      const output = await handler(input as never, context);
      return spec.output.parse(output);
    } catch (cause) {
      throw wrap(cause, route, logger);
    }
  }

  const app: HostApp<C> = {
    operation(name, handler) {
      known('operation', name);
      if (operations.has(name)) throw new TypeError(`operation ${JSON.stringify(name)} is already implemented`);
      operations.set(name, handler as OperationHandler<C, never>);
      return app;
    },

    stream(name, handler) {
      known('stream', name);
      if (streams.has(name)) throw new TypeError(`stream ${JSON.stringify(name)} is already implemented`);
      streams.set(name, handler as StreamHandlerFor<C, never>);
      return app;
    },

    invoke(name, input) {
      // Structural mistakes surface synchronously: a stream is not invokable
      // and a missing handler is a bug, and neither should look like a failed
      // call to whatever is awaiting the result.
      if (Object.prototype.hasOwnProperty.call(contract.streams, name)) {
        throw new TypeError(`route ${JSON.stringify(name)} is a stream, which cannot be invoked`);
      }
      if (!Object.prototype.hasOwnProperty.call(contract.operations, name)) {
        throw new TypeError(`operation ${JSON.stringify(name)} is not declared in the contract`);
      }
      if (!operations.has(name)) {
        throw new TypeError(`operation ${JSON.stringify(name)} has no implementation`);
      }
      return runOperation(name, input).catch((cause: unknown) => {
        // On the bridge, Brobridge reduces an unexpected failure to a fixed
        // sentence on the way out. `invoke` has no transport to do that, and
        // its caller is the AI layer, which may put what it is given into a
        // transcript — so the same reduction is applied here.
        throw isPublicBridgeError(cause) ? cause : new Error(INTERNAL_ERROR_MESSAGE);
      }) as Promise<never>;
    },

    get activeStreams() {
      return running.size;
    },

    abortAll(reason) {
      for (const controller of running) controller.abort(new Error(reason));
    },

    mount(bridge) {
      const missing = [
        ...contract.routes.operations.filter((route) => !operations.has(route)),
        ...contract.routes.streams.filter((route) => !streams.has(route)),
      ];
      if (missing.length > 0) {
        throw new TypeError(`contract routes have no implementation: ${missing.join(', ')}`);
      }

      // Brobridge exposes a *service object* per group, so the contract's
      // dotted routes are collected back into groups here. This is the only
      // place the two namings meet.
      const groups = new Map<string, Record<string, unknown>>();
      for (const route of operations.keys()) {
        const { group, member } = splitRoute(route);
        if (contract.operations[route] === undefined) continue;
        const service = groups.get(group) ?? {};
        service[member] = (raw: unknown): Promise<unknown> => runOperation(route, raw);
        groups.set(group, service);
      }
      for (const [group, service] of groups) bridge.expose(group, service);

      for (const [route, handler] of streams) {
        const spec = contract.streams[route];
        if (spec === undefined) continue;
        bridge.stream(route, (stream: BridgeStream, streamContext: StreamContext) =>
          runStream(stream, streamContext, route, spec, handler, running, logger),
        );
      }
    },
  };

  return app;
}

/**
 * Reduce a handler failure to something safe to send.
 *
 * A `PublicError` was written for the browser and keeps its message. Anything
 * else is logged here — with its stack, on the host, where it belongs — and
 * rethrown unchanged so Brobridge applies its own reduction to `"internal
 * error"`. Broapp does not need to redact it a second time and must not
 * accidentally undo the reduction by wrapping the message.
 */
function wrap(cause: unknown, route: string, logger: HostLogger): unknown {
  if (cause instanceof PublicError) return cause.toBridgeError();
  logger.error(`[broapp] ${route} failed: ${String(cause instanceof Error ? cause.stack ?? cause.message : cause)}`);
  return cause;
}

/**
 * Run one stream handler.
 *
 * Cancellation is the part worth reading. Brobridge's `BridgeStream.cancel()`
 * on the browser side sends a `CANCEL` frame; the host's stream then fails
 * with a `CANCELLED` `StreamError`, which shows up here as `stream.closed`
 * rejecting. That rejection is the *only* reliable cancellation signal — a
 * browser that merely stops iterating sends nothing, and a `for await` loop
 * that a consumer breaks out of does not cancel the underlying stream. So the
 * signal is wired from `stream.closed`, and the same `AbortController` is
 * aborted on shutdown.
 */
async function runStream<E>(
  stream: BridgeStream,
  streamContext: StreamContext,
  route: string,
  spec: { params: { parse(value: unknown): unknown }; event: { parse(value: unknown): unknown } },
  handler: (params: never, sink: StreamSink<E>) => void | Promise<void>,
  running: Set<AbortController>,
  logger: HostLogger,
): Promise<void> {
  const controller = new AbortController();
  running.add(controller);

  // `closed` rejects on cancellation and on a torn-down connection, and
  // resolves on a clean end. Either way the handler must stop.
  stream.closed.then(
    () => controller.abort(new Error('stream closed')),
    (cause: unknown) => controller.abort(cause),
  );

  let params: unknown;
  try {
    params = spec.params.parse(streamContext.params);
  } catch (cause) {
    running.delete(controller);
    throw new PublicError(
      'invalid_input',
      cause instanceof ValidationError ? cause.message : 'invalid stream parameters',
    ).toBridgeError();
  }

  const sink: StreamSink<E> = {
    signal: controller.signal,
    sessionId: streamContext.sessionId,
    async emit(event: E): Promise<void> {
      if (controller.signal.aborted) throw new Error('stream is no longer open');
      await stream.write(encodeEvent(spec.event.parse(event)));
    },
  };

  try {
    await handler(params as never, sink);
    if (!controller.signal.aborted) await stream.end();
  } catch (cause) {
    // A cancelled stream is not a fault: the browser asked for it, the stream
    // is already gone, and there is nothing to report.
    if (controller.signal.aborted) return;
    throw wrap(cause, route, logger);
  } finally {
    running.delete(controller);
    controller.abort(new Error('handler finished'));
  }
}
