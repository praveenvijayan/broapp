/**
 * The launcher's memory of what the engineer did.
 *
 * One SQLite file beside the launcher's run store, holding everything a later
 * step could learn from: a structured log of builds, checks, edits and
 * activations; the exact text each turn was given; and every failure the
 * engineer met, kept as a case with the repair that followed it. Nothing here
 * calls a model and nothing here decides anything. It writes down, with the
 * identity each thing had at the moment it happened, so that nothing has to be
 * inferred afterwards — a row attributed after the fact is a row that can be
 * attributed wrongly.
 *
 * Evidence is immutable, and the database says so rather than the code that
 * happens to write it: triggers refuse any change to an episode's opening
 * columns, any edit to its log except an append while it is open, and any
 * change at all to a resolved one beyond the bookkeeping a later step owns.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The file, inside the launcher's own data directory. */
export const KNOWLEDGE_FILE = 'knowledge.sqlite';

/** What the store is, to the modules beside it. */
export interface Knowledge {
  /** For the sibling modules in this directory only. */
  readonly db: Database;
  /** Store text by the hash of its bytes; returns the hash. Writing it twice is harmless. */
  putBlob(content: string): string;
  getBlob(hash: string): string | null;
  close(): void;
}

/** Options for {@link openKnowledge}. */
export interface OpenKnowledgeOptions {
  /** The clock retention is measured against. Tests move it. */
  readonly now?: number;
}

const DAY_MS = 86_400_000;
/** How long an event is kept. */
export const EVENT_RETENTION_MS = 30 * DAY_MS;
/** The most events kept, whatever their age. */
export const MAX_EVENTS = 50_000;
/** How long a blob nothing refers to is kept. */
export const BLOB_RETENTION_MS = 30 * DAY_MS;

/** Every column an episode is opened with. Written once, in one insert. */
const OPENING_COLUMNS = [
  'app_id',
  'stage',
  'signature',
  'problem',
  'example_id',
  'example_hash',
  'example_blob',
  'request_blob',
  'context_id',
  'run_id',
  'call_id',
  'source_rev_before',
  'release_before',
  'data_snapshot',
  'model_provider',
  'model_id',
  'autoapp_version',
  'opened_at',
] as const;

/** What resolving an episode fills in, once. */
const RESOLVED_COLUMNS = ['resolved_at', 'resolved_run_id', 'source_rev_after', 'release_after'] as const;

/** `NEW.x IS NOT OLD.x OR …`, for a trigger's condition. */
function anyChanged(columns: readonly string[]): string {
  return columns.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(' OR ');
}

/**
 * The migrations, in order. Append; never edit one that has shipped.
 *
 * The first creates every table the knowledge loop will need, including the
 * lesson tables nothing writes yet, so the next steps add behaviour rather than
 * schema. No nullable column takes part in a unique index — SQLite treats two
 * NULLs as different, which would let a duplicate through — and that is what
 * the `DEFAULT ''` columns are for.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
     level TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
     app_id TEXT, run_id TEXT, call_id TEXT, release_id TEXT, source_rev TEXT,
     message TEXT NOT NULL, data TEXT);
   CREATE INDEX events_at ON events(at);
   CREATE INDEX events_run ON events(run_id, at);
   CREATE INDEX events_app ON events(app_id, at);
   CREATE TABLE contexts (
     id INTEGER PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, app_id TEXT,
     corpus_version INTEGER NOT NULL,
     instructions_blob TEXT NOT NULL, system_blob TEXT NOT NULL,
     requested TEXT NOT NULL, resolved TEXT NOT NULL, included TEXT NOT NULL,
     at INTEGER NOT NULL);
   CREATE TABLE corpus_versions (version INTEGER PRIMARY KEY, lesson_id INTEGER, change TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE episodes (
     id INTEGER PRIMARY KEY, app_id TEXT NOT NULL, stage TEXT NOT NULL,
     signature TEXT NOT NULL, problem TEXT NOT NULL,
     example_id TEXT NOT NULL DEFAULT '', example_hash TEXT NOT NULL DEFAULT '', example_blob TEXT,
     request_blob TEXT NOT NULL, context_id INTEGER,
     run_id TEXT NOT NULL, call_id TEXT NOT NULL,
     source_rev_before TEXT NOT NULL, release_before TEXT, data_snapshot TEXT,
     model_provider TEXT, model_id TEXT, autoapp_version TEXT NOT NULL,
     edits TEXT NOT NULL DEFAULT '', opened_at INTEGER NOT NULL,
     resolved_at INTEGER, resolved_run_id TEXT, source_rev_after TEXT, release_after TEXT,
     diagnosis TEXT,
     distill_state TEXT NOT NULL DEFAULT 'pending', distill_attempts INTEGER NOT NULL DEFAULT 0);
   CREATE UNIQUE INDEX episodes_open ON episodes(app_id, stage, signature, example_id, example_hash) WHERE resolved_at IS NULL;
   CREATE TABLE lessons (
     id INTEGER PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, review TEXT,
     origin TEXT NOT NULL, episode_id INTEGER, supersedes INTEGER, diagnosis TEXT,
     scope TEXT NOT NULL, applies TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, trigger TEXT NOT NULL,
     instructions_hash TEXT NOT NULL, autoapp_version TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reviewed_by TEXT, reviewed_at INTEGER);
   CREATE UNIQUE INDEX lessons_episode ON lessons(episode_id) WHERE episode_id IS NOT NULL;
   CREATE VIRTUAL TABLE lessons_fts USING fts5(summary, trigger, tokenize='unicode61');
   CREATE TABLE servings (
     id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL, run_id TEXT NOT NULL,
     app_id TEXT NOT NULL DEFAULT '', how TEXT NOT NULL,
     for_signature TEXT NOT NULL DEFAULT '', for_stage TEXT NOT NULL DEFAULT '', for_example_hash TEXT NOT NULL DEFAULT '',
     included INTEGER NOT NULL, served_at INTEGER NOT NULL,
     attempt_call_id TEXT, attempt_kind TEXT, attempt_release TEXT, attempt_at INTEGER, outcome TEXT);
   CREATE UNIQUE INDEX servings_once ON servings(lesson_id, run_id, app_id, how, for_signature, for_example_hash);

   CREATE TRIGGER blobs_immutable BEFORE UPDATE ON blobs
   BEGIN SELECT RAISE(ABORT, 'a blob is named by its content and never changes'); END;
   CREATE TRIGGER episodes_opening_written_once BEFORE UPDATE ON episodes
   WHEN ${anyChanged(OPENING_COLUMNS)}
   BEGIN SELECT RAISE(ABORT, 'an episode''s opening columns are written once'); END;
   CREATE TRIGGER episodes_edits_append_only BEFORE UPDATE OF edits ON episodes
   WHEN (OLD.resolved_at IS NOT NULL AND NEW.edits IS NOT OLD.edits)
     OR substr(NEW.edits, 1, length(OLD.edits)) IS NOT OLD.edits
   BEGIN SELECT RAISE(ABORT, 'an episode''s edits are appended while it is open, and never rewritten'); END;
   CREATE TRIGGER episodes_resolved_once BEFORE UPDATE ON episodes
   WHEN OLD.resolved_at IS NOT NULL AND (${anyChanged(RESOLVED_COLUMNS)})
   BEGIN SELECT RAISE(ABORT, 'a resolved episode is evidence, and its resolution is written once'); END;
   CREATE TRIGGER episodes_diagnosis_once BEFORE UPDATE OF diagnosis ON episodes
   WHEN OLD.diagnosis IS NOT NULL AND NEW.diagnosis IS NOT OLD.diagnosis
   BEGIN SELECT RAISE(ABORT, 'an episode''s diagnosis is written once'); END;`,
  // 12d: one row per replayed run. The manifest a run was replayed from is a
  // blob, named on every row, so a result can always say exactly what it was a
  // result of. `arm` is `with`, `without` or `regression`.
  `CREATE TABLE replays (
     id INTEGER PRIMARY KEY, episode_id INTEGER NOT NULL, lesson_id INTEGER, arm TEXT NOT NULL, n INTEGER NOT NULL,
     outcome TEXT NOT NULL, steps INTEGER NOT NULL, ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
     build_reached INTEGER NOT NULL, manifest_blob TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX replays_lesson ON replays(lesson_id, at);`,
];

/** The `sha256` of a string's UTF-8 bytes, hex. */
export function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

/** Open (and create, and tidy) the knowledge database inside `dataDir`. */
export function openKnowledge(dataDir: string, options: OpenKnowledgeOptions = {}): Knowledge {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, KNOWLEDGE_FILE), { create: true, strict: true });
  // The same three as the run store: WAL so reading never blocks the launcher
  // writing, and a busy timeout because a `serve` and a launcher tab may both
  // have it open.
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

  retain(db, options.now ?? Date.now());

  let closed = false;
  return {
    db,
    putBlob(content: string): string {
      const hash = sha256(content);
      db.query<null, [string, number, string, number]>(
        'INSERT OR IGNORE INTO blobs (hash, bytes, content, created_at) VALUES (?, ?, ?, ?)',
      ).run(hash, Buffer.byteLength(content, 'utf8'), content, Date.now());
      return hash;
    },
    getBlob(hash: string): string | null {
      return (
        db.query<{ content: string }, [string]>('SELECT content FROM blobs WHERE hash = ?').get(hash)
          ?.content ?? null
      );
    },
    close(): void {
      // Twice is harmless: the launcher's shutdown closes it, and so does the
      // command's own `finally`, whichever comes first.
      if (closed) return;
      closed = true;
      // Checkpointing folds the WAL back into the main file, so what is left
      // is one complete database rather than one that needs its sidecars.
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        // And out of WAL mode, which is what removes the file: the system
        // SQLite on macOS keeps an emptied `-wal` beside the database
        // otherwise. It only succeeds when this is the last connection, and
        // the next open turns WAL back on.
        db.exec('PRAGMA journal_mode = DELETE');
      } catch {
        // Another process has it open, or the checkpoint failed. Neither is a
        // reason to leave the handle open.
      }
      db.close();
    },
  };
}

/**
 * Retention, applied when the store opens.
 *
 * Events age out, and beyond a count the oldest go first, because a log that
 * only grows is a disk that eventually fills. Episodes are never deleted here:
 * they are the evidence everything later is built from, and there are few of
 * them. A blob lives as long as anything refers to it and otherwise follows
 * the events.
 */
function retain(db: Database, now: number): void {
  db.transaction(() => {
    db.query<null, [number]>('DELETE FROM events WHERE at < ?').run(now - EVENT_RETENTION_MS);
    db.query<null, [number]>(
      `DELETE FROM events WHERE id IN (
         SELECT id FROM events ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`,
    ).run(MAX_EVENTS);
    // Every subquery filters NULLs: `x NOT IN (…, NULL)` is never true, so one
    // stray NULL would keep every blob for ever.
    db.query<null, [number]>(
      `DELETE FROM blobs WHERE created_at < ? AND hash NOT IN (
         SELECT request_blob FROM episodes
         UNION SELECT example_blob FROM episodes WHERE example_blob IS NOT NULL
         UNION SELECT instructions_blob FROM contexts
         UNION SELECT system_blob FROM contexts
         UNION SELECT json_extract(item.value, '$.blob') FROM contexts, json_each(contexts.included) AS item
           WHERE json_extract(item.value, '$.blob') IS NOT NULL
         UNION SELECT manifest_blob FROM replays)`,
    ).run(now - BLOB_RETENTION_MS);
  })();
}

/**
 * The words of a message that say what went wrong, not where.
 *
 * Two failures are the same case when they differ only in the things that
 * change from one run to the next: the absolute path of the workspace or a
 * build's temporary directory, a line and column, a name in quotes, a hash, a
 * number. What is left is the shape of the complaint, and its hash names it.
 */
export function signature(stage: string, message: string): string {
  let text = message.toLowerCase();
  // A path inside the workspace keeps what is inside it, which is meaningful;
  // any other absolute path — a build's temporary directory, most often —
  // keeps only its last segment, which is the part that is not random.
  // Both start only where a path can start, so the relative `src/shared/…` a
  // message names inside the workspace is left alone.
  text = text.replace(/(?<=^|[\s'"`(=])(?:[a-z]:)?[\\/](?:[^\s'"`\\/]+[\\/])*?source[\\/]/g, '');
  text = text.replace(/(?<=^|[\s'"`(=])(?:[a-z]:)?[\\/](?:[^\s'"`\\/]+[\\/])+([^\s'"`\\/]+)/g, '$1');
  text = text.replace(/:\d+:\d+/g, '').replace(/:\d+/g, '');
  text = text.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'?'");
  text = text.replace(/[0-9a-f]{8,}/g, '#');
  text = text.replace(/\d/g, '0');
  text = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return sha256(`${stage}\n${text}`).slice(0, 32);
}

/**
 * Words that carry no meaning for finding a lesson.
 *
 * English function words, and the vocabulary every message in this system
 * shares — a lesson about `src/host/app.ts` is not found by the word "src".
 */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before',
  'being', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'down', 'each', 'few', 'for',
  'further', 'had', 'has', 'have', 'having', 'her', 'here', 'hers', 'him', 'his', 'how', 'into',
  'its', 'itself', 'just', 'more', 'most', 'must', 'nor', 'not', 'now', 'off', 'once', 'only',
  'other', 'our', 'ours', 'out', 'over', 'own', 'same', 'she', 'should', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'too', 'under', 'until', 'very', 'was', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'from', 'may',
  'might', 'shall', 'yet', 'please',
  'src', 'host', 'shared', 'app', 'apps', 'tsx', 'json', 'error', 'file', 'line',
]);

/** The words of a text worth searching for, at most sixteen. */
export function tokens(text: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3) continue;
    if (/^\p{N}+$/u.test(word)) continue;
    if (word.length >= 8 && /^[0-9a-f]+$/.test(word)) continue;
    if (STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length === 16) break;
  }
  return out;
}

/**
 * An FTS5 query for a text: every token, quoted, joined with `OR`.
 *
 * `OR` because FTS5's implicit operator between terms is `AND`, and a whole
 * request AND-ed together would match nothing that did not repeat it. Each
 * token is quoted so that a word FTS5 would read as an operator or a column
 * filter is only ever a word.
 */
export function ftsQuery(text: string): string | null {
  const words = tokens(text);
  if (words.length === 0) return null;
  return words.map((word) => `"${word.replace(/"/g, '""')}"`).join(' OR ');
}
