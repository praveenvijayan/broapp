/**
 * `broapp-autoapp/host` — the host-side runtime an application mounts.
 *
 * Never import this from browser code. It reaches `node:fs` and `bun:sqlite`,
 * and a bundler that followed the import would fail loudly, which is the
 * intended outcome.
 */
export { attachedOnly, createAutoappHost } from './autoapp.ts';
export type { AutoappHost, CreateAutoappHostOptions } from './autoapp.ts';

export { createRunStore, redact, runIdOf } from './run-store.ts';
export type {
  RunStep,
  RunStore,
  RunSummary,
  SavedWorkflow,
  WorkflowSummary,
} from './run-store.ts';
