/**
 * The fixture as an Autoapp application module.
 *
 * The same two exports any release has. `items.ping` is the interesting one:
 * it declares `effect: 'external'` and does nothing at all, so a test can prove
 * that `preview` refuses it without the test having to reach a network.
 */
import { createHostApp } from 'broapp/host';
import type { AppInstance, AppModule, AppStartContext } from 'broapp-autoapp/child';
import { createAutoappHost, createRunStore } from 'broapp-autoapp/host';
import { exportContract } from 'broapp-autoapp/spec';

import { contract } from '../shared/contract.ts';
import { views } from '../shared/views.ts';

import { latestSchemaVersion, openStore, readSchemaVersion } from './db.ts';

export function start(context: AppStartContext): Promise<AppInstance> {
  const store = openStore(context.dataDir);
  const app = createHostApp(contract, { gate: context.gate, logger: context.logger });

  app.operation('items.list', () => ({ items: store.list(), count: store.count() }));
  app.operation('items.add', ({ label }) => store.add(label));
  // Declared `external` and deliberately inert. What is under test is the
  // gate's answer, not anything this does.
  app.operation('items.ping', () => ({ ok: true }));
  app.stream('items.watch', async ({ everyMs }, sink) => {
    // Never ends on its own: the test that proves a drain can time out needs
    // something that is genuinely still busy when the deadline passes.
    for (let n = 1; !sink.signal.aborted; n += 1) {
      await sink.emit({ n });
      await Bun.sleep(everyMs);
    }
  });

  // Set once the bridge exists. A tab is attached when Brobridge says an
  // endpoint is open; a real application reads the same thing off `RunningApp`.
  let attached: () => boolean = () => false;

  // The run store lives inside the data directory, so a preview child records
  // into the copy it is previewing and a live child into the real one.
  const runs = createRunStore(context.dataDir, context.logger);
  runs.markUnknownOnStart();
  const autoapp = createAutoappHost({
    dataDir: context.dataDir,
    views,
    store: runs,
    contract: exportContract(contract),
    app,
    isAttached: () => attached(),
    // The child's table, so an MCP call queues where the tab is looking.
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
    // Handed over so the child runtime can forward an MCP call through the
    // gate. The envelope is the child's, never the caller's.
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
export const fixtureModule: AppModule = { start, migrate };

/** Exported for the tests that build a release at a chosen schema version. */
export { latestSchemaVersion };
