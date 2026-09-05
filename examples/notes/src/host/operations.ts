/**
 * Notes — host.
 *
 * Every operation validates its input through the contract before it reaches
 * this file, and every value reaches SQLite as a bound parameter. What is left
 * for this layer is the application's own rules and its failure behaviour.
 */
import { createHostApp, publicError } from 'broapp/host';

import { contract } from '../shared/contract.ts';
import { LATEST_SCHEMA_VERSION, type Store } from './db.ts';

/**
 * The database, or the reason there isn't one.
 *
 * A corrupt or unreadable database must not stop the application from starting:
 * a user in that position needs to be told where the file is so they can move
 * it aside. So the failure is carried, not thrown, and `notes.status` reports
 * it while every other operation refuses politely.
 */
export type StoreState =
  | { readonly ok: true; readonly store: Store }
  | { readonly ok: false; readonly path: string; readonly reason: string };

export function createApp(state: StoreState) {
  const app = createHostApp(contract);

  /** The store, or a public failure. Every data operation starts here. */
  function store(): Store {
    if (!state.ok) {
      throw publicError.unavailable(
        'The notes database could not be opened. See the details panel for where it is.',
      );
    }
    return state.store;
  }

  app.operation('notes.list', ({ done }) => ({ notes: store().list(done) }));

  app.operation('notes.create', ({ title, body }) => {
    const trimmed = title.trim();
    if (trimmed === '') throw publicError.invalidInput('A note needs a title.');
    return store().create({ title: trimmed, body });
  });

  app.operation('notes.update', ({ id, title, body, done }) => {
    const trimmed = title.trim();
    if (trimmed === '') throw publicError.invalidInput('A note needs a title.');
    return store().update({ id, title: trimmed, body, done });
  });

  app.operation('notes.remove', ({ id }) => ({ removed: store().remove(id) }));

  app.operation('notes.status', () => {
    if (!state.ok) {
      return {
        databasePath: state.path,
        schemaVersion: 0,
        latestSchemaVersion: LATEST_SCHEMA_VERSION,
        noteCount: 0,
        healthy: false,
      };
    }
    return {
      databasePath: state.store.path,
      schemaVersion: state.store.schemaVersion,
      latestSchemaVersion: LATEST_SCHEMA_VERSION,
      noteCount: state.store.count(),
      healthy: true,
    };
  });

  app.operation('notes.backup', () => store().backup());

  return app;
}
