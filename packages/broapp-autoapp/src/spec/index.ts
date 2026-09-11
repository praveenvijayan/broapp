/**
 * `broapp-autoapp/spec` — what an application is, without running it.
 *
 * Everything here is data and functions over data. Nothing in this entry point
 * starts a process, opens a bridge or imports application code, which is what
 * makes it safe for the launcher, the engineer and the MCP adapter to read a
 * release they have not decided to run yet.
 */
export { APP_ID_PATTERN, SPEC_VERSION } from './types.ts';
export type {
  AcceptanceExample,
  AcceptanceStep,
  RouteStep,
  ViewStep,
  AppManifest,
  AppSpec,
  Capability,
  CapabilityDiff,
  ContractExport,
  ExportedRoute,
  Grants,
  MigrationSpec,
} from './types.ts';

export { parseGrants, parseSpec } from './validate.ts';

export { exportContract } from './export-contract.ts';

export { canonicalJson, releaseId, stripIdentity } from './release-id.ts';
export type { ReleaseParts } from './release-id.ts';

export { defaultRoot, layout } from './layout.ts';
export type { AppLayout, Layout } from './layout.ts';

export {
  listReleases,
  readCurrent,
  readRelease,
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
export { isViewStep } from './types.ts';
