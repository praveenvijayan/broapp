/**
 * What a task's earlier attempts did, for the turn that tries it again.
 *
 * A retry used to be told the last verdict's sentences and nothing else: not
 * which files the attempt before it changed, not which build problem it left,
 * not that the same problem had come back twice. One bounded document says
 * that, built from what was recorded when it happened — the edit, build and
 * check events of each earlier run, the task's own history, and the planning
 * model's diagnosis — and from nothing a model wrote except that diagnosis.
 *
 * {@link attemptsDocument} is pure: plain input, one string or `null`. The
 * reads that feed it are {@link attemptsInput}, beside it, so a test can hand
 * the function exactly the case it means.
 */
import { NOT_AN_ATTEMPT, reasonsFromNote, type IntentStore, type TaskRecord } from '../intent/index.ts';

import { sanitise } from './log.ts';
import { problemSignature } from './scoring.ts';
import type { Knowledge } from './store.ts';

/** The most an attempts document may be. */
export const ATTEMPTS_DOCUMENT_CHARS = 1_500;
/** The most paths an attempt's `Changed:` line names. */
const MAX_PATHS = 8;
/** The most lines under `Ended with:`, and under `Still wrong at the end:`. */
const MAX_LINES = 3;
/** The longest one problem, detail or reason may be. */
const LINE_CHARS = 160;

/** One problem the last build of an attempt left. */
export interface AttemptProblem {
  readonly stage: string;
  readonly message: string;
}

/** One example the last check of an attempt ran. */
export interface AttemptCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** One earlier attempt, as plain data. */
export interface AttemptRecord {
  readonly attempt: number;
  /** How its move out of `in-progress` was written down; `null` when nothing was. */
  readonly ended: { readonly to: 'failed' | 'interrupted'; readonly note: string } | null;
  /** The paths its `edit` events name, in the order they were first edited. */
  readonly edited: readonly string[];
  /** The problems of its last build; empty when that build passed or none ran. */
  readonly lastBuild: readonly AttemptProblem[];
  /** The results of its last check, when that check came after its last build. */
  readonly lastCheck: readonly AttemptCheck[];
}

/** What {@link attemptsDocument} is built from. */
export interface AttemptsInput {
  readonly attempts: readonly AttemptRecord[];
  /** The planning model's diagnosis of the task's last failure, when there is one. */
  readonly diagnosis: string | null;
}

/** The first line of a text, sanitised and cut. */
function firstLine(text: string): string {
  const line = sanitise(text).split(/\r?\n/).find((part) => part.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length <= LINE_CHARS ? trimmed : `${trimmed.slice(0, LINE_CHARS - 1)}…`;
}

/** At most `max` lines, then "and <k> more". */
function bounded(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines];
  return [...lines.slice(0, max), `- and ${String(lines.length - max)} more`];
}

/** Whether an attempt is one the builder made. A move marked {@link NOT_AN_ATTEMPT} was not. */
function isAttempt(record: AttemptRecord): boolean {
  return record.ended === null || !record.ended.note.startsWith(NOT_AN_ATTEMPT);
}

/** One attempt's lines. */
function block(record: AttemptRecord): string[] {
  const stopped = record.ended?.to === 'interrupted';
  const lines = [`Attempt ${String(record.attempt)}${stopped ? ' (stopped before it finished)' : ''}`];
  const paths = record.edited.map((path) => sanitise(path));
  const named = paths.slice(0, MAX_PATHS).join(', ');
  const more = paths.length > MAX_PATHS ? ` and ${String(paths.length - MAX_PATHS)} more` : '';
  lines.push(`Changed: ${paths.length === 0 ? 'nothing' : `${named}${more}`}`);
  // An interrupted attempt lists only what it changed: how it would have
  // ended is not known, and what the build said halfway is not a result.
  if (stopped) return lines;
  if (record.ended !== null) {
    // How the turn ended first: when the list is cut, "The turn made no tool
    // call for 8 minutes" says more than a fourth "No example named … was run".
    const all = reasonsFromNote(record.ended.to, record.ended.note);
    const ordered = [...all.filter((reason) => reason.startsWith('The turn ')), ...all.filter((reason) => !reason.startsWith('The turn '))];
    const reasons = ordered.map((reason) => `- ${firstLine(reason)}`);
    if (reasons.length > 0) lines.push('Ended with:', ...bounded(reasons, MAX_LINES));
  }
  const wrong = [
    ...record.lastBuild.map((problem) => `- ${problem.stage}: ${firstLine(problem.message)}`),
    ...record.lastCheck.filter((check) => !check.passed).map((check) => `- ${check.id}: ${firstLine(check.detail ?? 'failed')}`),
  ];
  if (wrong.length > 0) lines.push('Still wrong at the end:', ...bounded(wrong, MAX_LINES));
  return lines;
}

/**
 * The problems present in the last build of two or more attempts, by
 * signature, with the attempts named. This is the line that tells a builder
 * not to try the same repair again.
 */
function cameBack(attempts: readonly AttemptRecord[]): string[] {
  const seen = new Map<string, { problem: AttemptProblem; attempts: number[] }>();
  for (const record of attempts) {
    const mine = new Set<string>();
    for (const problem of record.lastBuild) {
      const key = problemSignature(problem.stage, problem.message);
      if (mine.has(key)) continue;
      mine.add(key);
      const entry = seen.get(key) ?? { problem, attempts: [] };
      entry.attempts.push(record.attempt);
      seen.set(key, entry);
    }
  }
  const lines: string[] = [];
  for (const { problem, attempts: numbers } of seen.values()) {
    if (numbers.length < 2) continue;
    const named = `${numbers.slice(0, -1).join(', ')} and ${String(numbers[numbers.length - 1])}`;
    lines.push(`- ${problem.stage}: ${firstLine(problem.message)} (attempts ${named})`);
  }
  return lines.length === 0 ? [] : ['Came back:', ...bounded(lines, MAX_LINES)];
}

/** Lines joined, and how long that is. */
function size(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/**
 * What a task's earlier attempts did, or `null` when it has none that were
 * attempts.
 *
 * Oldest first. The newest attempt is never cut; when the whole does not fit
 * in {@link ATTEMPTS_DOCUMENT_CHARS}, the older attempts are cut at a line
 * from the end, then the diagnosis goes, then what came back — each bounded so
 * that the newest attempt alone always fits.
 */
export function attemptsDocument(input: AttemptsInput): string | null {
  const attempts = input.attempts.filter(isAttempt).sort((a, b) => a.attempt - b.attempt);
  const newest = attempts[attempts.length - 1];
  if (newest === undefined) return null;
  const older = attempts.slice(0, -1).flatMap(block);
  const last = block(newest);
  const back = cameBack(attempts);
  const diagnosis =
    input.diagnosis === null || input.diagnosis.trim() === ''
      ? []
      : [`How the planning model read it: ${sanitise(input.diagnosis).replace(/\s+/g, ' ').trim().slice(0, 400)}`];

  const budget = ATTEMPTS_DOCUMENT_CHARS;
  let tail = [...back, ...diagnosis];
  if (size(last) + size(tail) > budget) tail = back;
  if (size(last) + size(tail) > budget) tail = [];
  const room = budget - size(last) - size(tail);
  const kept: string[] = [];
  if (size(older) <= room) {
    kept.push(...older);
  } else {
    for (const line of older) {
      if (size(kept) + line.length + 1 > room - 2) break;
      kept.push(line);
    }
    kept.push('…');
  }
  return [...kept, ...last, ...tail].join('\n');
}

interface EventRow {
  id: number;
  kind: 'edit' | 'build' | 'check';
  data: string | null;
}

function parsedData(row: EventRow): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.data ?? '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The paths an `edit` event names, as the event wrote them. */
export function editedPaths(data: Record<string, unknown>): string[] {
  return listOf(data['paths']).filter((path): path is string => typeof path === 'string');
}

/** What one run left, read from its events. */
export function runRecord(knowledge: Knowledge, runId: string): Pick<AttemptRecord, 'edited' | 'lastBuild' | 'lastCheck'> {
  const rows = knowledge.db
    .query<EventRow, [string]>(
      "SELECT id, kind, data FROM events WHERE run_id = ? AND kind IN ('edit', 'build', 'check') ORDER BY id",
    )
    .all(runId);
  const edited: string[] = [];
  let build: EventRow | null = null;
  let check: EventRow | null = null;
  for (const row of rows) {
    if (row.kind === 'edit') {
      for (const path of editedPaths(parsedData(row))) if (!edited.includes(path)) edited.push(path);
    } else if (row.kind === 'build') {
      build = row;
    } else {
      check = row;
    }
  }
  const lastBuild: AttemptProblem[] = [];
  if (build !== null) {
    for (const problem of listOf(parsedData(build)['problems'])) {
      const { stage, message } = (problem ?? {}) as { stage?: unknown; message?: unknown };
      if (typeof stage === 'string' && typeof message === 'string') lastBuild.push({ stage, message });
    }
  }
  // A check older than the last build checked something that is gone.
  const lastCheck: AttemptCheck[] = [];
  if (check !== null && (build === null || check.id > build.id)) {
    for (const result of listOf(parsedData(check)['results'])) {
      const { id, passed, detail } = (result ?? {}) as { id?: unknown; passed?: unknown; detail?: unknown };
      if (typeof id !== 'string' || typeof passed !== 'boolean') continue;
      lastCheck.push({ id, passed, ...(typeof detail === 'string' ? { detail } : {}) });
    }
  }
  return { edited, lastBuild, lastCheck };
}

/**
 * The input for a task's attempts document: every run of the task before
 * `currentRunId`, joined to how each ended by its attempt number, and the
 * planning model's diagnosis. Both stores are read through their own handles.
 */
export function attemptsInput(
  knowledge: Knowledge,
  intents: IntentStore,
  task: TaskRecord,
  currentRunId: string | null,
): AttemptsInput {
  const runs = intents.runsOf(task.id);
  const current = runs.find((run) => run.runId === currentRunId)?.attempt ?? Number.POSITIVE_INFINITY;
  const notes = intents.attemptNotes(task.id);
  const attempts = runs
    .filter((run) => run.attempt < current)
    .map((run) => {
      const note = notes.find((row) => row.attempt === run.attempt);
      return {
        attempt: run.attempt,
        ended: note === undefined ? null : { to: note.to, note: note.note },
        ...runRecord(knowledge, run.runId),
      };
    });
  const advice = task.advice as { diagnosis?: unknown } | null;
  return { attempts, diagnosis: typeof advice?.diagnosis === 'string' ? advice.diagnosis : null };
}
