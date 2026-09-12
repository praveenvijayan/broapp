/**
 * This application, as an Autoapp release.
 *
 * Two exports and nothing else: `start` opens what the browser talks to, and
 * `migrate` moves a copy of the data forward without serving it. They are
 * separate because an activation migrates a *copy* while the release that is
 * running still owns the original, and a half-migrated copy must not be
 * reachable.
 *
 * This one registers no routes and opens no database, because the contract has
 * no routes and the manifest has no migrations. What the browser draws comes
 * from `views.ts` through the renderer's own routes, which `createAutoappHost`
 * mounts — so the page works with nothing here at all.
 *
 * When there is something to store: add a migration to `autoapp.json`, raise
 * `schemaVersion` to what the migrations reach, open the database in `start`,
 * and report the version it is at from both functions. Until then the honest
 * answer to "what version is this data at" is zero.
 *
 * The launcher never imports this file. A child process does, out of a built
 * release directory, and hands it the gate every call has to pass.
 */
import { createHostApp } from 'broapp/host';
import type { AppInstance, AppModule, AppStartContext } from 'broapp-autoapp/child';
import { createAutoappHost, createRunStore } from 'broapp-autoapp/host';
import { exportContract } from 'broapp-autoapp/spec';

import { contract } from '../shared/contract.ts';
import { views } from '../shared/views.ts';

/** The version the migrations reach. No migrations, so: none of them. */
export const latestSchemaVersion = 0;

export function start(context: AppStartContext): Promise<AppInstance> {
  const app = createHostApp(contract, { gate: context.gate, logger: context.logger });

  // Set once the bridge exists. A tab is attached when Brobridge says an
  // endpoint is open, and that is what decides whether there is anybody to ask
  // when an agent wants to write something.
  let attached: () => boolean = () => false;

  // The run store lives inside the data directory, so a preview records into
  // the copy it is previewing and the live process into the real one.
  const runs = createRunStore(context.dataDir, context.logger);
  runs.markUnknownOnStart();
  const autoapp = createAutoappHost({
    dataDir: context.dataDir,
    views,
    store: runs,
    contract: exportContract(contract),
    app,
    isAttached: () => attached(),
    // The child's approvals table, so a call from outside the tab queues where
    // the person is actually looking.
    ...(context.approvals === undefined ? {} : { approvals: context.approvals }),
    logger: context.logger,
  });

  return Promise.resolve({
    schemaVersion: latestSchemaVersion,
    register: (bridge) => {
      // Mounted even with no operations: it costs nothing, and the line that
      // registers this application's routes should be here before there are
      // any rather than be remembered when the first one is written.
      app.mount(bridge);
      autoapp.mount(bridge);
      attached = () => bridge.sessions.some((session) => session.endpoint.state === 'open');
    },
    // Handed over so the child runtime can forward a call from an MCP client
    // through the gate. The envelope is the child's, never the caller's.
    invoke: (route, input, envelope) => app.invoke(route as never, input, envelope),
    isBusy: () => app.activeStreams > 0,
    shutdown: () => {
      app.abortAll('the application is shutting down');
      runs.close();
    },
  });
}

export function migrate(_context: {
  dataDir: string;
  logger: AppStartContext['logger'];
}): Promise<{ from: number; to: number }> {
  // There is nothing to migrate and nowhere it could have come from, so both
  // ends of the report are zero. A real migration answers with the version it
  // found and the version it left behind.
  return Promise.resolve({ from: latestSchemaVersion, to: latestSchemaVersion });
}

/** Named so the shape is checked here rather than only at the child's import. */
export const appModule: AppModule = { start, migrate };
