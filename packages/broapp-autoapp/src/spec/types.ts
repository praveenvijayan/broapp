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
import type { Effect, JsonSchema } from 'broapp/shared';

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

/** One call in an acceptance example. */
export interface AcceptanceStep {
  readonly route: string;
  readonly input: unknown;
  /** A JSON value the output must deep-equal, or absent to require only success. */
  readonly expect?: unknown;
  /**
   * A JSON value the output must contain: every key it names must match, an
   * array must have the same length and match element by element, and anything
   * else must be equal. For outputs that carry values an example cannot know in
   * advance, such as timestamps and ids, so a step can still say what must be
   * there.
   */
  readonly match?: unknown;
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
