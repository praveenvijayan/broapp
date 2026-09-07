/**
 * Notes as an Autoapp application module.
 *
 * Two functions and no process. Everything about *being* a process — parsing
 * arguments, choosing a data directory, opening a bridge, deciding when to
 * exit — belongs to whoever is running this: the standalone binary in
 * `main.ts`, or Autoapp's child runtime. What is left here is the application,
 * which is the part that would otherwise be duplicated between the two.
 *
 * The gate arrives in the context rather than being made here. That is the
 * whole point: a preview child hands over a gate in `preview` mode, and an
 * activation hands over one that is paused, and the application does not have
 * to know that either of those is happening.
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { AppInstance, AppModule, AppStartContext } from 'broapp-autoapp/child';
import { createAutoappHost, createRunStore } from 'broapp-autoapp/host';
import { exportContract } from 'broapp-autoapp/spec';

import { contract } from '../shared/contract.ts';
import { notesViews } from '../shared/views.ts';

import { createNotesAi } from './ai.ts';
import { openStore } from './db.ts';
import { createApp, type StoreState } from './operations.ts';

/**
 * Open the database, or carry the reason it could not be opened.
 *
 * A corrupt database must not stop the application from starting: somebody in
 * that position needs to be told where the file is so they can move it aside,
 * and they cannot be told by an application that refused to run.
 */
export function openState(
  dataDir: string,
  logger: AppStartContext['logger'],
): StoreState {
  try {
    return { ok: true, store: openStore(dataDir) };
  } catch (cause) {
    logger.error(
      `could not open the notes database: ${String(cause instanceof Error ? cause.message : cause)}`,
    );
    return { ok: false, path: join(dataDir, 'notes.sqlite'), reason: 'could not be opened' };
  }
}

/** Build everything that mounts on a bridge, given an open (or unopenable) store. */
export function assemble(state: StoreState, context: AppStartContext): AppInstance {
  const app = createApp(state, context.gate);

  // Set once the bridge exists. An agent asking permission when no tab is open
  // is asking a question nobody will see, and the approver refuses at once.
  let attached: () => boolean = () => false;

  // The history of what agents did, inside the data directory — so a preview
  // child records into the copy it is previewing.
  const runs = createRunStore(context.dataDir, context.logger);
  runs.markUnknownOnStart();

  const autoapp = createAutoappHost({
    dataDir: context.dataDir,
    views: notesViews,
    store: runs,
    contract: exportContract(contract),
    app,
    isAttached: () => attached(),
    // The child's table, so an MCP call queues where the tab is looking.
    ...(context.approvals === undefined ? {} : { approvals: context.approvals }),
    logger: context.logger,
  });

  // Built unconditionally and costs nothing until somebody chooses a provider:
  // no key, no provider, no requests. `onRunEnd` is what closes the record the
  // gate has been writing steps into for this turn.
  const ai = createNotesAi(app, state, context.dataDir, (runId, status, summary) =>
    runs.finishRun(runId, status, summary),
  );

  return {
    schemaVersion: state.ok ? state.store.schemaVersion : 0,
    register: (bridge) => {
      app.mount(bridge);
      ai.mount(bridge);
      autoapp.mount(bridge);
      attached = () => bridge.sessions.some((session) => session.endpoint.state === 'open');
    },
    // Handed over so the child runtime can forward an MCP call through the
    // gate. The envelope is the child's, never the caller's.
    invoke: (route, input, envelope) => app.invoke(route as never, input, envelope),
    // An idle exit, or a drain, must not throw away a computation somebody is
    // watching. A chat turn in progress is exactly that.
    isBusy: () => app.activeStreams > 0 || ai.activeStreams > 0,
    shutdown: () => {
      ai.abortAll('the application is shutting down');
      app.abortAll('the application is shutting down');
      // The AI layer holds the conversation database open once somebody has
      // used the panel; closing it checkpoints that WAL as well.
      ai.close();
      runs.close();
      // Checkpoint the WAL and close the handle. Skipping this leaves a
      // database that needs its sidecar files to be readable.
      if (state.ok) state.store.close();
    },
  };
}

/** Open the data and prepare everything, without serving anything yet. */
export function start(context: AppStartContext): Promise<AppInstance> {
  return Promise.resolve(assemble(openState(context.dataDir, context.logger), context));
}

/**
 * Bring the databases in `dataDir` up to date, and report where they went.
 *
 * `openStore` migrates on open, so this opens and closes. It deliberately does
 * not mount anything: it is called against a *copy* of somebody's data during
 * an activation, and a copy that had a bridge on it would be reachable.
 */
export function migrate(context: {
  dataDir: string;
  logger: AppStartContext['logger'];
}): Promise<{ from: number; to: number }> {
  // Read the version before anything migrates it. `openStore` migrates on
  // open, so asking it afterwards would only ever report the latest — which
  // would make a report of "nothing to do" indistinguishable from a report of
  // "three migrations ran".
  const probe = new Database(join(context.dataDir, 'notes.sqlite'), { create: true });
  const from = (probe.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version) ?? 0;
  probe.close();

  const store = openStore(context.dataDir);
  try {
    context.logger.warn(`[notes] migrated from schema ${String(from)} to ${String(store.schemaVersion)}`);
    return Promise.resolve({ from, to: store.schemaVersion });
  } finally {
    store.close();
  }
}

/** Named so the shape is checked here rather than only at the child's import. */
export const notesModule: AppModule = { start, migrate };
