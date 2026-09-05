/**
 * The database: migrations, CRUD, persistence and failure.
 *
 * These use a real SQLite file in a temporary directory, because the questions
 * worth asking — does a migration run once, does data survive a restart, is a
 * backup readable — are only meaningful against a real one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LATEST_SCHEMA_VERSION, openStore, type Store } from '../src/host/db.ts';

let directory = '';
let store: Store | null = null;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'notes-db-'));
});

afterEach(async () => {
  store?.close();
  store = null;
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

describe('schema', () => {
  test('a new database is migrated to the latest version', () => {
    store = openStore(directory);
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThan(1);
  });

  test('reopening does not re-run migrations', () => {
    const first = openStore(directory);
    first.create({ title: 'kept', body: '' });
    first.close();

    const second = openStore(directory);
    store = second;
    expect(second.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    // A migration that ran twice would have thrown on the duplicate column.
    expect(second.list(null)).toHaveLength(1);
  });

  test('the second migration really added its column', () => {
    store = openStore(directory);
    const db = new Database(join(directory, 'notes.sqlite'), { readonly: true });
    try {
      const columns = db
        .query<{ name: string }, []>('PRAGMA table_info(notes)')
        .all()
        .map((row) => row.name);
      expect(columns).toContain('pinned');
    } finally {
      db.close();
    }
  });

  test('a database from a newer build is refused rather than downgraded', () => {
    const path = join(directory, 'notes.sqlite');
    const db = new Database(path, { create: true });
    db.exec(`PRAGMA user_version = ${String(LATEST_SCHEMA_VERSION + 5)}`);
    db.close();

    expect(() => openStore(directory)).toThrow(/newer than this build/);
  });
});

describe('crud', () => {
  beforeEach(() => {
    store = openStore(directory);
  });

  test('creates, reads back and lists newest first', async () => {
    const first = store!.create({ title: 'first', body: 'a' });
    // Timestamps have millisecond resolution; without a gap the ordering of
    // two notes created in the same millisecond is not defined.
    await Bun.sleep(2);
    const second = store!.create({ title: 'second', body: 'b' });

    expect(first.id).not.toBe(second.id);
    expect(store!.list(null).map((note) => note.title)).toEqual(['second', 'first']);
  });

  test('updates and filters by done', () => {
    const note = store!.create({ title: 'task', body: '' });
    const updated = store!.update({ id: note.id, title: 'task', body: 'done now', done: true });

    expect(updated.done).toBe(true);
    expect(updated.body).toBe('done now');
    expect(store!.list(true)).toHaveLength(1);
    expect(store!.list(false)).toHaveLength(0);
  });

  test('updating a missing note is a public not-found, not a crash', () => {
    expect(() => store!.update({ id: 9_999, title: 'x', body: '', done: false })).toThrow(
      /no longer exists/,
    );
  });

  test('remove reports whether anything was removed', () => {
    const note = store!.create({ title: 'temporary', body: '' });
    expect(store!.remove(note.id)).toBe(true);
    expect(store!.remove(note.id)).toBe(false);
    expect(store!.count()).toBe(0);
  });

  test('text with quotes and semicolons is stored literally', () => {
    // Bound parameters, not string building. This would be a very different
    // test if the queries were assembled by concatenation.
    const hostile = `'; DROP TABLE notes; --`;
    const note = store!.create({ title: hostile, body: hostile });
    expect(store!.list(null)[0]?.title).toBe(hostile);
    expect(note.body).toBe(hostile);
    expect(store!.count()).toBe(1);
  });
});

describe('persistence', () => {
  test('data survives a close and reopen', () => {
    const first = openStore(directory);
    first.create({ title: 'persisted', body: 'across restarts' });
    first.close();

    const second = openStore(directory);
    store = second;
    const notes = second.list(null);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe('across restarts');
  });

  test('closing checkpoints, so the main file alone is complete', () => {
    const first = openStore(directory);
    first.create({ title: 'checkpointed', body: '' });
    first.close();

    // Read the main file with no sidecar available to the reader.
    const db = new Database(join(directory, 'notes.sqlite'), { readonly: true });
    try {
      expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notes').get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('backup', () => {
  test('produces a readable copy containing the same notes', () => {
    store = openStore(directory);
    store.create({ title: 'backed up', body: '' });

    const result = store.backup();
    expect(result.bytes).toBeGreaterThan(0);

    const copy = new Database(result.path, { readonly: true });
    try {
      const rows = copy.query<{ title: string }, []>('SELECT title FROM notes').all();
      expect(rows.map((row) => row.title)).toEqual(['backed up']);
    } finally {
      copy.close();
    }
  });

  test('a later backup does not replace an earlier one', async () => {
    store = openStore(directory);
    store.create({ title: 'one', body: '' });
    const first = store.backup();
    await Bun.sleep(1_100); // the name carries a whole-second timestamp
    store.create({ title: 'two', body: '' });
    const second = store.backup();

    expect(second.path).not.toBe(first.path);
    const older = new Database(first.path, { readonly: true });
    try {
      expect(older.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notes').get()?.n).toBe(1);
    } finally {
      older.close();
    }
  }, 10_000);
});

describe('failure', () => {
  test('a file that is not a database is reported, not swallowed', async () => {
    await writeFile(join(directory, 'notes.sqlite'), 'this is not a database', 'utf8');
    expect(() => openStore(directory)).toThrow();
  });
});
