/**
 * A very small runtime validator.
 *
 * Broapp needs three things from a validation library: it must describe JSON
 * shapes, it must infer a TypeScript type from a schema value, and it must
 * refuse untrusted input on the host. It does not need transforms, unions of
 * objects, effects, or async refinement. Everything here is roughly 250 lines
 * and has no dependencies, which keeps a generated application installable
 * and runnable without a network and keeps the browser bundle small.
 *
 * If an application outgrows it, nothing in Broapp requires these schemas —
 * `defineContract` accepts any object with a `parse` method, so `zod`,
 * `valibot` or `arktype` drop in unchanged.
 */

/** Where a validation failure happened, as a dotted path from the root value. */
export type IssuePath = readonly (string | number)[];

/** One validation failure. */
export interface Issue {
  readonly path: IssuePath;
  readonly message: string;
}

/** Thrown by {@link Schema.parse}. Its message names the first failure. */
export class ValidationError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    const first = issues[0];
    const where = first && first.path.length > 0 ? formatPath(first.path) : 'value';
    super(first ? `${where}: ${first.message}` : 'invalid value');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function formatPath(path: IssuePath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/** The result of a non-throwing validation. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

/**
 * A JSON Schema document, as a plain object.
 *
 * Broapp emits a draft 2020-12 subset — enough for a language model provider
 * to describe a tool's arguments, and nothing more. It is deliberately not a
 * typed tree: every consumer so far hands it straight to a provider as JSON.
 */
export type JsonSchema = Record<string, unknown>;

/** A runtime schema for one JSON value. */
export interface Schema<T> {
  /** Discriminates a Broapp schema from a foreign one at runtime. */
  readonly kind: string;
  /** Validate without throwing. */
  check(value: unknown, path?: IssuePath): Result<T>;
  /** Validate, or throw {@link ValidationError}. */
  parse(value: unknown): T;
  /** A JSON Schema (draft 2020-12 subset) describing what `parse` accepts. */
  toJsonSchema(): JsonSchema;
  /** Phantom marker; never present at runtime. */
  readonly _type?: T;
}

/** The TypeScript type a schema accepts. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** Collapse an intersection back into one object type, keeping `?` modifiers. */
type Flatten<T> = { [K in keyof T]: T[K] };

/**
 * What an object schema accepts.
 *
 * A field wrapped in `s.optional` may be left out entirely, so its key is
 * optional here rather than merely admitting `undefined`. Without this an
 * `s.optional` field would still have to be spelled out at every construction
 * site, which is the opposite of what the wrapper says.
 */
export type InferObject<F> = Flatten<
  { [K in keyof F as undefined extends Infer<F[K]> ? never : K]: Infer<F[K]> } & {
    [K in keyof F as undefined extends Infer<F[K]> ? K : never]?: Infer<F[K]>;
  }
>;

function schema<T>(
  kind: string,
  check: (value: unknown, path: IssuePath) => Result<T>,
  toJsonSchema: () => JsonSchema,
): Schema<T> {
  const self: Schema<T> = {
    kind,
    check: (value, path = []) => check(value, path),
    parse(value) {
      const outcome = self.check(value, []);
      if (outcome.ok) return outcome.value;
      throw new ValidationError(outcome.issues);
    },
    toJsonSchema,
  };
  return self;
}

/**
 * Assemble a JSON Schema object, dropping every keyword whose option was not
 * given. An explicit `minLength: undefined` disappears from `JSON.stringify`
 * but is still a key at runtime, and a provider that enumerates keywords would
 * see it — so the key is never created in the first place.
 */
function keywords(entries: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function fail<T = never>(path: IssuePath, message: string): Result<T> {
  return { ok: false, issues: [{ path, message }] };
}

/** Options for {@link s.string}. */
export interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  /** Must match end to end. Anchors are added, so a partial pattern still means "the whole string". */
  readonly pattern?: RegExp;
}

/** Options for {@link s.number}. */
export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly int?: boolean;
}

/** Options for {@link s.array}. */
export interface ArrayOptions {
  readonly min?: number;
  readonly max?: number;
}

/** Schema constructors. */
export const s = {
  string(options: StringOptions = {}): Schema<string> {
    return schema('string', (value, path) => {
      if (typeof value !== 'string') return fail(path, 'expected a string');
      if (options.min !== undefined && value.length < options.min) {
        return fail(path, `expected at least ${String(options.min)} character(s)`);
      }
      if (options.max !== undefined && value.length > options.max) {
        return fail(path, `expected at most ${String(options.max)} character(s)`);
      }
      if (options.pattern !== undefined) {
        const anchored = new RegExp(`^(?:${options.pattern.source})$`, options.pattern.flags.replace('g', ''));
        if (!anchored.test(value)) return fail(path, 'does not match the required format');
      }
      return { ok: true, value };
    },
      () =>
        keywords({
          type: 'string',
          minLength: options.min,
          maxLength: options.max,
          pattern: options.pattern?.source,
        }),
    );
  },

  number(options: NumberOptions = {}): Schema<number> {
    return schema('number', (value, path) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail(path, 'expected a finite number');
      }
      if (options.int === true && !Number.isInteger(value)) return fail(path, 'expected an integer');
      if (options.min !== undefined && value < options.min) {
        return fail(path, `expected >= ${String(options.min)}`);
      }
      if (options.max !== undefined && value > options.max) {
        return fail(path, `expected <= ${String(options.max)}`);
      }
      return { ok: true, value };
    },
      () =>
        keywords({
          type: options.int === true ? 'integer' : 'number',
          minimum: options.min,
          maximum: options.max,
        }),
    );
  },

  boolean(): Schema<boolean> {
    return schema(
      'boolean',
      (value, path) =>
        typeof value === 'boolean' ? { ok: true, value } : fail(path, 'expected a boolean'),
      () => ({ type: 'boolean' }),
    );
  },

  literal<const T extends string | number | boolean>(expected: T): Schema<T> {
    return schema(
      'literal',
      (value, path) =>
        value === expected
          ? { ok: true, value: expected }
          : fail(path, `expected ${JSON.stringify(expected)}`),
      () => ({ const: expected }),
    );
  },

  /** A closed set of string values. */
  enum<const T extends readonly string[]>(values: T): Schema<T[number]> {
    const allowed = new Set<string>(values);
    return schema(
      'enum',
      (value, path) =>
        typeof value === 'string' && allowed.has(value)
          ? { ok: true, value: value as T[number] }
          : fail(path, `expected one of ${values.map((v) => JSON.stringify(v)).join(', ')}`),
      () => ({ type: 'string', enum: [...values] }),
    );
  },

  array<T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
    return schema('array', (value, path) => {
      if (!Array.isArray(value)) return fail(path, 'expected an array');
      if (options.min !== undefined && value.length < options.min) {
        return fail(path, `expected at least ${String(options.min)} item(s)`);
      }
      if (options.max !== undefined && value.length > options.max) {
        return fail(path, `expected at most ${String(options.max)} item(s)`);
      }
      const out: T[] = [];
      const issues: Issue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const outcome = item.check(value[index], [...path, index]);
        if (outcome.ok) out.push(outcome.value);
        else issues.push(...outcome.issues);
      }
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
    },
      () =>
        keywords({
          type: 'array',
          items: item.toJsonSchema(),
          minItems: options.min,
          maxItems: options.max,
        }),
    );
  },

  /**
   * An object with a fixed set of keys.
   *
   * Unknown keys are dropped rather than rejected: the value that reaches a
   * handler contains only what the schema named, so a property smuggled in by
   * a caller cannot reach application code by accident.
   */
  object<F extends Record<string, Schema<unknown>>>(fields: F): Schema<InferObject<F>> {
    const entries = Object.entries(fields);
    return schema('object', (value, path) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(path, 'expected an object');
      }
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const issues: Issue[] = [];
      for (const [key, field] of entries) {
        if (!(key in source) && field.kind === 'optional') continue;
        const outcome = field.check(source[key], [...path, key]);
        if (outcome.ok) {
          if (outcome.value !== undefined || key in source) out[key] = outcome.value;
        } else issues.push(...outcome.issues);
      }
      return issues.length > 0
        ? { ok: false, issues }
        : { ok: true, value: out as InferObject<F> };
    },
      () => ({
        type: 'object',
        properties: Object.fromEntries(entries.map(([key, field]) => [key, field.toJsonSchema()])),
        // An optional field is one the object may leave out, so optionality is
        // expressed here rather than inside the field's own schema.
        required: entries.filter(([, field]) => field.kind !== 'optional').map(([key]) => key),
        additionalProperties: false,
      }),
    );
  },

  /** A value that may be absent or `undefined`. */
  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    return schema<T | undefined>(
      'optional',
      (value, path) => (value === undefined ? { ok: true, value: undefined } : inner.check(value, path)),
      // JSON Schema has no "optional" keyword; the enclosing object omits the
      // key from `required` instead.
      () => inner.toJsonSchema(),
    );
  },

  /** A value that may be `null`. */
  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return schema<T | null>(
      'nullable',
      (value, path) => (value === null ? { ok: true, value: null } : inner.check(value, path)),
      () => ({ anyOf: [inner.toJsonSchema(), { type: 'null' }] }),
    );
  },

  /** Nothing at all. The input type of an operation that takes no argument. */
  void(): Schema<void> {
    return schema(
      'void',
      (value, path) =>
        value === undefined || value === null
          ? { ok: true, value: undefined }
          : fail(path, 'expected no value'),
      // A provider that asks for a tool's arguments wants an object, and an
      // operation that takes nothing takes an empty one.
      () => ({ type: 'object', properties: {}, additionalProperties: false }),
    );
  },

  /**
   * Any JSON value, unchecked.
   *
   * Use it for an output whose shape the host controls. Do not use it for an
   * operation input: the point of the input schema is that browser-supplied
   * data is untrusted.
   */
  unknown(): Schema<unknown> {
    return schema('unknown', (value) => ({ ok: true, value }), () => ({}));
  },
} as const;
