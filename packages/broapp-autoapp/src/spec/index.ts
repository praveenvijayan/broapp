/**
 * `broapp-autoapp/spec` — what an application is, without running it.
 *
 * Everything here is data and functions over data. Nothing in this entry point
 * starts a process, opens a bridge or imports application code, which is what
 * makes it safe for the launcher, the engineer and the MCP adapter to read a
 * release they have not decided to run yet.
 */
export { APP_ID_PATTERN, MATCHER_KINDS, REFUSAL_CODES, SPEC_VERSION } from './types.ts';
export type {
  AcceptanceExample,
  AcceptanceStep,
  Matcher,
  MatcherKind,
  RefusalAssertion,
  RouteStep,
  ViewStep,
  AppManifest,
  AppSpec,
  BuildProblem,
  Capability,
  CapabilityDiff,
  ContractExport,
  ExportedRoute,
  Grants,
  MigrationSpec,
} from './types.ts';

export { parseGrants, parseSpec } from './validate.ts';

export { examplesOnExternal, externalRoutes, releaseProblems } from './release-problems.ts';

export { exportContract } from './export-contract.ts';

export { canonicalJson, releaseId, stripIdentity } from './release-id.ts';
export type { ReleaseParts } from './release-id.ts';

export { defaultRoot, isWithin, layout, LOCATION_VERSION } from './layout.ts';
export type { AppLayout, Layout, SourceLocation } from './layout.ts';

export {
  listReleases,
  readCurrent,
  readRelease,
  releasePageBytes,
  setCurrent,
  writeRelease,
} from './store.ts';
export type { ReleaseFiles, ReleaseSummary } from './store.ts';

export {
  capabilityKey,
  diffCapabilities,
  isGranted,
  readGrants,
  writeGrants,
} from './capabilities.ts';
export { hasKind, isMatcher, isViewStep } from './types.ts';
