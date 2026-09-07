/**
 * Turning a reference in a view specification into a value.
 *
 * This is where a declarative interface stops being declarative if you are not
 * careful. A `$source.one.title` could be an expression language, and an
 * expression language in a view specification is a way to run generated code in
 * the browser without admitting it. So it is not one: a reference names a
 * bucket and a path, the path is a list of keys, and there is no arithmetic, no
 * calls and no operators.
 *
 * An unknown reference throws rather than resolving to `undefined`. A form that
 * silently submitted `undefined` for a field the author thought they had bound
 * is far worse than one that fails while a developer is looking at it.
 */
import type { JsonSchema } from 'broapp/shared';

import type { Path } from '../views/types.ts';

/** Everything a reference may be resolved against. */
export interface Scope {
  /** Page parameters, by name. */
  readonly params?: Readonly<Record<string, string>>;
  /** Form field values, by field id. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** The row a row action was clicked on. */
  readonly row?: unknown;
  /** Loaded source results, by source id. */
  readonly sources?: Readonly<Record<string, unknown>>;
}

/**
 * Read a dotted path out of a JSON value.
 *
 * A numeric segment indexes an array. A path that runs off the end is
 * `undefined` rather than an error: a source that has not loaded yet, or a
 * record missing an optional field, is an ordinary state for a rendering
 * interface to be in.
 */
export function readPath(value: unknown, path: Path): unknown {
  if (path === '') return value;
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** True when a value is a reference rather than a literal. */
export function isReference(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$');
}

/**
 * Resolve one value from a view specification.
 *
 * A literal is itself. A string beginning with `$` names a bucket in the scope
 * and a path within it.
 */
export function resolveValue(value: unknown, scope: Scope): unknown {
  if (!isReference(value)) return value;
  const cut = value.indexOf('.');
  const bucket = cut < 0 ? value.slice(1) : value.slice(1, cut);
  const rest = cut < 0 ? '' : value.slice(cut + 1);

  switch (bucket) {
    case 'param': {
      const found = scope.params?.[rest];
      if (found === undefined) throw new TypeError(`${value} names a page parameter that is not there`);
      return found;
    }
    case 'field': {
      if (scope.fields === undefined || !(rest in scope.fields)) {
        throw new TypeError(`${value} names a form field that is not there`);
      }
      return scope.fields[rest];
    }
    case 'row': {
      if (scope.row === undefined) throw new TypeError(`${value} is only available inside a row action`);
      return readPath(scope.row, rest);
    }
    case 'source': {
      const head = rest.indexOf('.');
      const id = head < 0 ? rest : rest.slice(0, head);
      if (scope.sources === undefined || !(id in scope.sources)) {
        throw new TypeError(`${value} names a source that is not loaded by this page`);
      }
      return readPath(scope.sources[id], head < 0 ? '' : rest.slice(head + 1));
    }
    default:
      throw new TypeError(`${value} is not a reference this renderer understands`);
  }
}

/**
 * Resolve every reference inside a value, however deeply nested.
 *
 * A source's `input` is an object whose *values* may be references, not itself
 * a reference, so resolving the top level alone would pass `"$param.id"`
 * through to the host verbatim.
 */
export function resolveDeep(value: unknown, scope: Scope): unknown {
  if (isReference(value)) return resolveValue(value, scope);
  if (Array.isArray(value)) return value.map((member) => resolveDeep(member, scope));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveDeep(member, scope);
    }
    return out;
  }
  return value;
}

/** Build an operation's input from an action's declared bindings. */
export function resolveInput(
  input: Readonly<Record<string, unknown>> | undefined,
  scope: Scope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) out[key] = resolveDeep(value, scope);
  return out;
}

/**
 * Give an input the types the contract asks for.
 *
 * A page parameter comes out of a URL, and a URL is text. An `<input>` is text
 * too. The contract says what each field actually is, so that is what decides —
 * rather than the renderer guessing from the shape of the string, which would
 * turn a note whose id is `"007"` into `7`.
 */
export function coerceToSchema(
  input: Readonly<Record<string, unknown>>,
  schema: JsonSchema | null | undefined,
): Record<string, unknown> {
  const properties = schema?.['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return { ...input };
  }
  const types = properties as Record<string, { type?: unknown }>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const wanted = types[key]?.type;
    if (typeof value !== 'string') {
      out[key] = value;
    } else if (wanted === 'number' || wanted === 'integer') {
      const asNumber = Number(value);
      out[key] = Number.isFinite(asNumber) ? asNumber : value;
    } else if (wanted === 'boolean') {
      out[key] = value === 'true';
    } else {
      out[key] = value;
    }
  }
  return out;
}
