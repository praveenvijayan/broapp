/**
 * Reading a specification somebody else wrote.
 *
 * A specification arrives from disk, from a candidate build, or from an AI
 * engineer's proposal, and none of those is trustworthy in the sense that
 * matters here: a shape that is almost right is worse than one that is plainly
 * wrong, because it survives long enough to be acted on. So everything is
 * checked, including the rules that are about relationships between fields
 * rather than about any one field — a migration chain with a hole in it, an
 * acceptance example naming a route that does not exist, a route that forgot
 * to say what it does.
 *
 * Two things the `s` validator does not do are done by hand. It has no record
 * type, and contracts are records. And it *drops* unknown keys rather than
 * refusing them, which is right for an operation input and wrong for a
 * capability: a field nobody read is a permission nobody granted.
 */
import { s, ValidationError } from 'broapp/shared';
import type { Issue, JsonSchema, Result, Schema } from 'broapp/shared';

import { parseViews } from '../views/validate.ts';
import type { ViewsSpec } from '../views/types.ts';

import {
  APP_ID_PATTERN,
  SPEC_VERSION,
  type AcceptanceExample,
  type AppSpec,
  type Capability,
  type ContractExport,
  type ExportedRoute,
  type Grants,
  type MigrationSpec,
} from './types.ts';

/**
 * Where in a value a failure happened.
 *
 * `broapp/shared` exports `Issue` but not the type of its `path`, and adding an
 * export to the core package for one alias is not worth the change.
 */
type Path = readonly (string | number)[];

/** Broapp's own route shape: `group.member`, exactly one dot. */
const ROUTE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
/** A release identity: the first 32 characters of a lowercase hex digest. */
const RELEASE_ID_PATTERN = /^[0-9a-f]{32}$/;
/** A migration identity: `NNN-slug`, so that lexical order is chronological. */
const MIGRATION_ID_PATTERN = /^[0-9]{3}-[a-z0-9-]+$/;
/** A hostname, lowercase, no scheme, with an optional leading wildcard label. */
const HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;
/** A path separator, either platform's. */
const SEPARATOR = /[\\/]/;
/** A Windows drive-letter prefix, which is absolute even without a leading slash. */
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/** Build a schema by hand, for the shapes `s` has no constructor for. */
function custom<T>(
  kind: string,
  check: (value: unknown, path: Path) => Result<T>,
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

function fail<T = never>(path: Path, message: string): Result<T> {
  return { ok: false, issues: [{ path, message }] };
}

/** An object whose keys are not known in advance and whose values share a schema. */
function record<T>(
  value: Schema<T>,
  keyPattern: RegExp,
  keyMessage: string,
): Schema<Record<string, T>> {
  const anchored = new RegExp(`^(?:${keyPattern.source})$`);
  return custom<Record<string, T>>(
    'record',
    (raw, path) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return fail(path, 'expected an object');
      }
      const out: Record<string, T> = {};
      const issues: Issue[] = [];
      for (const [key, member] of Object.entries(raw as Record<string, unknown>)) {
        if (!anchored.test(key)) {
          issues.push({ path: [...path, key], message: keyMessage });
          continue;
        }
        const outcome = value.check(member, [...path, key]);
        if (outcome.ok) out[key] = outcome.value;
        else issues.push(...outcome.issues);
      }
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
    },
    () => ({ type: 'object', additionalProperties: value.toJsonSchema() }),
  );
}

/** Any plain JSON object. A JSON Schema document is one, and nothing more is assumed. */
const jsonObject: Schema<JsonSchema> = custom<JsonSchema>(
  'json-object',
  (value, path) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ok: true, value: value as JsonSchema }
      : fail(path, 'expected an object'),
  () => ({ type: 'object' }),
);

/**
 * Refuse a key the schema does not name.
 *
 * `s.object` drops what it does not know, which is exactly right for an
 * operation's input and exactly wrong for a capability or a manifest: a field
 * that was silently discarded is one somebody wrote expecting it to mean
 * something.
 */
function closed<T>(inner: Schema<T>, allowed: readonly string[]): Schema<T> {
  return custom<T>(
    'closed',
    (value, path) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const extra = Object.keys(value as Record<string, unknown>).filter(
          (key) => !allowed.includes(key),
        );
        if (extra.length > 0) return fail(path, `unknown field ${JSON.stringify(extra[0])}`);
      }
      return inner.check(value, path);
    },
    () => inner.toJsonSchema(),
  );
}

const CAPABILITY_FIELDS = ['kind', 'paths', 'access', 'hosts', 'reason'] as const;

const capabilityShape = s.object({
  kind: s.enum(['files', 'network', 'spawn']),
  paths: s.optional(s.array(s.string({ min: 1, max: 4_096 }), { max: 200 })),
  access: s.optional(s.enum(['read', 'write'])),
  hosts: s.optional(s.array(s.string({ min: 1, max: 253, pattern: HOST_PATTERN }), { max: 200 })),
  reason: s.string({ min: 1, max: 400 }),
});

const capability = closed(capabilityShape, CAPABILITY_FIELDS) as unknown as Schema<Capability>;

const manifest = s.object({
  specVersion: s.number({ int: true, min: SPEC_VERSION, max: SPEC_VERSION }),
  appId: s.string({ pattern: APP_ID_PATTERN }),
  name: s.string({ min: 1, max: 200 }),
  releaseId: s.string({ pattern: RELEASE_ID_PATTERN }),
  createdAt: s.number({ int: true, min: 0 }),
  runtime: s.object({
    broapp: s.string({ min: 1, max: 40 }),
    autoapp: s.string({ min: 1, max: 40 }),
    bun: s.string({ min: 1, max: 40 }),
  }),
  entry: s.object({
    host: s.string({ min: 1, max: 400 }),
    page: s.string({ min: 1, max: 400 }),
  }),
  schemaVersion: s.number({ int: true, min: 0 }),
  capabilities: s.array(capability, { max: 100 }),
});

const exportedRoute = s.object({
  effect: s.enum(['read', 'write', 'external']),
  summary: s.string({ min: 1, max: 1_000 }),
  input: jsonObject,
  output: jsonObject,
}) as unknown as Schema<ExportedRoute>;

const contract = s.object({
  operations: record(exportedRoute, ROUTE_PATTERN, 'is not a "group.member" route name'),
  streams: record(exportedRoute, ROUTE_PATTERN, 'is not a "group.member" route name'),
}) as unknown as Schema<ContractExport>;

const migration = s.object({
  id: s.string({ pattern: MIGRATION_ID_PATTERN }),
  fromSchemaVersion: s.number({ int: true, min: 0 }),
  toSchemaVersion: s.number({ int: true, min: 1 }),
  checksum: s.string({ pattern: /[0-9a-f]{64}/ }),
  description: s.string({ min: 1, max: 400 }),
}) as unknown as Schema<MigrationSpec>;

const acceptance = s.object({
  id: s.string({ min: 1, max: 100 }),
  title: s.string({ min: 1, max: 200 }),
  steps: s.array(
    s.object({
      route: s.string({ pattern: ROUTE_PATTERN }),
      input: s.unknown(),
      expect: s.optional(s.unknown()),
    }),
    { min: 1, max: 100 },
  ),
}) as unknown as Schema<AcceptanceExample>;

/**
 * The view specification, validated by its own parser.
 *
 * It has structural rules of its own — a table pointing at a source that is not
 * on its page, a link to a page that does not exist — and restating them here
 * would be a second copy to keep in step. So the whole field is delegated, and
 * its issues are re-pathed under `views` so a caller still learns where the
 * failure was.
 */
const viewsField = custom<ViewsSpec>(
  'views',
  (value, path) => {
    try {
      return { ok: true, value: parseViews(value) };
    } catch (cause) {
      const issues = (cause as { issues?: Issue[] }).issues;
      if (issues === undefined) {
        return fail(path, cause instanceof Error ? cause.message : 'invalid view specification');
      }
      return { ok: false, issues: issues.map((issue) => ({ ...issue, path: [...path, ...issue.path] })) };
    }
  },
  () => ({ type: 'object' }),
);

const specShape = s.object({
  manifest,
  contract,
  views: viewsField,
  workflows: s.array(s.object({ id: s.string({ min: 1, max: 100 }) }), { max: 500 }),
  migrations: s.array(migration, { max: 1_000 }),
  acceptance: s.array(acceptance, { max: 500 }),
});

const grantsShape = s.object({
  appId: s.string({ pattern: APP_ID_PATTERN }),
  releaseId: s.string({ pattern: RELEASE_ID_PATTERN }),
  grantedAt: s.number({ int: true, min: 0 }),
  capabilities: s.array(capability, { max: 100 }),
});

/** What each kind of capability has to carry, and what it may not. */
function capabilityIssues(capabilities: readonly Capability[], at: Path): Issue[] {
  const issues: Issue[] = [];
  for (const [index, requested] of capabilities.entries()) {
    const path = [...at, index];
    const wants = requested.kind;
    if (wants === 'files' && (requested.paths === undefined || requested.paths.length === 0)) {
      issues.push({
        path: [...path, 'paths'],
        message: 'a files capability must name at least one path',
      });
    }
    if (wants === 'network' && (requested.hosts === undefined || requested.hosts.length === 0)) {
      issues.push({
        path: [...path, 'hosts'],
        message: 'a network capability must name at least one host',
      });
    }
    if (wants !== 'files' && requested.paths !== undefined) {
      issues.push({ path: [...path, 'paths'], message: `a ${wants} capability has no paths` });
    }
    if (wants !== 'network' && requested.hosts !== undefined) {
      issues.push({ path: [...path, 'hosts'], message: `a ${wants} capability has no hosts` });
    }
  }
  return issues;
}

/** Everything that is about more than one field, checked after the shapes hold. */
function crossCheck(spec: AppSpec): Issue[] {
  const issues: Issue[] = [];

  for (const [field, value] of [
    ['host', spec.manifest.entry.host],
    ['page', spec.manifest.entry.page],
  ] as const) {
    // A release directory is the unit of immutability. An entry that can point
    // outside it — absolutely, or by climbing — is not part of the release, it
    // is a reference to something that may have changed since.
    if (value.startsWith('/') || DRIVE_PREFIX.test(value)) {
      issues.push({ path: ['manifest', 'entry', field], message: 'must be a relative path' });
    } else if (value.split(SEPARATOR).includes('..')) {
      issues.push({
        path: ['manifest', 'entry', field],
        message: 'must not contain a ".." segment',
      });
    }
  }

  for (const [table, routes] of [
    ['operations', spec.contract.operations],
    ['streams', spec.contract.streams],
  ] as const) {
    for (const [route, exported] of Object.entries(routes)) {
      // The default core Broapp applies to a route with no effect — treat it as
      // `write` — is a kindness to contracts written before effects existed. An
      // Autoapp release has no such history and does not get it.
      if (exported.effect === undefined) {
        issues.push({
          path: ['contract', table, route],
          message: `route ${JSON.stringify(route)} must declare an effect`,
        });
      }
    }
  }

  const ids = spec.migrations.map((step) => step.id);
  if (ids.join(' ') !== [...ids].sort().join(' ')) {
    issues.push({ path: ['migrations'], message: 'must be sorted by id' });
  }
  let reached = 0;
  for (const [index, step] of spec.migrations.entries()) {
    if (step.fromSchemaVersion !== reached) {
      issues.push({
        path: ['migrations', index, 'fromSchemaVersion'],
        message: `expected ${String(reached)}, so the chain has no gap`,
      });
    }
    if (step.toSchemaVersion !== step.fromSchemaVersion + 1) {
      issues.push({
        path: ['migrations', index, 'toSchemaVersion'],
        message: 'must be exactly one more than fromSchemaVersion',
      });
    }
    reached = step.toSchemaVersion;
  }
  if (reached !== spec.manifest.schemaVersion) {
    issues.push({
      path: ['manifest', 'schemaVersion'],
      message: `expected ${String(reached)}, the version the migrations reach`,
    });
  }

  for (const [index, example] of spec.acceptance.entries()) {
    for (const [step, call] of example.steps.entries()) {
      if (!Object.prototype.hasOwnProperty.call(spec.contract.operations, call.route)) {
        issues.push({
          path: ['acceptance', index, 'steps', step, 'route'],
          message: `route ${JSON.stringify(call.route)} is not an operation in this contract`,
        });
      }
    }
  }

  issues.push(...capabilityIssues(spec.manifest.capabilities, ['manifest', 'capabilities']));
  return issues;
}

/** Validate one specification. Throws `ValidationError` naming the first failure. */
export function parseSpec(raw: unknown): AppSpec {
  const spec = specShape.parse(raw) as unknown as AppSpec;
  const issues = crossCheck(spec);
  if (issues.length > 0) throw new ValidationError(issues);
  return spec;
}

/** Validate one grants file. */
export function parseGrants(raw: unknown): Grants {
  const grants = grantsShape.parse(raw) as unknown as Grants;
  const issues = capabilityIssues(grants.capabilities, ['capabilities']);
  if (issues.length > 0) throw new ValidationError(issues);
  return grants;
}
