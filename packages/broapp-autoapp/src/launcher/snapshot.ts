/**
 * Copying a data directory without tearing it.
 *
 * A SQLite database is not one file's worth of state. With WAL on — which every
 * Broapp application uses, because it lets a backup read while a tab writes —
 * the committed data is split between the database and its `-wal` sidecar, and
 * a byte copy of the main file taken mid-transaction is a database that opens
 * and is wrong. `VACUUM INTO` asks SQLite itself for a consistent copy, so what
 * lands is a real database at a real point in time.
 *
 * That is why this can run while a child still has the database open. In an
 * activation it is nonetheless run *after* the drain, so the copy is quiescent
 * as well as consistent — but the property that makes it safe is the first one,
 * and it is the one to keep if the ordering ever changes.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One file that was copied, and how big the copy is. */
export interface SnapshotEntry {
  /** Relative to the directory that was snapshotted. */
  readonly path: string;
  readonly bytes: number;
  readonly method: 'vacuum' | 'copy';
}

/** Files whose contents `VACUUM INTO` has already folded into the copy. */
const SIDECAR = /\.sqlite-(wal|shm)$/;
/** What counts as a database rather than an ordinary file. */
const DATABASE = /\.sqlite$/;

/**
 * Copy one database consistently.
 *
 * Opened read-only: this may run against a database another process is writing
 * to, and nothing about taking a copy should be able to change the original.
 * The target is quoted the way SQLite expects, with any single quote doubled —
 * the path comes from the launcher rather than from a user, but a filename with
 * an apostrophe in it is not exotic.
 */
export function snapshotToFile(dataDir: string, dbName: string, targetFile: string): number {
  const source = join(dataDir, dbName);
  const db = new Database(source, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return statSync(targetFile).size;
}

/**
 * Copy a whole data directory.
 *
 * `targetDir` must not exist: a snapshot written over something is not a
 * snapshot of anything in particular, and the caller always knows a name that
 * is free.
 */
export function snapshotDirectory(dataDir: string, targetDir: string): readonly SnapshotEntry[] {
  if (existsSync(targetDir)) {
    throw new Error(`refusing to snapshot into ${targetDir}, which already exists`);
  }
  const entries: SnapshotEntry[] = [];
  copyInto(dataDir, targetDir, '', entries);
  return entries;
}

/** Copy one directory level, recursing into subdirectories with the same rules. */
function copyInto(
  sourceDir: string,
  targetDir: string,
  prefix: string,
  entries: SnapshotEntry[],
): void {
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(sourceDir)) {
    const source = join(sourceDir, name);
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const stats = statSync(source);

    if (stats.isDirectory()) {
      copyInto(source, join(targetDir, name), relative, entries);
      continue;
    }
    if (!stats.isFile()) continue;
    // A `-wal` or `-shm` beside a database is not data of its own; `VACUUM
    // INTO` has already folded whatever it held into the copy. Carrying them
    // across would leave the copy claiming a journal it does not have.
    if (SIDECAR.test(name)) continue;

    if (DATABASE.test(name)) {
      const bytes = snapshotToFile(sourceDir, name, join(targetDir, name));
      entries.push({ path: relative, bytes, method: 'vacuum' });
      continue;
    }
    copyFileSync(source, join(targetDir, name));
    entries.push({ path: relative, bytes: stats.size, method: 'copy' });
  }
}
