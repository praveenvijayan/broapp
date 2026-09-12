/**
 * What the launcher was doing when it stopped.
 *
 * An activation moves a person's data from one release to another, and a
 * launcher that dies halfway through must leave behind enough to say *which*
 * halfway. So every phase is written down before the action it names is taken —
 * write-ahead, in the ordinary sense — and recovery reads the last phase
 * recorded rather than trying to infer one from the state of the filesystem.
 *
 * The one phase worth naming here is `switched`. Before it, the previous data
 * directory is untouched and rolling back is a rename. After it, the new
 * release may have accepted a write, and rolling back means deciding what to do
 * about that. The journal is how a person is told which of the two they are in.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where an activation has got to. */
export type Phase =
  | 'requested'
  | 'drained'
  | 'snapshotted'
  | 'migrated'
  | 'checked'
  | 'switched'
  | 'serving'
  | 'done'
  | 'failed-before-switch'
  | 'failed-after-switch'
  | 'rolled-back'
  /**
   * The application was removed.
   *
   * Not an activation at all, and the one row of its kind: a removal is the
   * last thing that happens to an application, and the journal is the only
   * place that still answers about it afterwards. It is terminal, so recovery
   * never looks at it — there is nothing left to recover.
   */
  | 'removed';

/** Phases an activation can still be in the middle of. */
export const TERMINAL_PHASES: readonly Phase[] = [
  'done',
  'failed-before-switch',
  'failed-after-switch',
  'rolled-back',
  'removed',
];

/** One activation, as the journal holds it. */
export interface Activation {
  readonly id: number;
  readonly appId: string;
  readonly fromRelease: string | null;
  readonly toRelease: string;
  readonly phase: Phase;
  /** The directory the previous data was renamed to, once it has been. */
  readonly dataPrev: string | null;
  readonly snapshotDir: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly error: string | null;
}

/** What may be recorded alongside a phase change. */
export interface PhaseDetails {
  readonly dataPrev?: string | null;
  readonly snapshotDir?: string | null;
  readonly error?: string | null;
}

/** The activation journal. */
export interface Journal {
  /** Start recording an activation. Returns its id. */
  begin(params: { appId: string; fromRelease: string | null; toRelease: string }): number;
  /** Record that an activation has reached a phase, before the phase is acted on. */
  advance(id: number, phase: Phase, details?: PhaseDetails): void;
  read(id: number): Activation | null;
  /** Every activation that is not finished, oldest first. */
  unfinished(): readonly Activation[];
  /** Every activation for one application, newest first. */
  history(appId: string, limit?: number): readonly Activation[];
  close(): void;
}

/** One row, as SQLite returns it. */
interface Row {
  id: number;
  app_id: string;
  from_release: string | null;
  to_release: string;
  phase: string;
  data_prev: string | null;
  snapshot_dir: string | null;
  started_at: number;
  updated_at: number;
  error: string | null;
}

function toActivation(row: Row): Activation {
  return {
    id: row.id,
    appId: row.app_id,
    fromRelease: row.from_release,
    toRelease: row.to_release,
    phase: row.phase as Phase,
    dataPrev: row.data_prev,
    snapshotDir: row.snapshot_dir,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT    NOT NULL,
  from_release  TEXT,
  to_release    TEXT    NOT NULL,
  phase         TEXT    NOT NULL,
  data_prev     TEXT,
  snapshot_dir  TEXT,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS activations_app ON activations (app_id, id DESC);
`;

/** Open (and create) the journal at `path`. */
export function openJournal(path: string): Journal {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  // WAL so a reader — a `status` command, say — never blocks the activation
  // that is writing, and `FULL` because the whole value of this file is that
  // what it says survives the process that wrote it dying unexpectedly.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  return {
    begin({ appId, fromRelease, toRelease }) {
      const now = Date.now();
      const row = db
        .query<{ id: number }, [string, string | null, string, number, number]>(
          `INSERT INTO activations (app_id, from_release, to_release, phase, started_at, updated_at)
           VALUES (?, ?, ?, 'requested', ?, ?) RETURNING id`,
        )
        .get(appId, fromRelease, toRelease, now, now);
      if (row === null) throw new Error('the journal did not record the activation');
      return row.id;
    },

    advance(id, phase, details = {}) {
      // One statement inside a transaction: a phase change is the unit that has
      // to be all-or-nothing, because a row that named a phase without its
      // `data_prev` would send recovery down the wrong branch.
      db.transaction(() => {
        db.query<null, [string, string | null, string | null, string | null, number, number]>(
          `UPDATE activations
              SET phase = ?,
                  data_prev = COALESCE(?, data_prev),
                  snapshot_dir = COALESCE(?, snapshot_dir),
                  error = COALESCE(?, error),
                  updated_at = ?
            WHERE id = ?`,
        ).run(
          phase,
          details.dataPrev ?? null,
          details.snapshotDir ?? null,
          details.error ?? null,
          Date.now(),
          id,
        );
      })();
    },

    read(id) {
      const row = db.query<Row, [number]>('SELECT * FROM activations WHERE id = ?').get(id);
      return row === null ? null : toActivation(row);
    },

    unfinished() {
      const marks = TERMINAL_PHASES.map(() => '?').join(', ');
      return db
        .query<Row, string[]>(`SELECT * FROM activations WHERE phase NOT IN (${marks}) ORDER BY id`)
        .all(...TERMINAL_PHASES)
        .map(toActivation);
    },

    history(appId, limit = 50) {
      return db
        .query<Row, [string, number]>(
          'SELECT * FROM activations WHERE app_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(appId, limit)
        .map(toActivation);
    },

    close() {
      db.close();
    },
  };
}
