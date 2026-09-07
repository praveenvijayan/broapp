/**
 * Checking views that include Autoapp's own routes.
 *
 * A release's view specification only ever names the application's routes, and
 * `writeRelease` checks it against the application's contract. A *person's*
 * views can name one more thing: a promoted workflow's button calls
 * `autoapp.workflowRun`, which is Autoapp's route and not the application's. So
 * anything validating views with additions applied needs both tables.
 *
 * Deliberately one-directional. A workflow's own steps are checked against the
 * application's contract *without* this, and run through the application's own
 * `HostApp` — so a workflow step cannot name `autoapp.approvalsAnswer` and
 * approve itself. That is a structural impossibility rather than a rule, and it
 * should stay one.
 */
import { exportContract } from '../spec/export-contract.ts';
import type { ContractExport } from '../spec/types.ts';

import { autoappContract } from '../shared/contract.ts';

/** Autoapp's own routes, in the portable form. Computed once. */
let cached: ContractExport | null = null;

/** The exported form of `autoappContract`. */
export function autoappContractExport(): ContractExport {
  cached ??= exportContract(autoappContract);
  return cached;
}

/** An application's routes plus Autoapp's, for validating views with additions. */
export function withAutoappRoutes(exported: ContractExport): ContractExport {
  const autoapp = autoappContractExport();
  return {
    operations: { ...exported.operations, ...autoapp.operations },
    streams: { ...exported.streams, ...autoapp.streams },
  };
}
