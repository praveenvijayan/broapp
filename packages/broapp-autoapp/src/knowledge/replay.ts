/**
 * Replaying a case: the engineer again, with the lesson under test and without it.
 *
 * A provisional lesson claims that knowing it would have avoided a failure.
 * This tests the claim the only way it can be tested: the original request,
 * from the revision the failure was met at, run several times with the lesson
 * and several times without it, every other lesson frozen out, and the build
 * stage that failed — or the acceptance example, by its original hash — as the
 * judge. The engineer never sees the judge's verdict and cannot change the
 * example.
 *
 * What a replay is not: the same model sample, or the same conversation. It is
 * the same machine, the same vendored dependencies, the same instructions this
 * launcher carries now, and a copy of the data. Its result is shown to the
 * person who confirms a lesson; nothing here changes a lesson's status.
 *
 * Every run writes to a knowledge store of its own under
 * `<root>/replay/<episodeId>/`. The launcher's store gains the manifest blob and
 * one `replays` row per run, and nothing else — no serving, case or context
 * from a replay can reach a learning query, because they are in another file.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createAi } from 'broapp/ai/host';
import type { LanguageModel } from 'ai';
import { canonicalJson, publicError } from 'broapp/host';
import type { HostLogger } from 'broapp/host';

import { ENGINEER_INSTRUCTIONS } from '../engineer/instructions.ts';
import { LAUNCHER_MAX_STEPS } from '../launcher/app.ts';
import { snapshotDirectory } from '../launcher/snapshot.ts';
import type { PrepareOptions } from '../launcher/workspace.ts';
import type { AcceptanceExample, Layout } from '../spec/index.ts';

import { createEvidence, exampleHash } from './evidence.ts';
import { identityOf, openRun, prepareRun, providersFor, type ProvidersFor, type TurnOutcome } from './harness.ts';
import { createEventLog } from './log.ts';
import { problemSignature } from './scoring.ts';
import type { Corpus } from './serve.ts';
import { openKnowledge, type Knowledge } from './store.ts';
import { duration, replayTable, type ReplayRow } from './verdict.ts';
import { AUTOAPP_VERSION } from './version.ts';

/** Written before anything runs, stored as a blob, and named on every result row. */
export interface ReplayManifest {
  readonly v: 1;
  readonly episodeId: number;
  readonly appId: string;
  /** A build case is judged by its stage; a check case by its example. */
  readonly kind: 'build' | 'check';
  readonly stage: string;
  readonly signature: string;
  readonly sourceRevBefore: string;
  readonly releaseBefore: string | null;
  /**
   * The data a check case runs on, relative to the launcher root. `case` when
   * the case recorded a snapshot; `live` when none was and this replay took one
   * of the application's data, which is then not the data the failure met.
   */
  readonly dataSnapshot: { readonly path: string; readonly from: 'case' | 'live' } | null;
  readonly packageJsonHash: string | null;
  readonly lockfileHash: string | null;
  readonly requestBlob: string;
  /** The instructions the replay runs with: this launcher's. */
  readonly instructionsBlob: string;
  /** The instructions the case's turn was given, when its context was recorded. */
  readonly caseInstructionsBlob: string | null;
  readonly exampleBlob: string | null;
  readonly exampleHash: string | null;
  readonly model: { readonly provider: string; readonly id: string };
  readonly autoappVersion: string;
  readonly lessonId: number | null;
  readonly runs: number;
  readonly maxSteps: number;
  readonly turnTimeoutMs: number;
}

/** One replayed run. */
export interface ReplayResult {
  readonly arm: 'with' | 'without' | 'regression';
  readonly n: number;
  readonly episodeId: number;
  readonly outcome: 'passed' | 'failed' | 'inconclusive';
  /** Why, in one sentence. */
  readonly detail: string;
  /** Tool calls the turn made. */
  readonly steps: number;
  readonly ms: number;
  readonly tokens: { readonly input: number; readonly output: number };
  /** The engineer called `candidate.build` itself during the turn. */
  readonly buildReached: boolean;
  readonly timedOut: boolean;
}

/** What {@link replay} needs. */
export interface ReplayOptions {
  /** The launcher's own store: where the case is, and where results go. */
  readonly knowledge: Knowledge;
  readonly layout: Layout;
  readonly episodeId: number;
  readonly lessonId: number | null;
  readonly runs?: number;
  /** The configured model. A replay with none cannot start. */
  readonly model: () => Promise<LanguageModel>;
  readonly providers: ProvidersFor;
  readonly logger: HostLogger;
  readonly install?: PrepareOptions['install'];
  /** Where the configured provider's settings live: the launcher's data directory. */
  readonly aiDataDir: string;
  readonly execPath?: string;
  readonly turnTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Each result, as its run finishes. */
  readonly onResult?: (result: ReplayResult) => void;
}

/** Runs per arm, unless asked for another number. */
export const DEFAULT_REPLAY_RUNS = 3;
/** How long one turn may take before the run judges what it left. */
export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
/** Run directories kept per case; the oldest beyond this go on the next replay. */
export const MAX_RUNS_KEPT = 20;

interface CaseRow {
  id: number;
  app_id: string;
  stage: string;
  signature: string;
  problem: string;
  example_hash: string;
  example_blob: string | null;
  request_blob: string;
  context_id: number | null;
  source_rev_before: string;
  release_before: string | null;
  data_snapshot: string | null;
  resolved_at: number | null;
}

/** The case, if it can be replayed; a sentence saying why not, otherwise. */
function replayableCase(knowledge: Knowledge, episodeId: number): CaseRow {
  const row = knowledge.db.query<CaseRow, [number]>('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (row === null) throw publicError.notFound(`There is no case ${String(episodeId)}.`);
  if (row.resolved_at === null) {
    throw publicError.conflict(`Case ${String(episodeId)} is still open; only a resolved case can be replayed.`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(row.source_rev_before)) {
    throw publicError.unavailable(
      `Case ${String(episodeId)} was met in a workspace with no git revision, so there is nothing to check out.`,
    );
  }
  return row;
}

/** The first 32 hex characters of the `sha256` of a file at a revision, or `null` when it is not there. */
function hashAt(sourceDir: string, rev: string, path: string): string | null {
  const shown = Bun.spawnSync({ cmd: ['git', 'show', `${rev}:${path}`], cwd: sourceDir, stdout: 'pipe', stderr: 'ignore' });
  if (shown.exitCode !== 0) return null;
  return new Bun.CryptoHasher('sha256').update(shown.stdout).digest('hex').slice(0, 32);
}

/**
 * The data a check case runs on.
 *
 * Cases do not record a snapshot today, so one is taken of the application's
 * data the first time the case is replayed and kept beside its runs; every run
 * of every later replay starts from the same copy. The manifest says which it is.
 */
function snapshotFor(root: Layout, row: CaseRow): { path: string; from: 'case' | 'live' } {
  if (row.data_snapshot !== null) return { path: row.data_snapshot, from: 'case' };
  const target = join(root.root, 'replay', String(row.id), 'data');
  if (!existsSync(target)) {
    const live = root.app(row.app_id).data;
    if (existsSync(live)) snapshotDirectory(live, target);
    else mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  return { path: relative(root.root, target).split('\\').join('/'), from: 'live' };
}

/** Name everything a replay depends on, before anything runs. */
export async function manifestFor(options: ReplayOptions): Promise<ReplayManifest> {
  const row = replayableCase(options.knowledge, options.episodeId);
  // Asked first: a replay with no model says so before it touches the disk.
  const model = identityOf(await options.model());
  const source = options.layout.app(row.app_id).source;
  const caseInstructions =
    row.context_id === null
      ? null
      : (options.knowledge.db
          .query<{ instructions_blob: string }, [number]>('SELECT instructions_blob FROM contexts WHERE id = ?')
          .get(row.context_id)?.instructions_blob ?? null);
  const kind = row.stage === 'check' ? 'check' : 'build';
  return {
    v: 1,
    episodeId: row.id,
    appId: row.app_id,
    kind,
    stage: row.stage,
    signature: row.signature,
    sourceRevBefore: row.source_rev_before,
    releaseBefore: row.release_before,
    dataSnapshot: kind === 'check' ? snapshotFor(options.layout, row) : null,
    packageJsonHash: hashAt(source, row.source_rev_before, 'package.json'),
    lockfileHash: hashAt(source, row.source_rev_before, 'bun.lock') ?? hashAt(source, row.source_rev_before, 'bun.lockb'),
    requestBlob: row.request_blob,
    instructionsBlob: options.knowledge.putBlob(ENGINEER_INSTRUCTIONS),
    caseInstructionsBlob: caseInstructions,
    exampleBlob: row.example_blob,
    exampleHash: row.example_hash === '' ? null : row.example_hash,
    model,
    autoappVersion: AUTOAPP_VERSION,
    lessonId: options.lessonId,
    runs: Math.max(1, Math.floor(options.runs ?? DEFAULT_REPLAY_RUNS)),
    maxSteps: LAUNCHER_MAX_STEPS,
    turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  };
}

interface LessonRow {
  id: number;
  version: number;
  status: string;
  review: string | null;
  origin: string;
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

/**
 * Copy lessons into another store, under the same ids.
 *
 * The same id, so a result row, a serving and a person all mean the same
 * lesson by the same number. Without the case and the lesson they supersede,
 * which are rows of the other store: a copy that pointed at them would point
 * at whatever had that id here. `where` is SQL written in this package, never
 * text from outside it.
 */
export function copyLessons(from: Knowledge, to: Knowledge, where: string): number {
  const rows = from.db.query<LessonRow, []>(`SELECT * FROM lessons WHERE ${where} ORDER BY id`).all();
  to.db.transaction(() => {
    for (const row of rows) {
      to.db
        .query<
          null,
          [number, number, string, string | null, string, string | null, string, string, string, string, string, string, string, number, number, string | null, number | null]
        >(
          `INSERT OR REPLACE INTO lessons
             (id, version, status, review, origin, episode_id, supersedes, diagnosis, scope, applies, summary, detail,
              trigger, instructions_hash, autoapp_version, created_at, updated_at, reviewed_by, reviewed_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.version,
          row.status,
          row.review,
          row.origin,
          row.diagnosis,
          row.scope,
          row.applies,
          row.summary,
          row.detail,
          row.trigger,
          row.instructions_hash,
          row.autoapp_version,
          row.created_at,
          row.updated_at,
          row.reviewed_by,
          row.reviewed_at,
        );
      to.db.query<null, [number]>('DELETE FROM lessons_fts WHERE rowid = ?').run(row.id);
      to.db
        .query<null, [number, string, string]>('INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)')
        .run(row.id, row.summary, row.trigger);
    }
  })();
  return rows.length;
}

/** Every run directory under a case's replay directory, oldest first. */
function runDirectories(base: string): string[] {
  const out: { path: string; at: number }[] = [];
  for (const arm of ['with', 'without', 'regression']) {
    const armDir = join(base, arm);
    if (!existsSync(armDir)) continue;
    for (const name of readdirSync(armDir)) {
      if (!/^\d+$/.test(name)) continue;
      const path = join(armDir, name);
      out.push({ path, at: statSync(path).mtimeMs });
    }
  }
  return out.sort((a, b) => a.at - b.at).map((entry) => entry.path);
}

/** Remove the oldest runs beyond the cap. Nothing else is removed: a person may want to look. */
function capRuns(base: string): void {
  const all = runDirectories(base);
  for (const path of all.slice(0, Math.max(0, all.length - MAX_RUNS_KEPT))) rmSync(path, { recursive: true, force: true });
}

/** The next free run number in an arm's directory. */
function nextIndex(armDir: string): number {
  if (!existsSync(armDir)) return 1;
  return readdirSync(armDir).reduce((top, name) => (/^\d+$/.test(name) ? Math.max(top, Number(name)) : top), 0) + 1;
}

/** The case's example, parsed from its blob, if its hash is still the one the case recorded. */
function originalExample(knowledge: Knowledge, manifest: ReplayManifest): AcceptanceExample | null {
  if (manifest.exampleBlob === null || manifest.exampleHash === null) return null;
  const text = knowledge.getBlob(manifest.exampleBlob);
  if (text === null) return null;
  try {
    const example = JSON.parse(text) as AcceptanceExample;
    return exampleHash(example) === manifest.exampleHash ? example : null;
  } catch {
    return null;
  }
}

/** Store one result in the launcher's own store. */
function record(knowledge: Knowledge, result: ReplayResult, lessonId: number | null, manifestBlob: string): void {
  knowledge.db
    .query<null, [number, number | null, string, number, string, number, number, number, number, number, string, number]>(
      `INSERT INTO replays
         (episode_id, lesson_id, arm, n, outcome, steps, ms, input_tokens, output_tokens, build_reached, manifest_blob, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      result.episodeId,
      lessonId,
      result.arm,
      result.n,
      result.outcome,
      result.steps,
      result.ms,
      result.tokens.input,
      result.tokens.output,
      result.buildReached ? 1 : 0,
      manifestBlob,
      Date.now(),
    );
}

/** What one run needs beyond the options. */
interface RunInput {
  readonly options: Omit<ReplayOptions, 'episodeId' | 'lessonId' | 'runs'>;
  readonly manifest: ReplayManifest;
  readonly example: AcceptanceExample | null;
  readonly store: Knowledge;
  readonly arm: ReplayResult['arm'];
  readonly n: number;
  readonly corpus: Corpus;
}

/** One run: a fresh checkout, one turn, and the judge. */
async function runOnce(input: RunInput): Promise<ReplayResult> {
  const { options, manifest, arm, n } = input;
  const base = join(options.layout.root, 'replay', String(manifest.episodeId));
  const armDir = join(base, arm);
  mkdirSync(armDir, { recursive: true, mode: 0o700 });
  const index = nextIndex(armDir);
  const empty = { steps: 0, ms: 0, tokens: { input: 0, output: 0 }, buildReached: false, timedOut: false };
  const inconclusive = (detail: string): ReplayResult => ({ arm, n, episodeId: manifest.episodeId, outcome: 'inconclusive', detail, ...empty });

  const live = options.layout.app(manifest.appId);
  let runLayout: Layout;
  try {
    runLayout = prepareRun(join(armDir, String(index)), manifest.appId, {
      sourceDir: live.source,
      rev: manifest.sourceRevBefore,
      release: manifest.releaseBefore === null ? null : { dir: live.release(manifest.releaseBefore), id: manifest.releaseBefore },
      grants: live.grants,
      data: manifest.dataSnapshot === null ? null : join(options.layout.root, manifest.dataSnapshot.path),
    });
  } catch (cause) {
    return inconclusive(`the run could not be prepared: ${String(cause instanceof Error ? cause.message : cause)}`);
  }

  const log = createEventLog(input.store, { source: 'replay', tee: options.logger });
  const handle = openRun({
    layout: runLayout,
    appId: manifest.appId,
    knowledge: { store: input.store, log, evidence: createEvidence(input.store, log) },
    serving: { corpus: input.corpus, seed: false },
    providers: providersFor(options.providers, { label: arm, appId: manifest.appId, n }),
    aiDataDir: options.aiDataDir,
    logger: options.logger,
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    ...(options.install === undefined ? {} : { install: options.install }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  try {
    const request = options.knowledge.getBlob(manifest.requestBlob);
    const runId = `replay-${String(manifest.episodeId)}-${arm}-${String(index)}`;
    const turn = await handle.turn(runId, request ?? '(the request was not recorded)', manifest.turnTimeoutMs);
    const measured = {
      steps: turn.calls.length,
      ms: turn.ms,
      tokens: turn.tokens,
      buildReached: turn.calls.some((call) => call.tool === 'candidate.build'),
      timedOut: turn.timedOut,
    };
    const judged = await judge(handle, manifest, input.example, turn);
    return { arm, n, episodeId: manifest.episodeId, ...judged, ...measured };
  } catch (cause) {
    return inconclusive(`the run did not finish: ${String(cause instanceof Error ? cause.message : cause)}`);
  } finally {
    await handle.close();
  }
}

/**
 * The judge: the failing stage, or the example by its original content.
 *
 * Activation is never part of it. A turn that failed on its provider says
 * nothing about the lesson and is inconclusive; one that ran out of time is
 * judged by what it left, which is what the person would have been handed.
 */
async function judge(
  handle: ReturnType<typeof openRun>,
  manifest: ReplayManifest,
  example: AcceptanceExample | null,
  turn: TurnOutcome,
): Promise<{ outcome: ReplayResult['outcome']; detail: string }> {
  if (turn.status === 'failed' && !turn.timedOut) {
    return { outcome: 'inconclusive', detail: `the turn failed: ${turn.error ?? 'the provider returned an error'}` };
  }
  let built;
  try {
    built = await handle.build();
  } catch (cause) {
    return { outcome: 'inconclusive', detail: `the build did not run: ${String(cause instanceof Error ? cause.message : cause)}` };
  }
  if (manifest.kind === 'build') {
    if (!built.stagesRun.includes(manifest.stage as (typeof built.stagesRun)[number])) {
      return { outcome: 'failed', detail: `the build stopped before the ${manifest.stage} stage` };
    }
    const recurs =
      !built.ok && built.problems.some((problem) => problemSignature(problem.stage, problem.message) === manifest.signature);
    if (recurs) return { outcome: 'failed', detail: 'the same failure is still there' };
    return {
      outcome: 'passed',
      detail: built.ok ? 'the build passed' : `the ${manifest.stage} failure is gone; the build fails elsewhere`,
    };
  }
  if (example === null) {
    return { outcome: 'inconclusive', detail: 'the example is no longer the one the case recorded' };
  }
  if (!built.ok) return { outcome: 'failed', detail: 'the replayed candidate does not build' };
  const checked = await handle.check(built.releaseId, [example]);
  if (checked.childDied) return { outcome: 'inconclusive', detail: 'the preview child died' };
  const result = checked.results[0];
  return result?.passed === true
    ? { outcome: 'passed', detail: 'the example passed' }
    : { outcome: 'failed', detail: result?.detail ?? 'the example failed' };
}

/** Replay a case: the two arms, `runs` each, interleaved so drift in the model touches both. */
export async function replay(
  options: ReplayOptions,
): Promise<{ manifest: ReplayManifest; results: readonly ReplayResult[] }> {
  const manifest = await manifestFor(options);
  const manifestBlob = options.knowledge.putBlob(canonicalJson(manifest));
  const base = join(options.layout.root, 'replay', String(manifest.episodeId));
  mkdirSync(base, { recursive: true, mode: 0o700 });
  capRuns(base);
  const example = manifest.kind === 'check' ? originalExample(options.knowledge, manifest) : null;

  const store = openKnowledge(base);
  const results: ReplayResult[] = [];
  try {
    if (manifest.lessonId !== null) copyLessons(options.knowledge, store, `id = ${String(Math.floor(manifest.lessonId))}`);
    const arms: readonly ('with' | 'without')[] = manifest.lessonId === null ? ['without'] : ['with', 'without'];
    for (let n = 1; n <= manifest.runs; n += 1) {
      for (const arm of arms) {
        const result = await runOnce({
          options,
          manifest,
          example,
          store,
          arm,
          n,
          // Curated facts are frozen out of both arms, so the advice under test
          // cannot arrive as a hint from somewhere else.
          corpus: arm === 'with' && manifest.lessonId !== null ? { pinned: [manifest.lessonId], match: 'none' } : { match: 'none' },
        });
        record(options.knowledge, result, manifest.lessonId, manifestBlob);
        results.push(result);
        options.onResult?.(result);
      }
    }
  } finally {
    store.close();
  }
  return { manifest, results };
}

/**
 * The regression set: every resolved case of the application whose lesson is
 * confirmed, replayed once with the new lesson and the confirmed corpus.
 *
 * A failure is printed; it does not block anything.
 */
export async function regression(
  options: Omit<ReplayOptions, 'episodeId' | 'runs' | 'lessonId'> & { readonly lessonId: number },
): Promise<readonly ReplayResult[]> {
  const { db } = options.knowledge;
  const lesson = db
    .query<{ episode_id: number | null }, [number]>('SELECT episode_id FROM lessons WHERE id = ?')
    .get(options.lessonId);
  if (lesson === null || lesson.episode_id === null) return [];
  const appId = db.query<{ app_id: string }, [number]>('SELECT app_id FROM episodes WHERE id = ?').get(lesson.episode_id)?.app_id;
  if (appId === undefined) return [];
  const cases = db
    .query<{ id: number }, [string, number]>(
      `SELECT e.id FROM episodes e JOIN lessons l ON l.episode_id = e.id
        WHERE l.status = 'confirmed' AND e.app_id = ? AND e.resolved_at IS NOT NULL AND e.id <> ?
        ORDER BY e.id`,
    )
    .all(appId, lesson.episode_id)
    .map((row) => row.id);

  const results: ReplayResult[] = [];
  for (const episodeId of cases) {
    let manifest: ReplayManifest;
    try {
      manifest = await manifestFor({ ...options, episodeId, runs: 1 });
    } catch (cause) {
      options.logger.warn(`[autoapp] case ${String(episodeId)} cannot be replayed: ${String(cause instanceof Error ? cause.message : cause)}`);
      continue;
    }
    const manifestBlob = options.knowledge.putBlob(canonicalJson(manifest));
    const base = join(options.layout.root, 'replay', String(episodeId));
    mkdirSync(base, { recursive: true, mode: 0o700 });
    capRuns(base);
    const store = openKnowledge(base);
    try {
      copyLessons(options.knowledge, store, `status = 'confirmed' OR id = ${String(Math.floor(options.lessonId))}`);
      const result = await runOnce({
        options,
        manifest,
        example: manifest.kind === 'check' ? originalExample(options.knowledge, manifest) : null,
        store,
        arm: 'regression',
        n: 1,
        corpus: { pinned: [options.lessonId], match: 'confirmed' },
      });
      record(options.knowledge, result, options.lessonId, manifestBlob);
      results.push(result);
      options.onResult?.(result);
    } finally {
      store.close();
    }
  }
  return results;
}

/** A result as the table wants it. */
export function rowOf(result: ReplayResult): ReplayRow {
  return {
    arm: result.arm,
    n: result.n,
    episodeId: result.episodeId,
    outcome: result.outcome,
    steps: result.steps,
    ms: result.ms,
    inputTokens: result.tokens.input,
    outputTokens: result.tokens.output,
    buildReached: result.buildReached,
  };
}

/** What `knowledge replay` needs from the launcher it runs in. */
export interface ReplayCommandOptions {
  readonly root: Layout;
  /** Everything after `knowledge replay`. */
  readonly argv: readonly string[];
  readonly providers: ProvidersFor;
  readonly aiDataDir: string;
  readonly execPath?: string;
  readonly install?: PrepareOptions['install'];
  readonly fetch?: typeof fetch;
  readonly turnTimeoutMs?: number;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/** The value after a flag. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

/** `knowledge replay <episodeId> [--with <lessonId>] [--runs n]`. Returns the exit code. */
export async function runReplayCommand(options: ReplayCommandOptions): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const flagged = new Set([flag(options.argv, '--with'), flag(options.argv, '--runs')]);
  const episode = options.argv.find((argument) => !argument.startsWith('-') && !flagged.has(argument));
  const withArgument = flag(options.argv, '--with');
  const runsArgument = flag(options.argv, '--runs');
  if (
    episode === undefined ||
    !/^\d+$/.test(episode) ||
    (withArgument !== undefined && !/^\d+$/.test(withArgument)) ||
    (runsArgument !== undefined && !/^[1-9]\d*$/.test(runsArgument))
  ) {
    err('usage: broapp-autoapp knowledge replay <caseId> [--with <lessonId>] [--runs n]');
    return 1;
  }
  const episodeId = Number(episode);

  const knowledge = openKnowledge(join(options.root.root, 'launcher'));
  // Warnings from the runs' children would drown the lines a person is reading.
  const logger: HostLogger = { warn: () => undefined, error: (line) => err(line) };
  try {
    const lessonId =
      withArgument !== undefined
        ? Number(withArgument)
        : (knowledge.db
            .query<{ id: number }, [number]>(
              "SELECT id FROM lessons WHERE episode_id = ? AND status IN ('provisional', 'confirmed') ORDER BY id DESC LIMIT 1",
            )
            .get(episodeId)?.id ?? null);
    const ai = createAi({
      dataDir: options.aiDataDir,
      providers: providersFor(options.providers, { label: 'manifest', appId: 'launcher', n: 0 }),
      app: { name: 'Autoapp', purpose: 'Replaying a case.' },
      logger,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const replayOptions: ReplayOptions = {
      knowledge,
      layout: options.root,
      episodeId,
      lessonId,
      ...(runsArgument === undefined ? {} : { runs: Number(runsArgument) }),
      model: () => ai.model(),
      providers: options.providers,
      logger,
      aiDataDir: options.aiDataDir,
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
      ...(options.install === undefined ? {} : { install: options.install }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      onResult: (result) =>
        out(
          `${result.arm} ${String(result.n)}: ${result.outcome} — ${result.detail} (${String(result.steps)} calls, ${duration(result.ms)}${result.timedOut ? ', timed out' : ''})`,
        ),
    };

    let manifest: ReplayManifest;
    try {
      manifest = await manifestFor(replayOptions);
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      if (/not set up|configured|provider/i.test(message)) {
        err(`no model is configured: ${message}`);
        return 2;
      }
      err(message);
      return 1;
    }
    const problem = knowledge.db.query<{ problem: string }, [number]>('SELECT problem FROM episodes WHERE id = ?').get(episodeId)?.problem ?? '';
    out(`case ${String(manifest.episodeId)} in ${manifest.appId}, ${manifest.stage}: ${problem.length > 120 ? `${problem.slice(0, 119)}…` : problem}`);
    out(
      `from ${manifest.sourceRevBefore.slice(0, 12)}${manifest.releaseBefore === null ? '' : ` (release ${manifest.releaseBefore.slice(0, 8)})`}, ${manifest.model.provider}/${manifest.model.id}, ${String(manifest.runs)} run(s) per arm, ${String(manifest.maxSteps)} steps, ${duration(manifest.turnTimeoutMs)} a turn`,
    );
    out(manifest.lessonId === null ? 'no lesson: only the without arm runs' : `lesson ${String(manifest.lessonId)} under test; every other lesson frozen out`);
    if (manifest.dataSnapshot?.from === 'live') out('the case recorded no data; a copy of the application’s data now stands in for it');

    const { results } = await replay(replayOptions);
    out('');
    for (const line of replayTable(results.map(rowOf))) out(line);
    if (manifest.lessonId !== null) {
      const regressions = await regression({ ...replayOptions, lessonId: manifest.lessonId, onResult: () => undefined });
      out(regressions.length === 0 ? 'regression: no other confirmed case of this application' : 'regression:');
      for (const result of regressions) out(`  case ${String(result.episodeId)}: ${result.outcome} — ${result.detail}`);
    }
    return 0;
  } catch (cause) {
    err(String(cause instanceof Error ? cause.message : cause));
    return 1;
  } finally {
    knowledge.close();
  }
}
