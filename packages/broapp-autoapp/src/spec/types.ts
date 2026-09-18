/**
 * What an Autoapp application is, as data.
 *
 * The specification is the one description the launcher, the renderer, the
 * engineer and the MCP adapter all read — and every one of them reads it
 * *without running the application*. That is the property worth protecting:
 * deciding whether to build a release, what it may reach, and what it is going
 * to do to the database must not require executing the code being decided
 * about.
 *
 * The shapes are flat, with a `kind` discriminant where a union would be
 * natural, because the `s` validator has no unions. `ChatEvent` in the AI layer
 * has the same shape for the same reason.
 */
import { publicError } from 'broapp/shared';
import type { Effect, JsonSchema, PublicErrorCode } from 'broapp/shared';

import type { ViewsSpec } from '../views/types.ts';

/** The only specification version there is. */
export const SPEC_VERSION = 1 as const;

/** Lowercase letters, digits and hyphens, 3 to 40 characters, starts with a letter. */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;

/** What one release of one application is. */
export interface AppManifest {
  readonly specVersion: typeof SPEC_VERSION;
  readonly appId: string;
  readonly name: string;
  readonly releaseId: string;
  readonly createdAt: number;
  /**
   * Versions this release was built with. Informational; the launcher refuses a
   * release whose `autoapp` major differs from its own.
   */
  readonly runtime: { readonly broapp: string; readonly autoapp: string; readonly bun: string };
  /** Paths relative to the release directory. */
  readonly entry: { readonly host: string; readonly page: string };
  /** The database schema version this release's migrations reach. */
  readonly schemaVersion: number;
  readonly capabilities: readonly Capability[];
}

/**
 * One requested capability.
 *
 * `data` is implied for every application and never listed: an application that
 * could not touch its own data directory would not be an application. What is
 * listed is everything beyond it, which is also everything a person has to be
 * asked about.
 */
export interface Capability {
  readonly kind: 'files' | 'network' | 'spawn';
  /** `files`: absolute paths or paths starting with `~/`. */
  readonly paths?: readonly string[];
  /** `files`: default 'read'. */
  readonly access?: 'read' | 'write';
  /** `network`: hostnames, lowercase, no scheme, optional leading `*.`. */
  readonly hosts?: readonly string[];
  /** Why the application wants it, shown to the person who grants it. One sentence. */
  readonly reason: string;
}

/** One route, as everything outside the host sees it. */
export interface ExportedRoute {
  readonly effect: Effect;
  readonly summary: string;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

/**
 * A contract in portable JSON.
 *
 * For a stream, `input` is the params schema and `output` the event schema.
 * They are not named that way because everything that reads this — a tool
 * description, a documentation page, an MCP listing — wants one vocabulary.
 */
export interface ContractExport {
  readonly operations: Readonly<Record<string, ExportedRoute>>;
  readonly streams: Readonly<Record<string, ExportedRoute>>;
}

/** One forward step of the database schema. */
export interface MigrationSpec {
  /** `NNN-slug`, ordered lexically. */
  readonly id: string;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  /**
   * sha256 hex of the migration's SQL or code.
   *
   * A migration that has already run against somebody's data is history. The
   * checksum is what makes a release unable to quietly rewrite it.
   */
  readonly checksum: string;
  readonly description: string;
}

/** One call in an acceptance example: a route on the running application. */
export interface RouteStep {
  readonly route: string;
  readonly input: unknown;
  /** A JSON value the output must deep-equal, or absent to require only success. */
  readonly expect?: unknown;
  /**
   * A JSON value the output must contain: every key it names must match, an
   * array must have the same length and match element by element, and anything
   * else must be equal. For outputs that carry values an example cannot know in
   * advance, such as timestamps and ids, so a step can still say what must be
   * there: leave the key out, or say its kind with a {@link Matcher}.
   */
  readonly match?: unknown;
  /**
   * The route must refuse, rather than succeed. `code`, when given, is the
   * public error's code; `message`, when given, is contained in its message.
   * `{}` asserts only that it refuses. A crash is never a refusal. A step with
   * `fails` carries neither `expect` nor `match`.
   */
  readonly fails?: RefusalAssertion;
}

/**
 * The codes a route refuses with: every public code but `internal`, which is
 * what a crash becomes and never a refusal.
 *
 * Read from `broapp/shared`'s own constructors rather than typed out a second
 * time, so a code added there is a code an example may name here.
 */
export const REFUSAL_CODES: readonly PublicErrorCode[] = Object.values(publicError).map((make) => make('').code);

/** What a refusing route step asserts about the refusal. */
export interface RefusalAssertion {
  readonly code?: string;
  readonly message?: string;
}

/**
 * The kinds a {@link Matcher} may name, and nothing else.
 *
 * No ranges, patterns, lengths or "non-empty": each of those is a way for an
 * example to pass on the wrong output. The list grows when a real task needs
 * it, which is why every other `$` key is reserved rather than ignored.
 */
export const MATCHER_KINDS = ['string', 'number', 'boolean', 'array', 'object', 'null', 'any'] as const;
export type MatcherKind = (typeof MATCHER_KINDS)[number];

/**
 * Inside a `match`, `{ "$is": "number" }` stands for "this key is there and
 * holds a finite number", whatever the number is. Under `expect` it is a
 * literal object like any other.
 */
export interface Matcher {
  readonly $is: MatcherKind;
}

/**
 * One assertion about the view specification: that a page or a component is
 * declared, or is not, and what it declares.
 *
 * It proves the specification and nothing else. A route step shows what the
 * host does; a view step shows what the page is told to draw; neither renders
 * a page in a browser, and a check that ran both has still not seen one.
 */
export interface ViewStep {
  readonly view: {
    readonly page: string;
    /** A component id anywhere on the page. Absent, the assertion is about the page. */
    readonly component?: string;
    /** Default true. `false` asserts that the page or the component is not declared. */
    readonly exists?: boolean;
    /** What the page or the component must contain, compared the way `match` is. */
    readonly match?: unknown;
  };
}

export type AcceptanceStep = RouteStep | ViewStep;

/** Whether a step is about the view specification rather than a route. */
export function isViewStep(step: AcceptanceStep): step is ViewStep {
  return 'view' in step && step.view !== undefined;
}

/** Whether a value inside a `match` is a matcher: an object whose one key is `$is`, naming a known kind. */
export function isMatcher(value: unknown): value is Matcher {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const kind: unknown = (value as { $is?: unknown }).$is;
  return keys.length === 1 && keys[0] === '$is' && (MATCHER_KINDS as readonly unknown[]).includes(kind);
}

/**
 * Whether a present value is of a matcher's kind. `number` is a finite number,
 * because a `NaN` or an `Infinity` in an output is a bug an example should see;
 * `object` is a plain object, not an array and not `null`; `any` is anything,
 * `null` included.
 */
export function hasKind(value: unknown, kind: MatcherKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    case 'any':
      return true;
  }
}

/** Something the application is supposed to be able to do, written down. */
export interface AcceptanceExample {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly AcceptanceStep[];
}

/** The whole description of one release. */
export interface AppSpec {
  readonly manifest: AppManifest;
  readonly contract: ContractExport;
  /** The interface this release draws, validated by `parseViews`. */
  readonly views: ViewsSpec;
  /** Defined by prompt 06. Validated here for shape only. */
  readonly workflows: readonly { readonly id: string }[];
  readonly migrations: readonly MigrationSpec[];
  readonly acceptance: readonly AcceptanceExample[];
}

/** What a person allowed, and what they were looking at when they allowed it. */
export interface Grants {
  readonly appId: string;
  /** The release the person was looking at when they granted. */
  readonly releaseId: string;
  readonly grantedAt: number;
  readonly capabilities: readonly Capability[];
}

/** What changed between what is asked for and what was allowed. */
export interface CapabilityDiff {
  readonly added: readonly Capability[];
  readonly removed: readonly Capability[];
  readonly unchanged: readonly Capability[];
}
