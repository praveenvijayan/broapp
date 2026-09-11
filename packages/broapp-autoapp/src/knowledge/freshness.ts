/**
 * Which lessons a person should look at again, and why.
 *
 * Three questions, asked once when the launcher starts. Has a lesson been
 * served for a failure that kept coming back, and never once gone away? Were
 * the instructions it was written against rewritten, and has it failed since?
 * Was it distilled by a launcher of another minor version, whose tools and
 * build may no longer behave the way it describes?
 *
 * Each answer is a flag in `review`, never a change of `status`. A lesson that
 * recurs may be wrong, or may be right about a failure with a second cause; the
 * outcomes are association, not proof, and deciding which is a person's job.
 * `knowledge confirm` and `knowledge retire` clear the flag, and only
 * servings after that review count towards the next one.
 */
import { sha256, type Knowledge } from './store.ts';

/** The three reasons, as stored. */
export const REVIEW_REASONS = [
  'needs_review:recurring',
  'needs_review:instructions_changed',
  'needs_review:autoapp_upgraded',
] as const;

/** Recurrences, with nothing resolved, before a lesson is flagged as recurring. */
const RECURRING_AT = 3;
/** Recurrences under instructions it was not written against before that is flagged. */
const CHANGED_AT = 2;

/** The identity of a version of the instructions, as a lesson records it. */
export function instructionsHash(instructions: string): string {
  return sha256(instructions).slice(0, 32);
}

/** `major.minor` of a version string, or the whole string when it is not one. */
function minorOf(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match === null ? version : `${match[1] ?? ''}.${match[2] ?? ''}`;
}

/** Outcomes of this kind since the lesson was last reviewed. */
function since(outcome: string): string {
  return `(SELECT COUNT(*) FROM servings s
            WHERE s.lesson_id = lessons.id AND s.included = 1 AND s.outcome = '${outcome}'
              AND s.served_at > COALESCE(lessons.reviewed_at, 0))`;
}

/**
 * Flag the lessons a person should look at again.
 *
 * Only a lesson with no flag already is flagged: the first reason found is the
 * one a person is shown, and a second would overwrite a reason they had not yet
 * read. Nothing here touches `status`.
 */
export function reviewFlags(
  knowledge: Knowledge,
  input: { readonly instructionsHash: string; readonly autoappVersion: string; readonly now?: number },
): void {
  const { db } = knowledge;
  const now = input.now ?? Date.now();
  const active = "review IS NULL AND status IN ('provisional', 'confirmed')";
  db.transaction(() => {
    db.query<null, [number]>(
      `UPDATE lessons SET review = 'needs_review:recurring', updated_at = ?
        WHERE ${active} AND ${since('recurred')} >= ${String(RECURRING_AT)} AND ${since('resolved')} = 0`,
    ).run(now);
    db.query<null, [number, string]>(
      `UPDATE lessons SET review = 'needs_review:instructions_changed', updated_at = ?
        WHERE ${active} AND instructions_hash <> ? AND ${since('recurred')} >= ${String(CHANGED_AT)}`,
    ).run(now, input.instructionsHash);
    // A person who reviewed a lesson has judged it, and a version string
    // cannot say whether that was before or after the upgrade; so only lessons
    // nobody has reviewed are flagged for it.
    const running = minorOf(input.autoappVersion);
    const distilled = db
      .query<{ id: number; autoapp_version: string }, []>(
        `SELECT id, autoapp_version FROM lessons WHERE ${active} AND origin = 'distilled' AND reviewed_at IS NULL`,
      )
      .all();
    for (const lesson of distilled) {
      if (minorOf(lesson.autoapp_version) === running) continue;
      db.query<null, [number, number]>(
        "UPDATE lessons SET review = 'needs_review:autoapp_upgraded', updated_at = ? WHERE id = ? AND review IS NULL",
      ).run(now, lesson.id);
    }
  })();
}
