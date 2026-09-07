/**
 * What agents did, written down.
 *
 * The gate already decides and already produces a record; this is where the
 * record goes. It lives *inside the application's data directory* rather than
 * beside the launcher, and that is the point: a preview child records into the
 * copy of the data it is previewing, and a live child into the real one,
 * without either of them having to know which they are.
 *
 * Two properties matter more than the schema. A step whose outcome was never
 * written down is `unknown` rather than assumed failed — a process that died
 * between calling an external service and recording the answer may well have
 * sent the message. And nothing with an `unknown` step can be replayed, because
 * replaying "we are not sure whether this happened" is how something happens
 * twice.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, publicError } from 'broapp/host';
import type { ExecutionRecord, HostLogger, Recorder } from 'broapp/host';

import type { WorkflowDefinition } from '../workflows/types.ts';

/** One run, as a list shows it. */
export interface RunSummary {
  readonly id: string;
  readonly appId: string;
  readonly releaseId: string;
  readonly channel: string;
  readonly caller: string;
  readonly mode: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly summary: string | null;
}

/** One recorded call. */
export interface RunStep {
  readonly id: number;
  readonly runId: string;
  readonly requestId: string;
  readonly route: string;
  readonly effect: string;
  readonly input: unknown;
  readonly argumentsHash: string;
  readonly decision: string;
  readonly outcome: string | null;
  readonly output: unknown;
  readonly error: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** One saved workflow, as a list shows it. */
export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly updatedAt: number;
  /** Enough to build the form that runs it, without fetching the definition. */
  readonly params: WorkflowDefinition['params'];
}

/** One saved workflow, in full. */
export interface SavedWorkflow extends WorkflowSummary {
  readonly definition: WorkflowDefinition;
  readonly createdAt: number;
  readonly fromRunId: string | null;
}

/** The store an application keeps its history in. */
export interface RunStore {
  /** The gate recorder. Never throws. */
  recorder(): Recorder;
  finishRun(runId: string, status: RunSummary['status'], summary?: string): void;
  /** Mark whatever was in flight when the last process died. */
  markUnknownOnStart(): void;
  listRuns(options?: {
    limit?: number;
    before?: number;
    /** Only these channels. Omitted means every channel. */
    channels?: readonly string[];
  }): readonly RunSummary[];
  getRun(id: string): { run: RunSummary; steps: readonly RunStep[] } | null;
  saveWorkflow(input: {
    id?: string;
    name: string;
    definition: WorkflowDefinition;
    fromRunId?: string | null;
  }): { id: string; version: number };
  getWorkflow(id: string): SavedWorkflow | null;
  listWorkflows(): readonly WorkflowSummary[];
  deleteWorkflow(id: string): boolean;
  close(): void;
}

/** Longest string kept whole in a recorded input or output. */
const MAX_STRING = 2_000;

/**
 * Key names whose values are replaced before anything is written down.
 *
 * A courtesy, not a guarantee. It catches the names people actually use, and it
 * cannot catch a secret stored under a name nobody thought of, or one embedded
 * in the middle of a longer string. The real rule is the one in the common
 * rules: adapters must not put secrets in inputs.
 */
const SECRET_KEY = /secret|token|password|apikey|api_key/;

/** Trim and redact one value, at every depth. The original is never touched. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `<truncated ${String(value.length)} chars>` : value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key.toLowerCase()) ? '<redacted>' : redact(member);
    }
    return out;
  }
  return value;
}

/**
 * The run a request belongs to.
 *
 * The AI layer builds request identifiers as `<runId>:<callId>`, so one chat
 * turn's steps share a prefix. Everything else uses the whole identifier, which
 * makes a one-step run — an MCP call, say — its own run.
 */
export function runIdOf(requestId: string, channel: string): string {
  if (!GROUPED_CHANNELS.includes(channel)) return requestId;
  const cut = requestId.indexOf(':');
  return cut < 0 ? requestId : requestId.slice(0, cut);
}

/**
 * Channels whose requests are grouped into a longer run.
 *
 * An AI turn and a workflow both make several calls and are ended by whoever is
 * driving them, through `finishRun`. Everything else — a click, one MCP call —
 * *is* its own run, so the recorder closes it as soon as its one step is done.
 * Without that they would sit at `running` for ever, which is not "in progress"
 * but "nobody ever said".
 */
const GROUPED_CHANNELS: readonly string[] = ['ai', 'workflow'];

/**
 * The migrations, in order. Append; never edit one that has shipped.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE runs (
     id           TEXT PRIMARY KEY,
     app_id       TEXT NOT NULL,
     release_id   TEXT NOT NULL,
     channel      TEXT NOT NULL,
     caller       TEXT NOT NULL,
     mode         TEXT NOT NULL,
     status       TEXT NOT NULL,
     started_at   INTEGER NOT NULL,
     ended_at     INTEGER,
     summary      TEXT
   );
   CREATE TABLE steps (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id         TEXT NOT NULL REFERENCES runs(id),
     request_id     TEXT NOT NULL UNIQUE,
     route          TEXT NOT NULL,
     effect         TEXT NOT NULL,
     input_json     TEXT NOT NULL,
     arguments_hash TEXT NOT NULL,
     decision       TEXT NOT NULL,
     outcome        TEXT,
     output_json    TEXT,
     error          TEXT,
     started_at     INTEGER NOT NULL,
     ended_at       INTEGER
   );
   CREATE INDEX steps_run ON steps(run_id, started_at);
   CREATE TABLE workflows (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     version      INTEGER NOT NULL,
     definition   TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL,
     from_run_id  TEXT
   );`,
];

interface RunRow {
  id: string;
  app_id: string;
  release_id: string;
  channel: string;
  caller: string;
  mode: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
}

interface StepRow {
  id: number;
  run_id: string;
  request_id: string;
  route: string;
  effect: string;
  input_json: string;
  arguments_hash: string;
  decision: string;
  outcome: string | null;
  output_json: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
}

interface WorkflowRow {
  id: string;
  name: string;
  version: number;
  definition: string;
  created_at: number;
  updated_at: number;
  from_run_id: string | null;
}

function toRun(row: RunRow): RunSummary {
  return {
    id: row.id,
    appId: row.app_id,
    releaseId: row.release_id,
    channel: row.channel,
    caller: row.caller,
    mode: row.mode,
    status: row.status as RunSummary['status'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
  };
}

/** Parse a stored JSON column, tolerating a row written by an older build. */
function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toStep(row: StepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    requestId: row.request_id,
    route: row.route,
    effect: row.effect,
    input: parseJson(row.input_json),
    argumentsHash: row.arguments_hash,
    decision: row.decision,
    outcome: row.outcome,
    output: parseJson(row.output_json),
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** Open (and create) the run store inside an application's data directory. */
export function createRunStore(dataDir: string, logger: HostLogger = console): RunStore {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, 'runs.sqlite'), { create: true, strict: true });
  // WAL so reading the history never blocks the application writing to it.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const at = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  for (let index = at; index < MIGRATIONS.length; index += 1) {
    const statement = MIGRATIONS[index];
    if (statement === undefined) break;
    db.transaction(() => {
      db.exec(statement);
      db.exec(`PRAGMA user_version = ${String(index + 1)}`);
    })();
  }

  const store: RunStore = {
    recorder(): Recorder {
      return {
        record(record: ExecutionRecord): void {
          // The gate already catches whatever a recorder throws. This catches
          // it too, because a run store that took an application down with it
          // would be the worst possible trade for a history nobody asked for.
          try {
            const runId = runIdOf(record.requestId, record.channel);
            db.transaction(() => {
              db.query<null, [string, string, string, string, string, string, number]>(
                `INSERT INTO runs (id, app_id, release_id, channel, caller, mode, status, started_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
                 ON CONFLICT(id) DO NOTHING`,
              ).run(
                runId,
                record.appId,
                record.releaseId,
                record.channel,
                record.caller,
                record.mode,
                record.startedAt,
              );
              db.query<
                null,
                [
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  string | null,
                  string | null,
                  string | null,
                  number,
                  number,
                ]
              >(
                `INSERT INTO steps
                   (run_id, request_id, route, effect, input_json, arguments_hash,
                    decision, outcome, output_json, error, started_at, ended_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(request_id) DO UPDATE SET
                   decision = excluded.decision,
                   outcome = excluded.outcome,
                   output_json = excluded.output_json,
                   error = excluded.error,
                   ended_at = excluded.ended_at`,
              ).run(
                runId,
                record.requestId,
                record.route,
                record.effect,
                canonicalJson(redact(record.input)),
                record.argumentsHash,
                record.decision,
                record.outcome ?? null,
                // Only a success has an output worth keeping; anything else
                // would be recording what the call did not return.
                record.outcome === 'succeeded' ? canonicalJson(redact(record.output)) : null,
                record.error ?? null,
                record.startedAt,
                record.endedAt,
              );
              // A click or a single MCP call is its own run, and this is the
              // only moment anything will know how it ended.
              if (!GROUPED_CHANNELS.includes(record.channel)) {
                db.query<null, [string, number, string, string]>(
                  'UPDATE runs SET status = ?, ended_at = ?, summary = COALESCE(summary, ?) WHERE id = ?',
                ).run(statusOf(record), record.endedAt, record.route, runId);
              }
            })();
          } catch (cause) {
            logger.error(
              `[autoapp] the run store could not record ${record.route}: ${String(cause instanceof Error ? cause.message : cause)}`,
            );
          }
        },
      };
    },

    finishRun(runId, status, summary) {
      try {
        db.query<null, [string, number, string | null, string]>(
          `UPDATE runs SET status = ?, ended_at = ?, summary = COALESCE(?, summary) WHERE id = ?`,
        ).run(status, Date.now(), summary ?? null, runId);
      } catch (cause) {
        logger.error(`[autoapp] the run store could not close ${runId}: ${String(cause)}`);
      }
    },

    markUnknownOnStart() {
      // "The process died mid-step." A step that was allowed and never recorded
      // an outcome may have reached the outside world; the only honest thing to
      // say about it is that nobody knows.
      db.transaction(() => {
        db.exec(
          `UPDATE steps SET outcome = 'unknown'
            WHERE decision IN ('allowed', 'confirmed') AND outcome IS NULL`,
        );
        db.exec(`UPDATE runs SET status = 'unknown' WHERE status = 'running'`);
      })();
    },

    listRuns(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
      const before = options.before ?? Number.MAX_SAFE_INTEGER;
      const channels = options.channels;
      if (channels === undefined) {
        return db
          .query<RunRow, [number, number]>(
            'SELECT * FROM runs WHERE started_at < ? ORDER BY started_at DESC LIMIT ?',
          )
          .all(before, limit)
          .map(toRun);
      }
      if (channels.length === 0) return [];
      const marks = channels.map(() => '?').join(', ');
      return db
        .query<RunRow, (string | number)[]>(
          `SELECT * FROM runs WHERE started_at < ? AND channel IN (${marks})
            ORDER BY started_at DESC LIMIT ?`,
        )
        .all(before, ...channels, limit)
        .map(toRun);
    },

    getRun(id) {
      const row = db.query<RunRow, [string]>('SELECT * FROM runs WHERE id = ?').get(id);
      if (row === null) return null;
      const steps = db
        .query<StepRow, [string]>('SELECT * FROM steps WHERE run_id = ? ORDER BY started_at, id')
        .all(id)
        .map(toStep);
      return { run: toRun(row), steps };
    },

    saveWorkflow({ id, name, definition, fromRunId }) {
      const now = Date.now();
      const workflowId = id ?? crypto.randomUUID();
      const existing = db
        .query<{ version: number }, [string]>('SELECT version FROM workflows WHERE id = ?')
        .get(workflowId);
      const version = (existing?.version ?? 0) + 1;
      db.query<null, [string, string, number, string, number, number, string | null]>(
        `INSERT INTO workflows (id, name, version, definition, created_at, updated_at, from_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           definition = excluded.definition,
           updated_at = excluded.updated_at`,
      ).run(workflowId, name, version, JSON.stringify(definition), now, now, fromRunId ?? null);
      return { id: workflowId, version };
    },

    getWorkflow(id) {
      const row = db.query<WorkflowRow, [string]>('SELECT * FROM workflows WHERE id = ?').get(id);
      if (row === null) return null;
      const definition = JSON.parse(row.definition) as WorkflowDefinition;
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        params: definition.params,
        definition,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        fromRunId: row.from_run_id,
      };
    },

    listWorkflows() {
      return db
        .query<WorkflowRow, []>('SELECT * FROM workflows ORDER BY updated_at DESC')
        .all()
        .map((row) => ({
          id: row.id,
          name: row.name,
          version: row.version,
          updatedAt: row.updated_at,
          params: (JSON.parse(row.definition) as WorkflowDefinition).params,
        }));
    },

    deleteWorkflow(id) {
      const before = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflows').get()?.n ?? 0;
      db.query<null, [string]>('DELETE FROM workflows WHERE id = ?').run(id);
      const after = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflows').get()?.n ?? 0;
      return after < before;
    },

    close() {
      db.close();
    },
  };

  return store;
}

/** What a one-step run's status is, given how its single step ended. */
function statusOf(record: ExecutionRecord): RunSummary['status'] {
  if (record.outcome === 'succeeded') return 'succeeded';
  if (record.outcome === 'cancelled') return 'cancelled';
  if (record.outcome === 'failed') return 'failed';
  // Refused or denied: nothing ran, and the run is over.
  return record.decision === 'allowed' || record.decision === 'confirmed' ? 'unknown' : 'failed';
}

/** The error a run that cannot be replayed is refused with. */
export function unknownStepError(): Error {
  return publicError.conflict(
    'this run has a step with an unknown outcome and cannot be saved as a workflow',
  );
}
