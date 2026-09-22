/**
 * A contract, as JSON that outlives the process that made it.
 *
 * The host has the contract as live validator objects. Everything else — the
 * release directory on disk, the renderer, the engineer deciding what to
 * propose, the MCP adapter listing tools — needs it as data. This is the one
 * place that conversion happens, and it is deliberately strict: an Autoapp
 * release must say what every route does and what every route is for, because
 * both of those are read by things that cannot ask.
 */
import { effectOf } from 'broapp/shared';
import type { AnyContract, Effect, JsonSchema } from 'broapp/shared';

import type { ContractExport, ExportedRoute } from './types.ts';

/** The shape of one entry in a contract's two tables, as much as is needed here. */
/** What a validator looks like from here: it can describe itself, and it may say what kind it is. */
interface Describable {
  readonly kind?: string;
  readonly toJsonSchema?: () => JsonSchema;
}

interface RouteSpec {
  readonly summary?: string;
  readonly effect?: Effect;
  readonly input?: Describable;
  readonly output?: Describable;
  readonly params?: Describable;
  readonly event?: Describable;
}

/**
 * Ask a validator to describe itself, or say which route cannot.
 *
 * `s.void()` describes itself as an object with no properties, the same words
 * `s.object({})` uses, because a provider asking for a tool's arguments wants
 * an object either way. They are not the same to the host: void refuses `{}`,
 * the empty object wants it. So an export says which is which — a void input
 * carries `maxProperties: 0`, which is plain JSON Schema for "no members" and
 * which an object with members to list never has — and the view check and the
 * renderer read that rather than guessing from the shape.
 */
function describe(validator: Describable | undefined, route: string, which: string): JsonSchema {
  if (validator === undefined || typeof validator.toJsonSchema !== 'function') {
    throw new TypeError(
      `route ${JSON.stringify(route)} has a ${which} validator with no toJsonSchema(), so it cannot be exported`,
    );
  }
  const described = validator.toJsonSchema();
  return validator.kind === 'void' ? { ...described, maxProperties: 0 } : described;
}

/** Turn one route's specification into its exported form. */
function exportRoute(route: string, spec: RouteSpec, isStream: boolean): ExportedRoute {
  if (spec.effect === undefined) {
    throw new TypeError(
      `route ${JSON.stringify(route)} must declare an effect before it can be part of an Autoapp release`,
    );
  }
  if (spec.summary === undefined || spec.summary === '') {
    throw new TypeError(
      `route ${JSON.stringify(route)} needs a summary before it can be part of an Autoapp release`,
    );
  }
  return {
    effect: effectOf(spec),
    summary: spec.summary,
    input: describe(isStream ? spec.params : spec.input, route, isStream ? 'params' : 'input'),
    output: describe(isStream ? spec.event : spec.output, route, isStream ? 'event' : 'output'),
  };
}

/** Export a live contract to portable JSON. */
export function exportContract(contract: AnyContract): ContractExport {
  const operations: Record<string, ExportedRoute> = {};
  for (const [route, spec] of Object.entries(contract.operations)) {
    operations[route] = exportRoute(route, spec as RouteSpec, false);
  }
  const streams: Record<string, ExportedRoute> = {};
  for (const [route, spec] of Object.entries(contract.streams)) {
    streams[route] = exportRoute(route, spec as RouteSpec, true);
  }
  return { operations, streams };
}
