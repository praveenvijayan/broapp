/**
 * `broapp-autoapp knowledge …` — a person reviewing what the launcher learnt.
 *
 * The only way a lesson becomes `confirmed` or `retired`. Nothing in the
 * launcher promotes or retires a lesson on its own: an outcome is a fact about
 * one attempt, and deciding what many of them mean is a person's call.
 *
 * It reads the database directly, the way `status` reads the root, so it works
 * whether or not a launcher is running. It refuses to *change* anything while
 * one is: the serving launcher holds the database open and has its lessons in
 * memory, and a change made underneath it would be served stale.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Layout } from '../spec/index.ts';

import { confirmLesson, retireLesson } from './review.ts';
import { unrelatedHintCredit } from './scoring.ts';
import { openKnowledge, type Knowledge } from './store.ts';
import { replayTable, type ReplayRow } from './verdict.ts';

/** One time a lesson was served, and what came of it. */
export interface LessonServing {
  readonly runId: string;
  readonly how: string;
  readonly included: boolean;
  readonly servedAt: number;
  readonly outcome: string | null;
  readonly attemptKind: string | null;
  readonly attemptCallId: string | null;
  readonly attemptRelease: string | null;
  readonly attemptAt: number | null;
}

/** The case a distilled lesson came from. */
export interface LessonProvenance {
  readonly episodeId: number;
  readonly appId: string;
  readonly stage: string;
  readonly problem: string;
  readonly request: string | null;
  readonly sourceRevBefore: string;
  readonly sourceRevAfter: string | null;
  readonly releaseBefore: string | null;
  readonly releaseAfter: string | null;
  readonly diagnosis: string | null;
  readonly reasoning: string | null;
}

/** Everything known about one lesson. */
export interface LessonRecord {
  readonly id: number;
  readonly version: number;
  readonly status: string;
  readonly review: string | null;
  readonly origin: string;
  readonly diagnosis: string | null;
  readonly scope: string;
  readonly applies: unknown;
  readonly summary: string;
  readonly detail: string;
  readonly trigger: string;
  readonly instructionsHash: string;
  readonly autoappVersion: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reviewedBy: string | null;
  readonly reviewedAt: number | null;
  readonly supersedes: number | null;
  readonly supersededBy: number | null;
  readonly provenance: LessonProvenance | null;
  readonly servings: readonly LessonServing[];
}

interface LessonRow {
  id: number;
  version: number;
  status: string;
  review: string | null;
  origin: string;
  episode_id: number | null;
  supersedes: number | null;
  diagnosis: string | null;
  scope: string;
  applies: string;
  summary: string;
  detail: string;
  trigger: string;
  instructions_hash: string;
  autoapp_version: string;
  created_at: number;
  updated_at: number;
  reviewed_by: string | null;
  reviewed_at: number | null;
}

/** A column that holds JSON, or the text itself when it does not parse. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The full record of one lesson, or `null` when there is none by that id. */
export function showLesson(knowledge: Knowledge, id: number): LessonRecord | null {
  const { db } = knowledge;
  const row = db.query<LessonRow, [number]>('SELECT * FROM lessons WHERE id = ?').get(id);
  if (row === null) return null;

  let provenance: LessonProvenance | null = null;
  if (row.episode_id !== null) {
    const episode = db
      .query<
        {
          id: number;
          app_id: string;
          stage: string;
          problem: string;
          request_blob: string;
          source_rev_before: string;
          source_rev_after: string | null;
          release_before: string | null;
          release_after: string | null;
          diagnosis: string | null;
        },
        [number]
      >(
        `SELECT id, app_id, stage, problem, request_blob, source_rev_before, source_rev_after,
                release_before, release_after, diagnosis FROM episodes WHERE id = ?`,
      )
      .get(row.episode_id);
    if (episode !== null) {
      const diagnosis = episode.diagnosis === null ? null : parsed(episode.diagnosis);
      const field = (name: string): string | null => {
        const value = typeof diagnosis === 'object' && diagnosis !== null ? (diagnosis as Record<string, unknown>)[name] : null;
        return typeof value === 'string' ? value : null;
      };
      provenance = {
        episodeId: episode.id,
        appId: episode.app_id,
        stage: episode.stage,
        problem: episode.problem,
        request: knowledge.getBlob(episode.request_blob),
        sourceRevBefore: episode.source_rev_before,
        sourceRevAfter: episode.source_rev_after,
        releaseBefore: episode.release_before,
        releaseAfter: episode.release_after,
        diagnosis: field('diagnosis'),
        reasoning: field('reasoning'),
      };
    }
  }

  const servings = db
    .query<
      {
        run_id: string;
        how: string;
        included: number;
        served_at: number;
        outcome: string | null;
        attempt_kind: string | null;
        attempt_call_id: string | null;
        attempt_release: string | null;
        attempt_at: number | null;
      },
      [number]
    >(
      `SELECT run_id, how, included, served_at, outcome, attempt_kind, attempt_call_id, attempt_release, attempt_at
         FROM servings WHERE lesson_id = ? ORDER BY id`,
    )
    .all(id)
    .map((serving) => ({
      runId: serving.run_id,
      how: serving.how,
      included: serving.included === 1,
      servedAt: serving.served_at,
      outcome: serving.outcome,
      attemptKind: serving.attempt_kind,
      attemptCallId: serving.attempt_call_id,
      attemptRelease: serving.attempt_release,
      attemptAt: serving.attempt_at,
    }));

  const supersededBy =
    db.query<{ id: number }, [number]>('SELECT id FROM lessons WHERE supersedes = ? ORDER BY id DESC LIMIT 1').get(id)
      ?.id ?? null;

  return {
    id: row.id,
    version: row.version,
    status: row.status,
    review: row.review,
    origin: row.origin,
    diagnosis: row.diagnosis,
    scope: row.scope,
    applies: parsed(row.applies),
    summary: row.summary,
    detail: row.detail,
    trigger: row.trigger,
    instructionsHash: row.instructions_hash,
    autoappVersion: row.autoapp_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    supersedes: row.supersedes,
    supersededBy,
    provenance,
    servings,
  };
}

/**
 * How many times a lesson's serving waited on a build that stopped short.
 *
 * `blocked` is never a stored outcome — the serving stays open for the build
 * that does run its stage — so it is counted from the events that record it.
 */
export function blockedCount(knowledge: Knowledge, id: number): number {
  return (
    knowledge.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = 'log' AND message LIKE ?")
      .get(`a serving of lesson ${String(id)} waits:%`)?.n ?? 0
  );
}

/** The process id of a launcher that is serving from this root, or `null`. */
function servingPid(root: Layout): number | null {
  let raw: string;
  try {
    raw = readFileSync(root.control, 'utf8');
  } catch {
    return null;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    return null;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  // Signal 0 asks whether the process exists without touching it. A control
  // file left by a launcher that was killed names a pid that is gone, and is
  // not a reason to refuse (report 09's finding).
  try {
    process.kill(pid, 0);
    return pid;
  } catch (cause) {
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    return code === 'EPERM' ? pid : null;
  }
}

/** Where a command writes. Tests capture both. */
export interface KnowledgeCommandOptions {
  readonly root: Layout;
  /** Everything after `knowledge`. */
  readonly argv: readonly string[];
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Who confirms, when `--by` does not say. Defaults to `$USER`. */
  readonly user?: string;
  readonly now?: number;
  /** Ask the person a question and return their answer. Defaults to reading a line from the terminal. */
  readonly ask?: (question: string) => string | null;
}

const USAGE =
  'knowledge <list [--provisional|--confirmed|--review|--method] | show <id> | confirm <id> [--by <name>] [--yes] | retire <id> | export [--json] | replay <caseId> [--with <lessonId>] [--runs n] | evaluate [--runs n] [--out <path>]>';

/** A `replays` row, as the table wants it. */
function replayRows(knowledge: Knowledge, where: string, ...params: number[]): (ReplayRow & { manifest: string; at: number })[] {
  return knowledge.db
    .query<
      {
        episode_id: number;
        arm: string;
        n: number;
        outcome: string;
        steps: number;
        ms: number;
        input_tokens: number | null;
        output_tokens: number | null;
        build_reached: number;
        manifest_blob: string;
        at: number;
      },
      number[]
    >(
      `SELECT episode_id, arm, n, outcome, steps, ms, input_tokens, output_tokens, build_reached, manifest_blob, at
         FROM replays WHERE ${where} ORDER BY id`,
    )
    .all(...params)
    .map((row) => ({
      arm: row.arm,
      n: row.n,
      episodeId: row.episode_id,
      outcome: row.outcome,
      steps: row.steps,
      ms: row.ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      buildReached: row.build_reached === 1,
      manifest: row.manifest_blob,
      at: row.at,
    }));
}

/**
 * What the replays say about a lesson: its latest replay's table, and the
 * latest regression result for each other case. Empty when none was run.
 */
export function replayEvidence(knowledge: Knowledge, lessonId: number): string[] {
  const armRows = replayRows(knowledge, "lesson_id = ? AND arm IN ('with', 'without')", lessonId);
  const regressions = replayRows(knowledge, "lesson_id = ? AND arm = 'regression'", lessonId);
  if (armRows.length === 0 && regressions.length === 0) return [];
  const lines: string[] = [];
  const latest = armRows.at(-1)?.manifest;
  if (latest !== undefined) {
    const batch = armRows.filter((row) => row.manifest === latest);
    lines.push(`replay of case ${String(batch[0]?.episodeId ?? '?')}, ${new Date(batch[0]?.at ?? 0).toISOString()}:`);
    lines.push(...replayTable(batch).map((line) => `  ${line}`));
  }
  const byCase = new Map<number, (typeof regressions)[number]>();
  for (const row of regressions) byCase.set(row.episodeId, row);
  if (byCase.size > 0) {
    lines.push('regression (a failure is shown, and blocks nothing):');
    for (const [episodeId, row] of byCase) lines.push(`  case ${String(episodeId)}: ${row.outcome}`);
  }
  return lines;
}

/** At most `max` characters, marked when cut. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A lesson as `show` prints it. */
function render(record: LessonRecord, counts?: { blocked: number; unrelatedByStage: number }): string[] {
  const lines = [
    `lesson ${String(record.id)}  ${record.status}${record.review === null ? '' : `  ${record.review}`}`,
    `  summary:   ${record.summary}`,
    `  detail:    ${record.detail}`,
    `  applies:   ${JSON.stringify(record.applies)}`,
    `  scope:     ${record.scope}`,
    `  origin:    ${record.origin}${record.diagnosis === null ? '' : ` (${record.diagnosis})`}, version ${String(record.version)}, written for launcher ${record.autoappVersion}, instructions ${record.instructionsHash.slice(0, 12)}`,
  ];
  if (record.reviewedAt !== null) {
    lines.push(`  reviewed:  by ${record.reviewedBy ?? 'unknown'} at ${new Date(record.reviewedAt).toISOString()}`);
  }
  if (record.supersedes !== null) lines.push(`  supersedes lesson ${String(record.supersedes)}`);
  if (record.supersededBy !== null) lines.push(`  superseded by lesson ${String(record.supersededBy)}`);
  const from = record.provenance;
  if (from !== null) {
    lines.push(
      `  from case ${String(from.episodeId)} in ${from.appId}, ${from.stage}: ${from.problem}`,
      `    request:   ${from.request ?? '(not recorded)'}`,
      `    revisions: ${from.sourceRevBefore} → ${from.sourceRevAfter ?? 'unknown'}`,
      `    releases:  ${from.releaseBefore ?? 'none'} → ${from.releaseAfter ?? 'none'}`,
      `    diagnosis: ${from.diagnosis ?? 'none'}${from.reasoning === null ? '' : ` — ${from.reasoning}`}`,
    );
  }
  lines.push(`  servings:  ${String(record.servings.length)}`);
  if (counts !== undefined) {
    const count = (outcome: string): number => record.servings.filter((serving) => serving.outcome === outcome).length;
    // The association noise beside the counts it inflates: `resolved` credit
    // that went to a hint whose stage was not the failure's.
    lines.push(
      `  outcomes:  resolved ${String(count('resolved'))} (of which unrelated by stage: ${String(counts.unrelatedByStage)}), recurred ${String(count('recurred'))}, blocked ${String(counts.blocked)}, inconclusive ${String(count('inconclusive'))}, unrelated ${String(count('unrelated'))}, none ${String(count('none'))}`,
    );
  }
  for (const serving of record.servings) {
    lines.push(
      `    ${new Date(serving.servedAt).toISOString()} ${serving.how} run ${serving.runId}${serving.included ? '' : ' (not delivered)'}: ${serving.outcome ?? 'open'}${serving.attemptKind === null ? '' : ` by ${serving.attemptKind} ${serving.attemptCallId ?? ''}${serving.attemptRelease === null ? '' : ` → ${serving.attemptRelease.slice(0, 8)}`}`}`,
    );
  }
  return lines;
}

/** The lesson id a command names, or `null` when it names none. */
function lessonIdOf(argument: string | undefined): number | null {
  if (argument === undefined || !/^\d+$/.test(argument)) return null;
  return Number(argument);
}

/** Run one `knowledge` command. Returns the exit code. */
export function runKnowledgeCommand(options: KnowledgeCommandOptions): number {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const [command, ...rest] = options.argv;
  const positional = rest.filter((argument) => !argument.startsWith('-'));

  if (command !== 'list' && command !== 'show' && command !== 'confirm' && command !== 'retire' && command !== 'export') {
    err(`usage: broapp-autoapp ${USAGE}`);
    return 1;
  }

  // Changes first check for a launcher, before the database is even opened.
  if (command === 'confirm' || command === 'retire') {
    const pid = servingPid(options.root);
    if (pid !== null) {
      err(
        `a launcher is serving from this directory (pid ${String(pid)}). Stop it first: it holds this database and serves lessons from memory, so a change made now would not reach it.`,
      );
      return 1;
    }
  }

  const knowledge = openKnowledge(join(options.root.root, 'launcher'));
  try {
    const { db } = knowledge;
    switch (command) {
      case 'list': {
        const where = rest.includes('--provisional')
          ? "WHERE status = 'provisional'"
          : rest.includes('--confirmed')
            ? "WHERE status = 'confirmed'"
            : rest.includes('--review')
              ? 'WHERE review IS NOT NULL'
              : rest.includes('--method')
                ? "WHERE diagnosis = 'method_unclear'"
                : '';
        const rows = db
          .query<{ id: number; status: string; review: string | null; scope: string; applies: string; summary: string }, []>(
            `SELECT id, status, review, scope, applies, summary FROM lessons ${where} ORDER BY id`,
          )
          .all();
        for (const row of rows) {
          const counts = db
            .query<{ outcome: string; n: number }, [number]>(
              'SELECT outcome, COUNT(*) AS n FROM servings WHERE lesson_id = ? AND outcome IS NOT NULL GROUP BY outcome',
            )
            .all(row.id);
          const count = (outcome: string): number => counts.find((entry) => entry.outcome === outcome)?.n ?? 0;
          const applies = parsed(row.applies);
          const stage =
            typeof applies === 'object' && applies !== null && typeof (applies as { stage?: unknown }).stage === 'string'
              ? (applies as { stage: string }).stage
              : '-';
          out(
            [
              String(row.id).padStart(4),
              row.status.padEnd(11),
              (row.review ?? '-').padEnd(34),
              row.scope.padEnd(12),
              stage.padEnd(8),
              `${String(count('resolved'))}/${String(count('recurred'))}/${String(blockedCount(knowledge, row.id))}/${String(count('unrelated'))}`.padEnd(9),
              cut(row.summary, 80),
            ].join('  '),
          );
        }
        if (rows.length === 0) out('No lessons.');
        return 0;
      }

      case 'show': {
        const id = lessonIdOf(positional[0]);
        if (id === null) {
          err('usage: broapp-autoapp knowledge show <id>');
          return 1;
        }
        const record = showLesson(knowledge, id);
        if (record === null) {
          err(`there is no lesson ${String(id)}`);
          return 1;
        }
        const counts = { blocked: blockedCount(knowledge, id), unrelatedByStage: unrelatedHintCredit(knowledge, id).byStage };
        for (const line of render(record, counts)) out(line);
        for (const line of replayEvidence(knowledge, id)) out(`  ${line}`);
        return 0;
      }

      case 'confirm':
      case 'retire': {
        const id = lessonIdOf(positional[0]);
        if (id === null) {
          err(`usage: broapp-autoapp knowledge ${command} <id>${command === 'confirm' ? ' [--by <name>]' : ''}`);
          return 1;
        }
        const at = rest.indexOf('--by');
        const by = (at < 0 ? undefined : rest[at + 1]) ?? options.user ?? Bun.env['USER'] ?? 'unknown';
        const now = options.now ?? Date.now();
        const status = command === 'confirm' ? 'confirmed' : 'retired';
        if (command === 'confirm') {
          // The evidence a replay gathered, shown to the person deciding. It
          // decides nothing itself: a person may have other evidence, so the
          // absence of a replay is said and does not stop them.
          const evidence = replayEvidence(knowledge, id);
          if (evidence.length === 0) {
            out(`no replay has been run; \`knowledge replay <caseId> --with ${String(id)}\` first`);
          } else {
            for (const line of evidence) out(line);
            if (!rest.includes('--yes')) {
              const answer = (options.ask ?? ((question: string) => prompt(question)))(`Confirm lesson ${String(id)}? [y/N]`);
              if ((answer ?? '').trim().toLowerCase() !== 'y') {
                out(`lesson ${String(id)} was not confirmed`);
                return 1;
              }
            }
          }
        }
        // The same rows the launcher's tab writes, from the same functions.
        const changed = command === 'confirm' ? confirmLesson(knowledge, id, by, now) : retireLesson(knowledge, id, by, now);
        if (!changed) {
          const current = db.query<{ status: string }, [number]>('SELECT status FROM lessons WHERE id = ?').get(id);
          // A confirmed lesson with nothing to review is already what a
          // confirmation would make it: said, and not an error.
          if (command === 'confirm' && current?.status === 'confirmed') {
            out(`lesson ${String(id)} is already confirmed`);
            return 0;
          }
          err(
            current === null
              ? `there is no lesson ${String(id)}`
              : `lesson ${String(id)} is ${current.status}; only a provisional or confirmed lesson can be ${status}`,
          );
          return 1;
        }
        out(`lesson ${String(id)} is ${status}${command === 'confirm' ? ` by ${by}` : ''}`);
        return 0;
      }

      case 'export': {
        const ids = db.query<{ id: number }, []>('SELECT id FROM lessons ORDER BY id').all().map((row) => row.id);
        const records = ids.map((id) => showLesson(knowledge, id)).filter((record): record is LessonRecord => record !== null);
        if (rest.includes('--json')) {
          out(JSON.stringify(records, null, 2));
          return 0;
        }
        for (const record of records) {
          for (const line of render(record)) out(line);
          out('');
        }
        return 0;
      }
    }
  } finally {
    knowledge.close();
  }
}
