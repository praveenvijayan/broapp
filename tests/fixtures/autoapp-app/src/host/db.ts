/**
 * The fixture's database.
 *
 * Three migrations, so an activation has a real forward step to take, and so a
 * variant can make one of them fail on purpose. `AUTOAPP_FIXTURE_MIGRATIONS`
 * caps how many are applied, which is how the tests build a release at schema 2
 * and another at schema 3 from one source tree.
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

/** The migrations, in order. Never edit one that has shipped; append instead. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE items (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     label      TEXT    NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  `CREATE INDEX items_created_at ON items (created_at DESC);`,
  `ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT '';`,
];

/** How many migrations this build applies. The whole list unless capped. */
export function migrationCount(): number {
  const capped = Number(process.env['AUTOAPP_FIXTURE_MIGRATIONS'] ?? '');
  return Number.isInteger(capped) && capped > 0 && capped <= MIGRATIONS.length
    ? capped
    : MIGRATIONS.length;
}

/** The version a fully migrated database reports for this build. */
export function latestSchemaVersion(): number {
  return migrationCount();
}

/** One item, as the contract describes it. */
export interface Item {
  id: number;
  label: string;
  createdAt: number;
}

/** The open database and everything the fixture does with it. */
export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  list(): Item[];
  add(label: string): Item;
  count(): number;
  close(): void;
}

interface Row {
  id: number;
  label: string;
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

  const wanted = migrationCount();
  let version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  for (let index = version; index < wanted; index += 1) {
    const statement = MIGRATIONS[index];
    if (statement === undefined) break;
    // A migration that throws leaves `user_version` where it was, so a retry
    // starts from the same place rather than skipping the step that failed.
    db.transaction(() => {
      db.exec(statement);
      db.exec(`PRAGMA user_version = ${String(index + 1)}`);
    })();
    // Deliberate failure, for the test that proves a failed migration leaves
    // the live data alone. It runs after the statement so a partially applied
    // migration is what recovery has to cope with.
    if (process.env['AUTOAPP_FIXTURE_FAIL_MIGRATION'] === String(index + 1)) {
      db.close();
      throw new Error(`migration ${String(index + 1)} failed on purpose`);
    }
    version = index + 1;
  }

  const statements = {
    list: db.query<Row, []>('SELECT id, label, created_at FROM items ORDER BY id DESC'),
    add: db.query<Row, [string, number]>(
      'INSERT INTO items (label, created_at) VALUES (?, ?) RETURNING id, label, created_at',
    ),
    count: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM items'),
  };

  const toItem = (row: Row): Item => ({ id: row.id, label: row.label, createdAt: row.created_at });

  return {
    path,
    schemaVersion: version,
    list: () => statements.list.all().map(toItem),
    add(label) {
      const row = statements.add.get(label, Date.now());
      if (row === null) throw new Error('the insert returned nothing');
      return toItem(row);
    },
    count: () => statements.count.get()?.n ?? 0,
    close: () => db.close(),
  };
}
