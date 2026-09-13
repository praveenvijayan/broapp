/**
 * A person's changes to the lessons: confirm, retire, write, replace.
 *
 * The command line and the launcher's tab both come here, so the two write the
 * same rows — the lesson, its full-text row and one corpus version — and a
 * lesson confirmed from either is the same lesson. What differs between them
 * is only what surrounds the write: the command line refuses while a launcher
 * is serving from its root, because it would be writing under a process it
 * cannot tell, and the tab is that process, so there is nothing to refuse.
 *
 * A lesson's text is never edited in place. Its servings and its provenance
 * point at what was actually served, and a lesson that changed under them would
 * turn that record into a record of something no model ever read. A correction
 * is a new lesson that supersedes the old one, exactly as the distiller's own
 * supersession is.
 */
import type { Database } from 'bun:sqlite';

import { publicError } from 'broapp/host';

import { ENGINEER_INSTRUCTIONS } from '../engineer/instructions.ts';
import { BUILD_STAGES } from '../launcher/candidate.ts';
import { APP_ID_PATTERN } from '../spec/types.ts';

import { instructionsHash } from './freshness.ts';
import { sanitise } from './log.ts';
import type { Knowledge } from './store.ts';
import { AUTOAPP_VERSION } from './version.ts';

/** The limits of a lesson a person writes. */
export const WRITTEN_SUMMARY_MAX = 300;
export const WRITTEN_DETAIL_MAX = 2_000;
export const WRITTEN_TRIGGER_MAX = 300;
/** What `applies` may list, as the distiller's schema allows it. */
const APPLIES_ITEMS_MAX = 5;
const ROUTE_MAX = 80;
const FILE_MAX = 120;

/** The stages a lesson may apply to: a build's, or the acceptance check. */
export const LESSON_STAGES: readonly string[] = [...BUILD_STAGES, 'check'];

/** One lesson row, as every writer inserts it. */
export interface LessonColumns {
  readonly version: number;
  readonly status: 'provisional' | 'confirmed';
  readonly origin: 'curated' | 'distilled';
  readonly episodeId: number | null;
  readonly supersedes: number | null;
  readonly diagnosis: string | null;
  readonly scope: string;
  /** JSON. */
  readonly applies: string;
  readonly summary: string;
  readonly detail: string;
  readonly trigger: string;
  readonly instructionsHash: string;
  readonly autoappVersion: string;
  readonly now: number;
  /** For a person's own lesson: who wrote it counts as its review. */
  readonly reviewedBy?: string | null;
}

/**
 * Insert one lesson with the column list every writer shares.
 *
 * `orIgnore` is the distiller's: a second distillation of the same case meets
 * the unique index on `episode_id` and is a no-op. Returns the new id, or
 * `null` when nothing was inserted. The full-text row and the corpus version
 * are the caller's, inside the caller's transaction.
 */
export function insertLesson(db: Database, row: LessonColumns, options: { orIgnore?: boolean } = {}): number | null {
  const inserted = db
    .query<
      null,
      [number, string, string, number | null, number | null, string | null, string, string, string, string, string, string, string, number, number, string | null, number | null]
    >(
      `INSERT ${options.orIgnore === true ? 'OR IGNORE ' : ''}INTO lessons
         (version, status, origin, episode_id, supersedes, diagnosis, scope, applies, summary, detail, trigger,
          instructions_hash, autoapp_version, created_at, updated_at, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.version,
      row.status,
      row.origin,
      row.episodeId,
      row.supersedes,
      row.diagnosis,
      row.scope,
      row.applies,
      row.summary,
      row.detail,
      row.trigger,
      row.instructionsHash,
      row.autoappVersion,
      row.now,
      row.now,
      row.reviewedBy ?? null,
      row.reviewedBy === undefined || row.reviewedBy === null ? null : row.now,
    );
  return inserted.changes === 0 ? null : Number(inserted.lastInsertRowid);
}

/** The next corpus version. */
function nextVersion(db: Database): number {
  return (db.query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM corpus_versions').get()?.v ?? 0) + 1;
}

/** One corpus version row. */
function corpusChange(db: Database, version: number, lessonId: number, change: string, now: number): void {
  db.query<null, [number, number, string, number]>(
    'INSERT INTO corpus_versions (version, lesson_id, change, at) VALUES (?, ?, ?, ?)',
  ).run(version, lessonId, change, now);
}

/**
 * Confirm a lesson. Returns whether anything changed.
 *
 * A provisional lesson becomes confirmed. A confirmed lesson carrying a review
 * flag is confirmed again, which is how a person clears the flag after looking;
 * one with no flag is already what it would become, and nothing is written.
 */
export function confirmLesson(knowledge: Knowledge, id: number, by: string, now: number = Date.now()): boolean {
  const { db } = knowledge;
  return db.transaction((): boolean => {
    const updated = db
      .query<null, [string, number, number, number]>(
        `UPDATE lessons SET status = 'confirmed', review = NULL, reviewed_by = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND (status = 'provisional' OR (status = 'confirmed' AND review IS NOT NULL))`,
      )
      .run(by, now, now, id).changes;
    if (updated === 0) return false;
    corpusChange(db, nextVersion(db), id, 'confirm', now);
    return true;
  })();
}

/**
 * Retire a provisional or confirmed lesson. Returns whether anything changed.
 *
 * It leaves the full-text index, so nothing matches it again; its servings and
 * its case stay, because they are the record of what happened while it was
 * served.
 */
export function retireLesson(knowledge: Knowledge, id: number, by: string, now: number = Date.now()): boolean {
  const { db } = knowledge;
  return db.transaction((): boolean => {
    const updated = db
      .query<null, [string, number, number, number]>(
        `UPDATE lessons SET status = 'retired', review = NULL, reviewed_by = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('provisional', 'confirmed')`,
      )
      .run(by, now, now, id).changes;
    if (updated === 0) return false;
    db.query<null, [number]>('DELETE FROM lessons_fts WHERE rowid = ?').run(id);
    corpusChange(db, nextVersion(db), id, 'retire', now);
    return true;
  })();
}

/** What a person writes. */
export interface LessonInput {
  readonly summary: string;
  readonly detail: string;
  /** The words a request would contain when this applies. */
  readonly trigger: string;
  /** `global`, or `app:<id>`. */
  readonly scope: string;
  readonly applies?: {
    readonly stage?: string;
    readonly routes?: readonly string[];
    readonly files?: readonly string[];
  };
  /** The lesson this one replaces. */
  readonly supersedes?: number;
}

/** A refusal naming the field, as a browser or the command line is told it. */
function refuse(field: string, reason: string): never {
  throw publicError.invalidInput(`${field}: ${reason}`);
}

/** A required text field, trimmed. */
function text(field: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === '') refuse(field, 'is required.');
  if (trimmed.length > max) refuse(field, `is ${String(trimmed.length)} characters; at most ${String(max)}.`);
  return trimmed;
}

/** A short list of short strings, empty entries dropped. */
function list(field: string, value: readonly string[] | undefined, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.map((item) => item.trim()).filter((item) => item !== '');
  if (items.length === 0) return undefined;
  if (items.length > APPLIES_ITEMS_MAX) refuse(field, `lists ${String(items.length)}; at most ${String(APPLIES_ITEMS_MAX)}.`);
  const long = items.find((item) => item.length > max);
  if (long !== undefined) refuse(field, `an entry is over ${String(max)} characters.`);
  return items;
}

/**
 * Write a curated, confirmed lesson; with `supersedes`, replace one.
 *
 * Written by a person, so it is confirmed from the start and its writer is its
 * reviewer. The lesson it supersedes becomes `superseded` and leaves the index
 * in the same transaction, so there is no moment at which both are served.
 * Returns the new lesson's id.
 */
export function writeLesson(knowledge: Knowledge, input: LessonInput, by: string, now: number = Date.now()): number {
  const summary = text('summary', input.summary, WRITTEN_SUMMARY_MAX);
  const detail = text('detail', input.detail, WRITTEN_DETAIL_MAX);
  const trigger = text('trigger', input.trigger, WRITTEN_TRIGGER_MAX);
  const scope = input.scope.trim();
  if (scope !== 'global' && !(scope.startsWith('app:') && APP_ID_PATTERN.test(scope.slice(4)))) {
    refuse('scope', 'is neither global nor app:<id>.');
  }
  const stage = input.applies?.stage?.trim();
  if (stage !== undefined && stage !== '' && !LESSON_STAGES.includes(stage)) {
    refuse('stage', `is not one of ${LESSON_STAGES.join(', ')}.`);
  }
  const routes = list('routes', input.applies?.routes, ROUTE_MAX);
  const files = list('files', input.applies?.files, FILE_MAX);
  const applies = {
    ...(stage === undefined || stage === '' ? {} : { stage }),
    ...(files === undefined ? {} : { files }),
    ...(routes === undefined ? {} : { routes }),
  };

  const { db } = knowledge;
  return db.transaction((): number => {
    const replaced = input.supersedes;
    if (replaced !== undefined) {
      const old = db.query<{ status: string }, [number]>('SELECT status FROM lessons WHERE id = ?').get(replaced);
      if (old === null) throw publicError.notFound(`There is no lesson ${String(replaced)}.`);
      if (old.status !== 'provisional' && old.status !== 'confirmed') {
        throw publicError.conflict(`Lesson ${String(replaced)} is ${old.status}; only a served lesson can be replaced.`);
      }
    }
    const version = nextVersion(db);
    // Sanitised as the distiller's are: a lesson is served to a model, and the
    // paths of this machine are not something it should be given.
    const id = insertLesson(db, {
      version,
      status: 'confirmed',
      origin: 'curated',
      episodeId: null,
      supersedes: replaced ?? null,
      diagnosis: null,
      scope,
      applies: JSON.stringify(applies),
      summary: sanitise(summary),
      detail: sanitise(detail),
      trigger: sanitise(trigger),
      instructionsHash: instructionsHash(ENGINEER_INSTRUCTIONS),
      autoappVersion: AUTOAPP_VERSION,
      now,
      reviewedBy: by,
    });
    if (id === null) throw publicError.conflict('The lesson could not be written.');
    db.query<null, [number, string, string]>('INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)').run(
      id,
      sanitise(summary),
      sanitise(trigger),
    );
    corpusChange(db, version, id, 'write', now);
    if (replaced !== undefined) {
      db.query<null, [number, number]>("UPDATE lessons SET status = 'superseded', updated_at = ? WHERE id = ?").run(now, replaced);
      db.query<null, [number]>('DELETE FROM lessons_fts WHERE rowid = ?').run(replaced);
      corpusChange(db, version + 1, replaced, 'supersede', now);
    }
    return id;
  })();
}
