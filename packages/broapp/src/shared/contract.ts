/**
 * The contract: the one description of an application's host surface that
 * both sides import.
 *
 * A contract is data, not code. It names operations and streams and gives
 * each a schema. The host imports it to register implementations; the browser
 * imports it to make typed calls. Because it holds no implementation, a
 * bundler that follows the browser's import of the contract does not pull the
 * host in with it — which is what keeps host code and host secrets out of the
 * browser bundle.
 *
 * Broapp maps a contract onto Brobridge's existing surface and nothing more:
 * an operation `"greet"` in group `"system"` is exactly
 * `bridge.expose("system", { greet })` on the host and
 * `bridge.call("system.greet", input)` in the browser. There is no second
 * dispatch path and no re-implemented transport.
 */
import type { Infer, Schema } from './schema.ts';

/** One unary operation: JSON in, JSON out. */
export interface OperationSpec<I = unknown, O = unknown> {
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  /** Shown in generated documentation and in the developer panel. */
  readonly summary?: string;
}

/**
 * One stream route.
 *
 * The wire format is newline-delimited JSON: each event is one JSON value on
 * one line. Brobridge streams carry bytes, and chunk boundaries are not
 * message boundaries, so Broapp frames them ({@link encodeEvent},
 * {@link NdjsonDecoder}) rather than assuming one chunk is one event.
 */
export interface StreamSpec<P = unknown, E = unknown> {
  readonly params: Schema<P>;
  readonly event: Schema<E>;
  readonly summary?: string;
}

/** The operation and stream tables an application declares. */
export interface ContractShape {
  readonly operations: Record<string, OperationSpec>;
  readonly streams: Record<string, StreamSpec>;
}

/** A validated contract. */
export interface Contract<C extends ContractShape> {
  readonly operations: C['operations'];
  readonly streams: C['streams'];
  /** Route names, for diagnostics and for the developer panel. */
  readonly routes: {
    readonly operations: readonly string[];
    readonly streams: readonly string[];
  };
}

/**
 * Any contract, for a generic parameter's constraint.
 *
 * Every public type below is written against `AnyContract` rather than against
 * `ContractShape`, because the thing an application has in hand is
 * `typeof contract` — the value `defineContract` returned. Making that the
 * parameter means `useOperation<AppContract, "demo.greet">` reads the way it
 * looks like it should, instead of needing the shape to be dug back out.
 */
export type AnyContract = Contract<ContractShape>;

/** The shape inside a contract. */
export type ShapeOf<C> = C extends Contract<infer S> ? S : never;

/** Operation names in a contract. */
export type OperationName<C extends AnyContract> = keyof ShapeOf<C>['operations'] & string;
/** Stream names in a contract. */
export type StreamName<C extends AnyContract> = keyof ShapeOf<C>['streams'] & string;

/** The argument type of one operation. */
export type OperationInput<C extends AnyContract, K extends OperationName<C>> = Infer<
  ShapeOf<C>['operations'][K]['input']
>;
/** The result type of one operation. */
export type OperationOutput<C extends AnyContract, K extends OperationName<C>> = Infer<
  ShapeOf<C>['operations'][K]['output']
>;
/** The parameter type of one stream. */
export type StreamParams<C extends AnyContract, K extends StreamName<C>> = Infer<
  ShapeOf<C>['streams'][K]['params']
>;
/** The event type of one stream. */
export type StreamEvent<C extends AnyContract, K extends StreamName<C>> = Infer<
  ShapeOf<C>['streams'][K]['event']
>;

/**
 * A route name is `group.member`. Brobridge resolves a unary call by splitting
 * on the first `.` and looking the group up in its service registry, so the
 * group must be present and must not itself contain a dot.
 *
 * The member may. Brobridge looks the remainder up as one own property of the
 * service object, so `ai.settings.get` is the method named `"settings.get"` on
 * the service `"ai"`. Broapp's AI contract uses that to group its routes by
 * subject without inventing a second dispatch rule.
 */
const ROUTE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** Split `"system.greet"` into its Brobridge service and method names. */
export function splitRoute(route: string): { group: string; member: string } {
  const cut = route.indexOf('.');
  return { group: route.slice(0, cut), member: route.slice(cut + 1) };
}

/**
 * Declare an application's host surface.
 *
 * Rejects a malformed route name at startup rather than at the first call,
 * because a route that Brobridge cannot resolve is a programming error and
 * should not wait for a user to find it.
 */
export function defineContract<const C extends ContractShape>(shape: C): Contract<C> {
  const operations = Object.keys(shape.operations);
  const streams = Object.keys(shape.streams);
  for (const route of [...operations, ...streams]) {
    if (!ROUTE_PATTERN.test(route)) {
      throw new TypeError(
        `route ${JSON.stringify(route)} must be "group.member", where each half is a JavaScript identifier`,
      );
    }
  }
  const clash = operations.find((route) => streams.includes(route));
  if (clash !== undefined) {
    throw new TypeError(`route ${JSON.stringify(clash)} is declared as both an operation and a stream`);
  }
  return {
    operations: shape.operations,
    streams: shape.streams,
    routes: { operations, streams },
  };
}

/**
 * Combine two contracts into one. Used in the browser so one client can
 * speak an application's contract and Broapp's AI contract over one
 * connection. Throws if any route name appears in both.
 */
export function mergeContracts<A extends AnyContract, B extends AnyContract>(
  a: A,
  b: B,
): Contract<{
  operations: ShapeOf<A>['operations'] & ShapeOf<B>['operations'];
  streams: ShapeOf<A>['streams'] & ShapeOf<B>['streams'];
}> {
  // A clash is checked across all four tables, not table by table: a name that
  // is an operation on one side and a stream on the other is just as
  // unresolvable as a duplicate operation, because Brobridge dispatches on the
  // route name alone.
  const names = new Set<string>([...a.routes.operations, ...a.routes.streams]);
  for (const route of [...b.routes.operations, ...b.routes.streams]) {
    if (names.has(route)) throw new TypeError(`route ${JSON.stringify(route)} is declared by both contracts`);
  }
  const operations = { ...a.operations, ...b.operations };
  const streams = { ...a.streams, ...b.streams };
  return {
    operations,
    streams,
    routes: { operations: Object.keys(operations), streams: Object.keys(streams) },
  } as Contract<{
    operations: ShapeOf<A>['operations'] & ShapeOf<B>['operations'];
    streams: ShapeOf<A>['streams'] & ShapeOf<B>['streams'];
  }>;
}

/** The route group Broapp reserves for its AI layer. */
export const RESERVED_GROUPS: readonly string[] = ['ai'];

/**
 * Throws if a contract declares a route in a reserved group.
 *
 * This is not checked in `defineContract`, because Broapp's own AI contract is
 * built with `defineContract` and has to be allowed the group. It is checked
 * where an *application* contract enters the host instead.
 */
export function assertNoReservedRoutes(contract: AnyContract): void {
  for (const route of [...contract.routes.operations, ...contract.routes.streams]) {
    const { group } = splitRoute(route);
    if (RESERVED_GROUPS.includes(group)) {
      throw new TypeError(
        `route ${JSON.stringify(route)} uses the group ${JSON.stringify(group)}, which is reserved for Broapp's AI layer`,
      );
    }
  }
}
