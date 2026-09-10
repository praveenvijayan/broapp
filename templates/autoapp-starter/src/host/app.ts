/**
 * This application, as an Autoapp release.
 *
 * Two exports and nothing else: `start` opens the data and prepares the
 * handlers, `migrate` moves a copy of the data forward without serving it.
 * They are separate because an activation migrates a *copy* while the release
 * that is running still owns the original, and a half-migrated copy must not
 * be reachable.
 *
 * The launcher never imports this file. A child process does, out of a built
 * release directory, and hands it the gate every call has to pass.
 */
import { createHostApp, publicError } from 'broapp/host';
import type { AppInstance, AppModule, AppStartContext } from 'broapp-autoapp/child';
import { createAutoappHost, createRunStore } from 'broapp-autoapp/host';
import { exportContract } from 'broapp-autoapp/spec';

import { contract } from '../shared/contract.ts';
import { views } from '../shared/views.ts';

import { latestSchemaVersion, openStore, readSchemaVersion } from './db.ts';

export function start(context: AppStartContext): Promise<AppInstance> {
  const store = openStore(context.dataDir);
  const app = createHostApp(contract, { gate: context.gate, logger: context.logger });

  app.operation('items.list', () => {
    const items = store.list();
    return { items, count: items.length };
  });
  app.operation('items.add', ({ label, note }) => store.add(label, note ?? ''));
  app.operation('items.update', ({ id, label, note, done }) => {
    const updated = store.update(id, { label, note, done });
    // `not_found` rather than a silent success: a person who asked to change
    // something that is gone should be told, not shown an unchanged list.
    if (updated === null) throw publicError.notFound(`There is no item ${String(id)}.`);
    return updated;
  });
  app.operation('items.remove', ({ id }) => ({ removed: store.remove(id) }));
  app.operation('items.status', () => {
    const counted = store.count();
    return {
      count: counted.count,
      done: counted.done,
      schemaVersion: store.schemaVersion,
      healthy: store.healthy(),
    };
  });

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
    schemaVersion: store.schemaVersion,
    register: (bridge) => {
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
      store.close();
    },
  });
}

export function migrate(context: {
  dataDir: string;
  logger: AppStartContext['logger'];
}): Promise<{ from: number; to: number }> {
  const from = readSchemaVersion(context.dataDir);
  const store = openStore(context.dataDir);
  try {
    return Promise.resolve({ from, to: store.schemaVersion });
  } finally {
    store.close();
  }
}

/** Named so the shape is checked here rather than only at the child's import. */
export const appModule: AppModule = { start, migrate };

export { latestSchemaVersion };
