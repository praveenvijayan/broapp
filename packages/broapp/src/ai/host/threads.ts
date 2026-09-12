/**
 * Where conversations live.
 *
 * `<dataDir>/ai/threads.sqlite`, beside the settings and the secrets. A
 * conversation is the user's own writing, so nothing here asks whether a
 * provider is configured: somebody who has just deleted their key still owns
 * what they typed and must still be able to read and delete it.
 *
 * The host stores messages and never interprets them. Parts are the AI SDK's
 * shape, written as JSON and handed back to the browser unread, with one
 * deliberate exception on the way in — see {@link withoutImages}.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AssistantModelMessage, ToolModelMessage } from 'ai';

import type { HostLogger } from '../../host/app.ts';
import { canonicalJson } from '../../host/gate.ts';
import { publicError } from '../../shared/errors.ts';
import type { StoredMessage, Thread } from '../shared/types.ts';

/**
 * The migrations, in order.
 *
 * Each is applied once and `user_version` is set to its index. Adding a column
 * later means appending here — never editing an entry that has shipped,
 * because a database that already ran the old version will never run the new
 * one.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE threads (
     id         TEXT    PRIMARY KEY,
     title      TEXT    NOT NULL,
     model_id   TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX threads_updated_at ON threads (updated_at DESC);
   CREATE TABLE messages (
     thread_id TEXT    NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
     position  INTEGER NOT NULL,
     json      TEXT    NOT NULL,
     PRIMARY KEY (thread_id, position)
   );`,
  /*
   * A monotonic sequence, because a timestamp is not one.
   *
   * `updated_at` is milliseconds, and two writes inside one millisecond used
   * to be ordered by whichever random id sorted higher — so a list could come
   * back in a different order for the same history (report 07). `seq` is
   * bumped by every write that touches a conversation, so "most recently
   * changed first" means what it says. The backfill puts existing rows in the
   * order they were last shown in, `rowid` breaking the ties the old query
   * could not.
   */
  `ALTER TABLE threads ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
   UPDATE threads SET seq = (
     SELECT COUNT(*) FROM threads AS earlier
     WHERE earlier.updated_at < threads.updated_at
        OR (earlier.updated_at = threads.updated_at AND earlier.rowid <= threads.rowid)
   );
   CREATE INDEX threads_seq ON threads (seq DESC);`,
  /*
   * What the model itself saw and did on each turn, by run id.
   *
   * Written by the host from the AI SDK's own response messages, never from
   * anything a browser saved: a history turn that names a run gets these back
   * in place of its text. Not tied to a thread, because the host does not know
   * which conversation a run belongs to; the age and count caps are the bound.
   */
  `CREATE TABLE transcripts (
     run_id     TEXT    PRIMARY KEY,
     messages   TEXT    NOT NULL,
     chars      INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX transcripts_created_at ON transcripts (created_at);`,
];

/**
 * One message a turn produced: what `StreamTextResult.responseMessages` holds.
 *
 * `ai` declares `ResponseMessage` as exactly this union but does not export the
 * name, so it is spelled out here from the two types it does export.
 */
export type ResponseMessage = AssistantModelMessage | ToolModelMessage;

/** The most characters one transcript may be; a longer turn stays text. */
export const MAX_TRANSCRIPT_CHARS = 200_000;

/** How long a transcript is kept. */
const TRANSCRIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How many transcripts are kept, newest first. */
const TRANSCRIPT_MAX_COUNT = 2_000;

/** What a conversation is called until it has been named. */
export const DEFAULT_THREAD_TITLE = 'New conversation';

/** How much of the first message becomes the title. */
const TITLE_CHARS = 60;

/** The most conversations one listing returns, matching the contract's bound. */
const MAX_THREADS = 500;

/**
 * The most JSON one save may write.
 *
 * The contract bounds the *number* of messages and parts but not their size,
 * because a part is `unknown` by design. This is the bound on the amount: four
 * megabytes is far more than a conversation of 200 messages needs and far less
 * than a browser could use to fill somebody's disk.
 */
const MAX_SAVE_CHARS = 4_000_000;

/** A conversation and everything in it. */
export interface ThreadStore {
  readonly path: string;
  /** Most recently changed first, capped at 500. */
  list(): Thread[];
  create(input: { title?: string | undefined; modelId?: string | null | undefined }): Thread;
  get(id: string): { thread: Thread; messages: StoredMessage[] };
  /** Replaces the messages whole and bumps `updatedAt`. */
  save(input: {
    id: string;
    messages: readonly StoredMessage[];
    title?: string | undefined;
  }): Thread;
  update(input: {
    id: string;
    title?: string | undefined;
    modelId?: string | null | undefined;
  }): Thread;
  remove(id: string): boolean;
  /** Every conversation. Returns how many were deleted. */
  clear(): number;
  /**
   * Keep one turn's response messages under its run id.
   *
   * Unpaired tool calls are removed first, provider metadata is dropped, and a
   * transcript over {@link MAX_TRANSCRIPT_CHARS} is not written. Returns whether
   * a row was written. Throws when the store cannot write.
   */
  saveTranscript(runId: string, messages: readonly ResponseMessage[]): boolean;
  /** A transcript this store wrote, or null when it holds none that reads back whole. */
  transcript(runId: string): readonly ResponseMessage[] | null;
  /** Delete transcripts older than 30 days or beyond the newest 2,000. Returns how many went. */
  retainTranscripts(): number;
  close(): void;
}

/** Options for {@link openThreads}. */
export interface OpenThreadsOptions {
  /** Where an oversized or unreadable transcript is reported. Default `console`. */
  readonly logger?: HostLogger;
}

/** A plain object, for reading a stored or SDK-given value without trusting its type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of an object without the provider's own fields, which no later prompt needs. */
function withoutProviderFields(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === 'providerOptions' || key === 'providerMetadata' || key === 'providerExecuted') continue;
    out[key] = member;
  }
  return out;
}

/**
 * A turn's response messages as they are kept.
 *
 * Two edits and nothing else. A tool call with no result — a turn stopped while
 * the tool ran — is removed, because a provider refuses a prompt that has a call
 * without its answer; a message that edit leaves empty goes with it. Provider
 * metadata is dropped at the message, part and output level: it belongs to the
 * request it came from, and tool inputs and outputs are left exactly as given.
 */
export function transcriptForStorage(messages: readonly ResponseMessage[]): ResponseMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as readonly unknown[]) {
      if (isRecord(part) && part['type'] === 'tool-result' && typeof part['toolCallId'] === 'string') {
        answered.add(part['toolCallId']);
      }
    }
  }
  const out: ResponseMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      out.push(withoutProviderFields(message as unknown as Record<string, unknown>) as unknown as ResponseMessage);
      continue;
    }
    const content: unknown[] = [];
    for (const part of message.content as readonly unknown[]) {
      if (!isRecord(part)) continue;
      if (part['type'] === 'tool-call' && !answered.has(String(part['toolCallId']))) continue;
      const kept = withoutProviderFields(part);
      if (isRecord(kept['output'])) kept['output'] = withoutProviderFields(kept['output']);
      content.push(kept);
    }
    if (content.length === 0) continue;
    out.push({ ...withoutProviderFields(message as unknown as Record<string, unknown>), content } as unknown as ResponseMessage);
  }
  return out;
}

/**
 * Whether a stored value reads back as response messages.
 *
 * The row was written by this process, but a file can be edited or damaged, and
 * what comes back goes into a prompt. Only an assistant or tool message with a
 * string or an array of typed parts passes; a `system` role never does.
 */
function isTranscript(value: unknown): value is ResponseMessage[] {
  if (!Array.isArray(value)) return false;
  return value.every((message) => {
    if (!isRecord(message)) return false;
    const role = message['role'];
    const content = message['content'];
    if (role === 'assistant') {
      return typeof content === 'string' || (Array.isArray(content) && content.every((part) => isRecord(part) && typeof part['type'] === 'string'));
    }
    if (role === 'tool') {
      return Array.isArray(content) && content.every((part) => isRecord(part) && typeof part['type'] === 'string');
    }
    return false;
  });
}

/** A row of `threads`, joined with its message count. */
interface ThreadRow {
  id: string;
  title: string;
  model_id: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
  };
}

/** An id matching the contract's pattern: 32 hex characters. */
function newThreadId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** True for a part the AI SDK would render as an attachment. */
function isFilePart(part: unknown): part is { type: 'file'; filename?: unknown; mediaType?: unknown } {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'file';
}

/**
 * A message with its images replaced by the line that names them.
 *
 * A `file` part carries a data URL, so storing one would put a second copy of
 * the picture in SQLite that nobody asked to keep and nothing ever deletes.
 * The placeholder is the same line the browser already puts in `history`, so
 * a reloaded conversation says exactly what the model was told on the turns
 * after the one the image arrived on.
 */
function withoutImages(message: StoredMessage): StoredMessage {
  if (!message.parts.some(isFilePart)) return message;
  const parts = message.parts.map((part) => {
    if (!isFilePart(part)) return part;
    const name =
      typeof part.filename === 'string'
        ? part.filename
        : typeof part.mediaType === 'string'
          ? part.mediaType
          : 'image';
    return { type: 'text', text: `[image: ${name}]` };
  });
  return message.metadata === undefined
    ? { id: message.id, role: message.role, parts }
    : { id: message.id, role: message.role, parts, metadata: message.metadata };
}

/** The text of a message, for deriving a title. */
function textOf(message: StoredMessage): string {
  const lines: string[] = [];
  for (const part of message.parts) {
    if (typeof part !== 'object' || part === null) continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') lines.push(typed.text);
  }
  return lines.join(' ');
}

/** The first user message's opening words, or null when there is nothing to use. */
function derivedTitle(messages: readonly StoredMessage[]): string | null {
  const first = messages.find((message) => message.role === 'user');
  if (first === undefined) return null;
  const collapsed = textOf(first).replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.slice(0, TITLE_CHARS);
}

/** Open the conversation store for one data directory, migrating it as needed. */
export function openThreads(dataDir: string, options: OpenThreadsOptions = {}): ThreadStore {
  const logger = options.logger ?? console;
  const directory = join(dataDir, 'ai');
  // The same mode the settings store uses: this directory holds what somebody
  // wrote to their assistant, which is nobody else's business.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'threads.sqlite');
  const db = new Database(path, { create: true, strict: true });

  db.exec('PRAGMA journal_mode = WAL');
  // Without this, `ON DELETE CASCADE` is decoration: SQLite does not enforce a
  // foreign key unless it is asked to.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);

  const THREAD_COLUMNS = `t.id AS id, t.title AS title, t.model_id AS model_id,
       t.created_at AS created_at, t.updated_at AS updated_at,
       (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count`;

  const statements = {
    list: db.query<ThreadRow, [number]>(
      // `seq` only: it is unique and monotonic, so no tie-break is needed and
      // none can disagree with the order the writes actually happened in.
      `SELECT ${THREAD_COLUMNS} FROM threads t ORDER BY t.seq DESC LIMIT ?`,
    ),
    byId: db.query<ThreadRow, [string]>(
      `SELECT ${THREAD_COLUMNS} FROM threads t WHERE t.id = ?`,
    ),
    /*
     * Both writes take the next sequence in the same statement that changes
     * the row, so the number a conversation is ordered by is decided inside
     * whatever transaction is writing it — never by a second round trip that
     * another write could interleave with.
     */
    insert: db.query<unknown, [string, string, string | null, number, number]>(
      `INSERT INTO threads (id, title, model_id, created_at, updated_at, seq)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM threads))`,
    ),
    touch: db.query<unknown, [string, string | null, number, string]>(
      `UPDATE threads SET title = ?, model_id = ?, updated_at = ?,
         seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM threads)
       WHERE id = ?`,
    ),
    messages: db.query<{ json: string }, [string]>(
      'SELECT json FROM messages WHERE thread_id = ? ORDER BY position ASC',
    ),
    deleteMessages: db.query<unknown, [string]>('DELETE FROM messages WHERE thread_id = ?'),
    insertMessage: db.query<unknown, [string, number, string]>(
      'INSERT INTO messages (thread_id, position, json) VALUES (?, ?, ?)',
    ),
    remove: db.query<{ id: string }, [string]>('DELETE FROM threads WHERE id = ? RETURNING id'),
    count: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM threads'),
    clear: db.query<unknown, []>('DELETE FROM threads'),
    saveTranscript: db.query<unknown, [string, string, number, number]>(
      `INSERT INTO transcripts (run_id, messages, chars, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET messages = excluded.messages, chars = excluded.chars,
         created_at = excluded.created_at`,
    ),
    transcript: db.query<{ messages: string }, [string]>('SELECT messages FROM transcripts WHERE run_id = ?'),
    expireTranscripts: db.query<{ run_id: string }, [number]>(
      'DELETE FROM transcripts WHERE created_at < ? RETURNING run_id',
    ),
    capTranscripts: db.query<{ run_id: string }, [number]>(
      `DELETE FROM transcripts WHERE rowid NOT IN (
         SELECT rowid FROM transcripts ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) RETURNING run_id`,
    ),
  };

  /** One unreadable transcript is reported once, not on every turn that names it. */
  const reported = new Set<string>();

  /** Both caps, in one transaction, so a crash never leaves one applied without the other. */
  const retain = (): number =>
    db.transaction(() => {
      const expired = statements.expireTranscripts.all(Date.now() - TRANSCRIPT_MAX_AGE_MS).length;
      return expired + statements.capTranscripts.all(TRANSCRIPT_MAX_COUNT).length;
    })();

  /** The row, or the sentence a browser shows when a conversation is gone. */
  function mustGet(id: string): ThreadRow {
    const row = statements.byId.get(id);
    if (row === null) throw publicError.notFound('That conversation is gone.');
    return row;
  }

  // Retention runs on open as well as on every save, so a store that is only
  // read still sheds what has aged out.
  retain();

  const store: ThreadStore = {
    path,

    list() {
      return statements.list.all(MAX_THREADS).map(toThread);
    },

    create({ title, modelId }) {
      const now = Date.now();
      const id = newThreadId();
      statements.insert.run(id, title ?? DEFAULT_THREAD_TITLE, modelId ?? null, now, now);
      return toThread(mustGet(id));
    },

    get(id) {
      const thread = toThread(mustGet(id));
      const messages = statements.messages.all(id).map((row) => {
        // Written by this process, from a value the contract validated. A
        // parse failure would mean the file was edited by hand or corrupted,
        // and the conversation is unreadable either way.
        return JSON.parse(row.json) as StoredMessage;
      });
      return { thread, messages };
    },

    save({ id, messages, title }) {
      const row = mustGet(id);
      const stored = messages.map(withoutImages);
      const encoded = stored.map((message) => JSON.stringify(message));
      const characters = encoded.reduce((total, json) => total + json.length, 0);
      if (characters > MAX_SAVE_CHARS) {
        throw publicError.invalidInput('That conversation is too large to save.');
      }
      // A title given wins; otherwise a conversation still carrying the
      // default name takes one from what the person actually asked.
      const named =
        title ?? (row.title === DEFAULT_THREAD_TITLE ? (derivedTitle(stored) ?? row.title) : row.title);
      const now = Date.now();
      // One transaction: a save that failed half way would leave a
      // conversation holding the first few messages of the new list and none
      // of the old.
      db.transaction(() => {
        statements.deleteMessages.run(id);
        for (let index = 0; index < encoded.length; index += 1) {
          const json = encoded[index];
          if (json === undefined) continue;
          statements.insertMessage.run(id, index, json);
        }
        statements.touch.run(named, row.model_id, now, id);
      })();
      return toThread(mustGet(id));
    },

    update({ id, title, modelId }) {
      const row = mustGet(id);
      statements.touch.run(
        title ?? row.title,
        modelId === undefined ? row.model_id : modelId,
        Date.now(),
        id,
      );
      return toThread(mustGet(id));
    },

    remove(id) {
      return statements.remove.get(id) !== null;
    },

    clear() {
      const before = statements.count.get()?.n ?? 0;
      statements.clear.run();
      return before;
    },

    saveTranscript(runId, messages) {
      const kept = transcriptForStorage(messages);
      const json = canonicalJson(kept);
      if (json.length > MAX_TRANSCRIPT_CHARS) {
        logger.warn(
          `[broapp] ai transcript for run ${runId} is ${String(json.length)} characters, over ${String(MAX_TRANSCRIPT_CHARS)}; the turn stays text`,
        );
        return false;
      }
      db.transaction(() => {
        statements.saveTranscript.run(runId, json, json.length, Date.now());
        retain();
      })();
      return true;
    },

    transcript(runId) {
      const row = statements.transcript.get(runId);
      if (row === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.messages);
      } catch {
        parsed = undefined;
      }
      if (!isTranscript(parsed) || row.messages.length > MAX_TRANSCRIPT_CHARS) {
        if (!reported.has(runId)) {
          reported.add(runId);
          logger.warn(`[broapp] ai transcript for run ${runId} does not read back as messages; the turn stays text`);
        }
        return null;
      }
      return parsed;
    },

    retainTranscripts: retain,

    close() {
      // Checkpointing folds the WAL back into the main file, so what is left
      // behind is one complete database rather than one that needs its
      // sidecars to be readable.
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // A checkpoint that fails is not a reason to leave the handle open.
      }
      db.close();
    },
  };

  return store;
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
      `the conversation store's schema version ${String(from)} is newer than this build understands (${String(MIGRATIONS.length)})`,
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
