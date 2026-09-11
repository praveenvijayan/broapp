/**
 * What happened after a lesson was served.
 *
 * Association, never proof. A serving is closed by the first build or check
 * that could say something about it — a build that ran its stage, a check that
 * ran its example — with what that attempt found: the failure it was served
 * for was gone (`resolved`), was still there (`recurred`), could not be judged
 * (`inconclusive`), or the attempt was about something else (`unrelated`). A
 * build that stopped before the serving's stage says nothing, so the serving
 * stays open and only an event records that it waited (`blocked`). A turn that
 * ends with a serving still open closes it as `none`.
 *
 * Nothing here promotes, retires or ranks a lesson. An outcome is a fact about
 * one attempt; what to make of many of them is a person's decision, later.
 *
 * A serving that never reached the model (`included = 0`) is never scored: a
 * lesson cannot be credited or blamed for what it was not seen to say.
 */
import type { CheckResult } from '../engineer/state.ts';
import type { BuildCandidateResult } from '../launcher/candidate.ts';

import type { FullOrigin } from './ids.ts';
import { sanitise, type EventLog } from './log.ts';
import { signature, type Knowledge } from './store.ts';

/** The six outcomes a serving can have. `blocked` is only ever an event. */
export type Outcome = 'resolved' | 'recurred' | 'blocked' | 'inconclusive' | 'unrelated' | 'none';

/**
 * A problem's signature, computed exactly as a case's is.
 *
 * Sanitised first, as `evidence.open` does, so a serving and the case opened
 * for the same failure name it with the same hash.
 */
export function problemSignature(stage: string, message: string): string {
  return signature(stage, sanitise(message));
}

interface OpenServing {
  id: number;
  lesson_id: number;
  run_id: string;
  for_signature: string;
  for_stage: string;
  for_example_hash: string;
  applies: string;
}

/** Every open, delivered serving of an application. */
function openServings(knowledge: Knowledge, appId: string): OpenServing[] {
  return knowledge.db
    .query<OpenServing, [string]>(
      `SELECT s.id, s.lesson_id, s.run_id, s.for_signature, s.for_stage, s.for_example_hash, l.applies
         FROM servings s JOIN lessons l ON l.id = s.lesson_id
        WHERE s.app_id = ? AND s.outcome IS NULL AND s.included = 1
        ORDER BY s.id`,
    )
    .all(appId);
}

/** Close one serving, once. */
function close(
  knowledge: Knowledge,
  id: number,
  outcome: Exclude<Outcome, 'blocked'>,
  origin: FullOrigin,
  kind: 'build' | 'check',
  release: string | null,
): void {
  knowledge.db
    .query<null, [string, string, string, string | null, number, number]>(
      `UPDATE servings
          SET outcome = ?, attempt_call_id = ?, attempt_kind = ?, attempt_release = ?, attempt_at = ?
        WHERE id = ? AND outcome IS NULL`,
    )
    .run(outcome, origin.callId, kind, release, Date.now(), id);
}

/** The globs a lesson's `applies.files` names. */
function filesOf(applies: string): readonly string[] {
  try {
    const parsed = JSON.parse(applies) as { files?: unknown };
    return Array.isArray(parsed.files) ? parsed.files.filter((file): file is string => typeof file === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether a run's edits touched a file one of the globs matches. */
function editsTouched(knowledge: Knowledge, runId: string, appId: string, globs: readonly string[]): boolean {
  if (runId === '' || globs.length === 0) return false;
  const matchers = globs.map((glob) => new Bun.Glob(glob));
  const rows = knowledge.db
    .query<{ data: string | null }, [string, string]>(
      "SELECT data FROM events WHERE kind = 'edit' AND run_id = ? AND app_id = ?",
    )
    .all(runId, appId);
  for (const row of rows) {
    let paths: unknown;
    try {
      paths = (JSON.parse(row.data ?? '{}') as { paths?: unknown }).paths;
    } catch {
      continue;
    }
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      if (typeof path === 'string' && matchers.some((matcher) => matcher.match(path))) return true;
    }
  }
  return false;
}

/**
 * Score a build against every open serving of the application.
 *
 * Eligible only where the build ran the serving's stage; a check serving is
 * never closed by a build, because a build says nothing about behaviour.
 */
export function scoreBuild(
  knowledge: Knowledge,
  appId: string,
  result: BuildCandidateResult,
  origin: FullOrigin,
  log?: EventLog,
): void {
  const ran = new Set<string>(result.stagesRun);
  const present = new Set(
    result.ok ? [] : result.problems.map((problem) => problemSignature(problem.stage, problem.message)),
  );
  const release = result.ok ? result.releaseId : null;
  for (const serving of openServings(knowledge, appId)) {
    if (serving.for_example_hash !== '') continue;
    if (serving.for_stage !== '' && !ran.has(serving.for_stage)) {
      log?.event(
        'log',
        `a serving of lesson ${String(serving.lesson_id)} waits: the build did not run ${serving.for_stage}`,
        undefined,
        origin,
      );
      continue;
    }
    let outcome: Exclude<Outcome, 'blocked'>;
    if (serving.for_signature !== '') {
      outcome = present.has(serving.for_signature) ? 'recurred' : 'resolved';
    } else {
      // A turn serving names no failure. The only thing a build can say about
      // it is whether it passed after the turn edited what the lesson is about.
      outcome =
        result.ok && editsTouched(knowledge, serving.run_id, appId, filesOf(serving.applies)) ? 'resolved' : 'unrelated';
    }
    close(knowledge, serving.id, outcome, origin, 'build', release);
  }
}

/**
 * Score a check against the servings for the examples it ran.
 *
 * Only the exact example content: an example whose `expect` was edited is a
 * different example, and a pass of it says nothing about the old one.
 */
export function scoreCheck(
  knowledge: Knowledge,
  appId: string,
  results: readonly CheckResult[],
  examples: readonly { id: string; hash: string }[],
  releaseId: string,
  origin: FullOrigin,
): void {
  for (const serving of openServings(knowledge, appId)) {
    if (serving.for_example_hash === '') continue;
    const example = examples.find((entry) => entry.hash === serving.for_example_hash);
    if (example === undefined) continue;
    const result = results.find((entry) => entry.id === example.id);
    if (result === undefined) continue;
    // A failure that is not the one the lesson was served for — the child died,
    // a step timed out, or the example fails some other way — cannot say
    // whether the lesson helped.
    const outcome: Exclude<Outcome, 'blocked'> = result.passed
      ? 'resolved'
      : problemSignature('check', result.detail ?? 'the example failed') === serving.for_signature
        ? 'recurred'
        : 'inconclusive';
    close(knowledge, serving.id, outcome, origin, 'check', releaseId);
  }
}

/** A turn has ended: whatever it was served and never tested is `none`. */
export function scoreRunEnd(knowledge: Knowledge, runId: string): void {
  knowledge.db
    .query<null, [string]>("UPDATE servings SET outcome = 'none' WHERE run_id = ? AND outcome IS NULL AND included = 1")
    .run(runId);
}
