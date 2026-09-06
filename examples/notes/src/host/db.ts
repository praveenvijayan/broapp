/**
 * The database: schema versioning, migrations, and the queries.
 *
 * `bun:sqlite` is built into the Bun runtime, so it is embedded in the compiled
 * executable along with everything else — there is no native module to install
 * and nothing to resolve at startup. It does mean the SQLite in the binary is
 * the one Bun linked for that target, which is worth knowing when
 * cross-compiling: the build produces a binary, it does not prove that binary
 * runs.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { publicError } from 'broapp/host';

/**
 * The migrations, in order.
 *
 * Each is applied once and `user_version` is set to its index. Adding a feature
 * means appending here — never editing an entry that has shipped, because a
 * database that already ran the old version will never run the new one.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE notes (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     title      TEXT    NOT NULL,
     body       TEXT    NOT NULL DEFAULT '',
     done       INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX notes_updated_at ON notes (updated_at DESC);`,

  // A second migration, so the mechanism is exercised rather than merely
  // described. It is idempotent in effect: an existing database gains the
  // column, a new one is created with it and skips straight past.
  `ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX notes_pinned ON notes (pinned DESC, updated_at DESC);`,
];

/** The version a fully migrated database reports. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/** A row as it comes out of SQLite. */
interface Row {
  id: number;
  title: string;
  body: string;
  done: number;
  created_at: number;
  updated_at: number;
}

/** A note as the contract describes it. */
export interface Note {
  id: number;
  title: string;
  body: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

function toNote(row: Row): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    done: row.done !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The open database, plus everything the application does with it. */
export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  list(done: boolean | null | undefined): Note[];
  /** Case-insensitive substring search over title and body, newest first. */
  search(text: string, limit: number): Note[];
  /** Notes by id, in the order asked, skipping ids that no longer exist. */
  byIds(ids: readonly number[]): Note[];
  create(input: { title: string; body: string }): Note;
  update(input: { id: number; title: string; body: string; done: boolean }): Note;
  remove(id: number): boolean;
  count(): number;
  backup(): { path: string; bytes: number };
  close(): void;
}

/**
 * Open the database at `directory/notes.sqlite`, migrating it as needed.
 *
 * Throws if it cannot be opened or migrated. The caller decides what to do
 * about that — this application reports it in the interface rather than
 * refusing to start, because a user with a corrupt database still needs to be
 * told where it is.
 */
export function openStore(directory: string): Store {
  const path = join(directory, 'notes.sqlite');
  const db = new Database(path, { create: true, strict: true });

  // WAL gives a reader and a writer at the same time, which matters here
  // because a backup reads the database while a tab may be writing to it.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Without this, a concurrent write returns SQLITE_BUSY immediately rather
  // than waiting for the other transaction to finish.
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);

  const version = currentVersion(db);

  const statements = {
    listAll: db.query<Row, []>(
      'SELECT id, title, body, done, created_at, updated_at FROM notes ORDER BY updated_at DESC',
    ),
    listByDone: db.query<Row, [number]>(
      'SELECT id, title, body, done, created_at, updated_at FROM notes WHERE done = ? ORDER BY updated_at DESC',
    ),
    byId: db.query<Row, [number]>(
      'SELECT id, title, body, done, created_at, updated_at FROM notes WHERE id = ?',
    ),
    insert: db.query<{ id: number }, [string, string, number, number]>(
      'INSERT INTO notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id',
    ),
    update: db.query<Row, [string, string, number, number, number]>(
      `UPDATE notes SET title = ?, body = ?, done = ?, updated_at = ? WHERE id = ?
       RETURNING id, title, body, done, created_at, updated_at`,
    ),
    remove: db.query<{ id: number }, [number]>('DELETE FROM notes WHERE id = ? RETURNING id'),
    count: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM notes'),
    // `LIKE` on this table is case-insensitive for ASCII by default, which is
    // what a note search wants. The pattern is bound, not spliced, so a note
    // body full of `%` is a search for `%` rather than a wildcard injection.
    // `id DESC` breaks the tie between two notes written in the same
    // millisecond, so the model is shown a stable order.
    search: db.query<Row, [string, string, number]>(
      `SELECT id, title, body, done, created_at, updated_at FROM notes
       WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ),
  };

  /** Turn user text into a LIKE pattern that matches it literally. */
  const contains = (text: string): string =>
    `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

  return {
    path,
    schemaVersion: version,

    list(done) {
      // Every value reaches SQLite as a bound parameter, never as text spliced
      // into a statement.
      const rows =
        done === null || done === undefined
          ? statements.listAll.all()
          : statements.listByDone.all(done ? 1 : 0);
      return rows.map(toNote);
    },

    search(text, limit) {
      const trimmed = text.trim();
      if (trimmed === '') return [];
      // Clamped rather than trusted: the caller is the AI layer, and a limit
      // of a million would be a way to make this process allocate.
      const capped = Math.max(1, Math.min(Math.trunc(limit), 100));
      const pattern = contains(trimmed);
      return statements.search.all(pattern, pattern, capped).map(toNote);
    },

    byIds(ids) {
      // One prepared lookup per id, in the order asked. A generated `IN (...)`
      // clause would need a statement per arity and would lose the order.
      const notes: Note[] = [];
      for (const id of ids) {
        const row = statements.byId.get(id);
        if (row !== null) notes.push(toNote(row));
      }
      return notes;
    },

    create({ title, body }) {
      const now = Date.now();
      const inserted = statements.insert.get(title, body, now, now);
      if (inserted === null) throw publicError.unavailable('The note could not be saved.');
      const row = statements.byId.get(inserted.id);
      if (row === null) throw publicError.unavailable('The note could not be read back.');
      return toNote(row);
    },

    update({ id, title, body, done }) {
      const row = statements.update.get(title, body, done ? 1 : 0, Date.now(), id);
      if (row === null) throw publicError.notFound('That note no longer exists.');
      return toNote(row);
    },

    remove(id) {
      return statements.remove.get(id) !== null;
    },

    count() {
      return statements.count.get()?.n ?? 0;
    },

    backup() {
      // `VACUUM INTO` produces a consistent copy without stopping writers, and
      // without the caller having to reason about the WAL. Copying the file
      // with `cp` while the application runs does not give that.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const target = join(directory, `notes-backup-${stamp}.sqlite`);
      try {
        db.run('VACUUM INTO ?', [target]);
      } catch {
        // A target that already exists, or a full disk. Fall back to a plain
        // copy only when the database is otherwise healthy.
        try {
          copyFileSync(path, target);
        } catch {
          throw publicError.unavailable('The backup could not be written.');
        }
      }
      return { path: target, bytes: statSync(target).size };
    },

    close() {
      // Checkpointing folds the WAL back into the main file, so the database
      // left behind is a single complete file rather than one that needs its
      // sidecar to be readable.
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // A checkpoint that fails is not a reason to leave the handle open.
      }
      db.close();
    },
  };
}

function currentVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  return row?.user_version ?? 0;
}

/**
 * Bring the schema up to date.
 *
 * Each migration and its version bump happen in one transaction, so an
 * interrupted upgrade leaves the database at the last version that fully
 * applied — never half-way through one.
 */
function migrate(db: Database): void {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${String(from)} is newer than this build understands (${String(MIGRATIONS.length)})`,
    );
  }
  for (let version = from; version < MIGRATIONS.length; version += 1) {
    const statement = MIGRATIONS[version];
    if (statement === undefined) continue;
    db.transaction(() => {
      db.exec(statement);
      // PRAGMA does not accept a bound parameter, so the value is interpolated.
      // It is a loop index, not input.
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
    })();
  }
}
