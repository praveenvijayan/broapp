/**
 * Where the items are kept.
 *
 * One SQLite file inside the data directory the child hands the application,
 * so a preview writes to the copy it was given and the live process writes to
 * the real one. Nothing here knows which of the two it is, and nothing should.
 *
 * Migrations are appended and never edited. One that has already run against
 * somebody's data is history: changing it means their database and the list in
 * `autoapp.json` disagree for ever.
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

/** The migrations, in order. `PRAGMA user_version` is how far a database got. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE items (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     label      TEXT    NOT NULL,
     note       TEXT    NOT NULL DEFAULT '',
     done       INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );`,
];

/** The version a fully migrated database reports. */
export function latestSchemaVersion(): number {
  return MIGRATIONS.length;
}

/** One item, as the contract describes it. */
export interface Item {
  id: number;
  label: string;
  note: string;
  done: boolean;
  /** `done` inverted, so a row action can toggle it without an expression. */
  nextDone: boolean;
  createdAt: number;
}

/** What a caller may change about an item. Anything absent is left alone. */
export interface ItemChanges {
  label?: string | undefined;
  note?: string | undefined;
  done?: boolean | undefined;
}

/** The open database and everything this application does with it. */
export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  list(): Item[];
  add(label: string, note: string): Item;
  update(id: number, changes: ItemChanges): Item | null;
  remove(id: number): boolean;
  count(): { count: number; done: number };
  healthy(): boolean;
  close(): void;
}

interface Row {
  id: number;
  label: string;
  note: string;
  done: number;
  created_at: number;
}

/** Read the schema version without migrating anything. */
export function readSchemaVersion(directory: string): number {
  const db = new Database(join(directory, 'items.sqlite'), { create: true });
  try {
    return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  } finally {
    db.close();
  }
}

/** Open the database at `directory/items.sqlite`, migrating it as needed. */
export function openStore(directory: string): Store {
  const path = join(directory, 'items.sqlite');
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  let version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    const statement = MIGRATIONS[index];
    if (statement === undefined) break;
    // A migration that throws leaves `user_version` where it was, so a retry
    // starts from the step that failed rather than from the one after it.
    db.transaction(() => {
      db.exec(statement);
      db.exec(`PRAGMA user_version = ${String(index + 1)}`);
    })();
    version = index + 1;
  }

  const statements = {
    list: db.query<Row, []>('SELECT id, label, note, done, created_at FROM items ORDER BY id DESC'),
    get: db.query<Row, [number]>('SELECT id, label, note, done, created_at FROM items WHERE id = ?'),
    add: db.query<Row, [string, string, number]>(
      'INSERT INTO items (label, note, created_at) VALUES (?, ?, ?) RETURNING id, label, note, done, created_at',
    ),
    remove: db.query<{ id: number }, [number]>('DELETE FROM items WHERE id = ? RETURNING id'),
    count: db.query<{ n: number; done: number }, []>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(done), 0) AS done FROM items',
    ),
  };

  const toItem = (row: Row): Item => ({
    id: row.id,
    label: row.label,
    note: row.note,
    done: row.done !== 0,
    nextDone: row.done === 0,
    createdAt: row.created_at,
  });

  return {
    path,
    schemaVersion: version,
    list: () => statements.list.all().map(toItem),
    add(label, note) {
      const row = statements.add.get(label, note, Date.now());
      if (row === null) throw new Error('the insert returned nothing');
      return toItem(row);
    },
    update(id, changes) {
      const existing = statements.get.get(id);
      if (existing === null) return null;
      // Written out rather than assembled from whichever keys arrived: a
      // statement built by string concatenation is where an injection lives,
      // and there are only three columns.
      const label = changes.label ?? existing.label;
      const note = changes.note ?? existing.note;
      const done = changes.done === undefined ? existing.done : changes.done ? 1 : 0;
      const row = db
        .query<Row, [string, string, number, number]>(
          'UPDATE items SET label = ?, note = ?, done = ? WHERE id = ? RETURNING id, label, note, done, created_at',
        )
        .get(label, note, done, id);
      return row === null ? null : toItem(row);
    },
    remove: (id) => statements.remove.get(id) !== null,
    count() {
      const row = statements.count.get();
      return { count: row?.n ?? 0, done: row?.done ?? 0 };
    },
    healthy() {
      const row = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get();
      return row?.integrity_check === 'ok';
    },
    close: () => db.close(),
  };
}
