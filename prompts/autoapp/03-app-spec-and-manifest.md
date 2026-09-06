# 03 — The application specification and manifest

## Goal

An Autoapp application is described by a versioned specification the
launcher, the renderer, the engineer and the MCP adapter can all read
without running application code. After this prompt: the specification
types exist, a contract can be exported to portable JSON, a release
identity can be computed, a release directory can be written and read back,
the `current` pointer is switched atomically, and requested capabilities
can be compared with granted ones.

Views and workflows are referenced here but defined by prompts 04 and 06.
This prompt stores them as validated-for-shape objects and nothing more.

## Read first

- `prompts/autoapp/00-common-rules.md` and both reports so far.
- `packages/broapp/src/shared/schema.ts`, completely: the `s` validator, `toJsonSchema`, `JsonSchema`, `ValidationError`. Note there are no unions; discriminated shapes use a `kind` field plus optional fields, as `ChatEvent` does.
- `packages/broapp/src/shared/contract.ts` after prompt 01 (`Effect`, `effectOf`).
- `packages/broapp/src/host/paths.ts` (`ensureDataDir`).
- `packages/broapp-autoapp/src/ipc/messages.ts` from prompt 02.
- `examples/notes/src/shared/contract.ts`.
- `node_modules/bun-types/bun.d.ts`: search `Bun.write(`, `Bun.file(`. `node:fs`: `renameSync`, `mkdtempSync`, `openSync` with `O_EXCL` are ordinary Node APIs.

## Files to create

Under `packages/broapp-autoapp/src/spec/`:

```
types.ts          every interface below
validate.ts       parseSpec(raw): AppSpec — s-validator schemas; throws ValidationError
export-contract.ts exportContract(contract): ContractExport
release-id.ts     releaseId(parts): string
layout.ts         paths for <root> and apps
store.ts          readRelease, writeRelease, listReleases, readCurrent, setCurrent
capabilities.ts   diffCapabilities(requested, granted), readGrants, writeGrants
index.ts          exports
```

Add `"./spec": "./src/spec/index.ts"` to the package `exports`.

## Step 1 — types

```ts
import type { Effect } from 'broapp/shared';
import type { JsonSchema } from 'broapp/shared';   // confirm it is exported; if not, export it from packages/broapp/src/shared/index.ts and name that change in the report

export const SPEC_VERSION = 1 as const;

/** Lowercase letters, digits and hyphens, 3 to 40 characters, starts with a letter. */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;

export interface AppManifest {
  readonly specVersion: typeof SPEC_VERSION;
  readonly appId: string;
  readonly name: string;
  readonly releaseId: string;
  readonly createdAt: number;
  /** Versions this release was built with. Informational; the launcher refuses a release whose `autoapp` major differs from its own. */
  readonly runtime: { readonly broapp: string; readonly autoapp: string; readonly bun: string };
  /** Paths relative to the release directory. */
  readonly entry: { readonly host: string; readonly page: string };
  /** The database schema version this release's migrations reach. */
  readonly schemaVersion: number;
  readonly capabilities: readonly Capability[];
}

/**
 * One requested capability. Flat with a `kind`, because the validator has no
 * unions. `data` is implied for every application and never listed.
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

export interface ExportedRoute {
  readonly effect: Effect;
  readonly summary: string;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

export interface ContractExport {
  readonly operations: Readonly<Record<string, ExportedRoute>>;
  readonly streams: Readonly<Record<string, ExportedRoute>>;   // `input` is the params schema, `output` the event schema
}

export interface MigrationSpec {
  /** `NNN-slug`, ordered lexically. */
  readonly id: string;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  /** sha256 hex of the migration's SQL or code, so a release cannot silently change a migration that already ran. */
  readonly checksum: string;
  readonly description: string;
}

export interface AcceptanceStep {
  readonly route: string;
  readonly input: unknown;
  /** A JSON value the output must deep-equal, or absent to require only success. */
  readonly expect?: unknown;
}

export interface AcceptanceExample {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly AcceptanceStep[];
}

export interface AppSpec {
  readonly manifest: AppManifest;
  readonly contract: ContractExport;
  /** Defined by prompt 04. Here: an object with `specVersion: 1` and `pages: unknown[]`. */
  readonly views: { readonly specVersion: 1; readonly pages: readonly unknown[] };
  /** Defined by prompt 06. Here: an array of objects each with a string `id`. */
  readonly workflows: readonly { readonly id: string }[];
  readonly migrations: readonly MigrationSpec[];
  readonly acceptance: readonly AcceptanceExample[];
}

export interface Grants {
  readonly appId: string;
  /** The release the person was looking at when they granted. */
  readonly releaseId: string;
  readonly grantedAt: number;
  readonly capabilities: readonly Capability[];
}

export interface CapabilityDiff {
  readonly added: readonly Capability[];
  readonly removed: readonly Capability[];
  readonly unchanged: readonly Capability[];
}
```

## Step 2 — validation

`validate.ts` builds `s` schemas for every type above and exports
`parseSpec(raw: unknown): AppSpec`. Rules beyond shape:

- `manifest.appId` matches `APP_ID_PATTERN`.
- `manifest.releaseId` is 32 lowercase hex characters.
- `manifest.entry.host` and `.page` are relative, contain no `..` segment, and are not absolute.
- Every route in `contract` matches Broapp's route pattern (one dot). Every route has an `effect`; this is where a missing effect is refused, with a message naming the route.
- `migrations` are sorted by `id`, each `toSchemaVersion === fromSchemaVersion + 1`, the chain is contiguous from 0, and the last `toSchemaVersion` equals `manifest.schemaVersion`. Empty `migrations` requires `schemaVersion: 0`.
- Every `acceptance[].steps[].route` exists in `contract.operations`.
- `capabilities`: `files` requires `paths` non-empty; `network` requires `hosts` non-empty and each host matches `/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/`; `spawn` has neither. Unknown extra fields are refused.

Error messages follow `ValidationError`'s existing style.

## Step 3 — export and identity

`exportContract(contract: AnyContract): ContractExport`: for every
operation and stream, `effectOf(spec)` **but** throw `TypeError` when
`spec.effect` is undefined (an Autoapp release must be explicit), and throw
when `summary` is missing or empty. Use `toJsonSchema()` on each validator;
throw naming the route if the validator lacks it.

`releaseId({ page, host, contract }: { page: Uint8Array; host: Uint8Array; contract: ContractExport }): string`:
sha256 over, in order: the bytes of `page`, a single `0x00`, the bytes of
`host`, a single `0x00`, the UTF-8 of `JSON.stringify` of the contract with
object keys sorted at every depth. Hex, lowercase, first 32 characters.
Export the canonical-JSON helper as `canonicalJson(value): string` and reuse
`argumentsHash` from `broapp/host` where the hashing is the same; do not
write a second sorter if one is importable.

## Step 4 — layout and store

`layout.ts`:

```ts
export interface Layout {
  readonly root: string;
  app(appId: string): AppLayout;
  readonly journal: string;       // <root>/journal.sqlite
  readonly control: string;       // <root>/launcher.json
}
export interface AppLayout {
  readonly dir: string;
  readonly releases: string;
  release(releaseId: string): string;
  readonly source: string;
  readonly data: string;
  readonly dataNext: string;
  dataPrev(timestamp: number): string;
  readonly snapshots: string;
  readonly current: string;       // the pointer file
  readonly grants: string;        // <app>/grants.json
}
export function layout(root: string): Layout;
export function defaultRoot(env?: NodeJS.ProcessEnv): string;   // ensureDataDir('broapp-autoapp', env) + '/autoapp'
```

`store.ts`:

- `writeRelease(layout, spec, files: { page: Uint8Array; host: Uint8Array })`:
  refuses if the release directory exists (`conflict`), writes into a
  temporary sibling directory, then renames it into place. Files:
  `spec.json` (pretty, 2 spaces, trailing newline), `page.html`, `host.js`.
  Verifies `releaseId` recomputes from what was written before renaming.
- `readRelease(layout, appId, releaseId): AppSpec` parses `spec.json`
  through `parseSpec` and verifies the directory name equals
  `manifest.releaseId`.
- `listReleases(layout, appId): readonly { releaseId; createdAt }[]`, newest first.
- `readCurrent(layout, appId): string | null`.
- `setCurrent(layout, appId, releaseId)`: refuses if the release directory
  does not exist; writes `current.tmp` then `renameSync` over `current`.
  Atomic on POSIX; on Windows `renameSync` over an existing file also
  replaces, but note the platform in a comment and in prompt 09's list.

Every write goes under the app directory only; assert every resolved path
starts with the app directory, as a guard against a bad `appId` even though
the pattern already forbids separators.

## Step 5 — capabilities

`capabilities.ts`:

- `capabilityKey(c: Capability): string` — a canonical string
  (`files:write:/a,/b`, `network:api.example.com,*.x.y`, `spawn`), with
  paths and hosts sorted. `reason` is not part of the key.
- `diffCapabilities(requested, granted): CapabilityDiff` by key.
- `readGrants(layout, appId): Grants | null`; `writeGrants(layout, appId, grants)` atomic as above.
- `isGranted(diff): boolean` is `diff.added.length === 0`.

## Step 6 — tests

`tests/autoapp-spec.test.ts`:

1. A minimal valid spec round-trips through `parseSpec`.
2. Each rule in Step 2 has one failing input and the error names the field or route.
3. `exportContract(notesContract)` (import from `examples/notes/src/shared/contract.ts`) yields six operations with the effects prompt 01 set, and JSON Schema for every input and output.
4. `exportContract` of a contract with a route lacking `effect` throws naming the route.
5. `releaseId` is deterministic, 32 lowercase hex, changes when one byte of the page changes, and is unaffected by key order in the contract object.
6. `writeRelease` then `readRelease` round-trips; a second `writeRelease` of the same id throws `conflict`; a partially written temp directory left from a simulated crash (create the temp dir by hand) does not block a fresh write.
7. `setCurrent` refuses an unknown release; after a valid call `readCurrent` returns it; the pointer survives a simulated crash between writing `current.tmp` and the rename (leave a stale `current.tmp` behind and confirm the next `setCurrent` succeeds).
8. `diffCapabilities`: added, removed, unchanged; `reason` differences are `unchanged`; path order differences are `unchanged`.
9. `layout(root).app('bad id')` throws.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-spec.test.ts
bun run check
```

## Acceptance criteria

- A release can be described, written, read and pointed at without running any application code.
- A route without an explicit `effect` cannot enter an Autoapp release.
- Every disk write is atomic or refused; no test leaves a half-written directory that a later call cannot recover from.

## Report

`prompts/autoapp/reports/03-spec.md`.

## Commit

```
Add the Autoapp application specification and release store

A versioned specification describes an application without running it:
manifest, exported contract with effects, migrations, acceptance
examples, requested capabilities. Releases are immutable directories
named by a content hash; the current pointer switches atomically.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
