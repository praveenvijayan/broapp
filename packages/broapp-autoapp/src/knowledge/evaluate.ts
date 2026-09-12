/**
 * The evaluation: did the knowledge path move the measured blocker?
 *
 * Three tasks, four conditions, `n` runs each, on the configured model, every
 * run in a fresh checkout with a knowledge store of its own. Verified
 * completion is the task's acceptance example passing on a preview of what the
 * turn left: the example is added to the workspace before any run, by hash,
 * and judged from the copy held here, so no run can change what it is judged by.
 *
 * The conditions are the launcher at four points of its history: `baseline` is
 * before 12b (no documents, no hints), `orientation` the digest alone,
 * `orientation+facts` 12b as shipped (digest, evidence, curated facts), and
 * `learned` that plus every provisional and confirmed distilled lesson from the
 * launcher's own store.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAi } from 'broapp/ai/host';
import type { LanguageModel } from 'ai';
import type { HostLogger } from 'broapp/host';

import { LAUNCHER_MAX_STEPS } from '../launcher/app.ts';
import { createApplication } from '../launcher/create.ts';
import type { Templates } from '../launcher/starter.ts';
import { adopt, prepareWorkspace, type PrepareOptions } from '../launcher/workspace.ts';
import { layout as layoutOf, readCurrent, readRelease, type AcceptanceExample, type Layout } from '../spec/index.ts';

import { createEvidence, exampleHash } from './evidence.ts';
import { git, identityOf, openRun, prepareRun, providersFor, type ProvidersFor, type ToolCall } from './harness.ts';
import { createEventLog } from './log.ts';
import { copyLessons, DEFAULT_TURN_TIMEOUT_MS } from './replay.ts';
import { problemSignature, unrelatedHintCredit } from './scoring.ts';
import type { CreateServeInput } from './serve.ts';
import { openKnowledge, type Knowledge } from './store.ts';
import { duration } from './verdict.ts';

/** The four conditions, in the order the table lists them. */
export const CONDITIONS = ['baseline', 'orientation', 'orientation+facts', 'learned'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** One task: a starting workspace, a request, and the example that decides it. */
export interface EvaluationTask {
  readonly id: string;
  readonly base: 'notes' | 'starter';
  readonly appId: string;
  readonly request: string;
  readonly example: AcceptanceExample;
}

/**
 * The three tasks.
 *
 * Each example states the interface the request implies — a route and an input
 * a person would reasonably expect — and says both what must be there and what
 * must not, so a route that returns nothing cannot pass. Rows carry ids and
 * timestamps no example can know, so what must be there is a `match`. The
 * engineer can read the example in `autoapp.json`, as it can read any there.
 *
 * Two things an example cannot say today, and these do not: that a change
 * survives the application restarting (a check runs against one child), and
 * that the interface shows it (a step calls a route, not a button). The saved
 * workflow in the first request is not checked either; it lives in the run
 * store, not in the workspace.
 */
export const EVALUATION_TASKS: readonly EvaluationTask[] = [
  {
    id: 'notes-archive',
    base: 'notes',
    appId: 'notes',
    // The 07/08c request, verbatim.
    request:
      'Add tags to notes and an Archive action. Archived notes disappear from the main list. Then let me save a repeatable workflow for archiving selected notes.',
    example: {
      id: 'eval-archive-keeps-others',
      title: 'An archived note leaves the main list, and the others stay',
      steps: [
        { route: 'notes.create', input: { title: 'Keep me', body: '' } },
        { route: 'notes.create', input: { title: 'Archive me', body: '' } },
        { route: 'notes.archive', input: { id: 2 } },
        { route: 'notes.list', input: {}, match: { notes: [{ title: 'Keep me' }] } },
      ],
    },
  },
  {
    id: 'starter-done-filter',
    base: 'starter',
    appId: 'items',
    request: 'add a `done` filter to the items table',
    example: {
      id: 'eval-done-filter',
      title: 'Filtering by done gives the done items, and the open ones the other way',
      steps: [
        { route: 'items.add', input: { label: 'Open' } },
        { route: 'items.add', input: { label: 'Finished' } },
        { route: 'items.update', input: { id: 2, done: true } },
        { route: 'items.list', input: { done: true }, match: { items: [{ label: 'Finished', done: true }] } },
        { route: 'items.list', input: { done: false }, match: { items: [{ label: 'Open', done: false }] } },
      ],
    },
  },
  {
    id: 'notes-tags',
    base: 'notes',
    appId: 'notes',
    request: 'add tags to notes and a filter by tag',
    example: {
      id: 'eval-tag-filter',
      title: 'Filtering by a tag finds the tagged note and nothing else',
      steps: [
        { route: 'notes.create', input: { title: 'Untagged', body: '' } },
        { route: 'notes.create', input: { title: 'Work note', body: '', tags: ['work'] } },
        { route: 'notes.list', input: { tag: 'work' }, match: { notes: [{ title: 'Work note' }] } },
        { route: 'notes.list', input: { tag: 'home' }, expect: { notes: [] } },
      ],
    },
  },
];

/** One line of the table. */
export interface EvaluationRow {
  readonly condition: Condition;
  readonly task: string;
  readonly runs: number;
  /** Runs whose workspace, built and previewed by the evaluation afterwards, passed the task's example. */
  readonly workingCode: number;
  /** Runs where the engineer itself checked the release it last built, with the task's example intact, and every example passed. */
  readonly workflowCompleted: number;
  /** Mean over the runs that edited; how many did. */
  readonly callsToFirstEdit: { readonly mean: number | null; readonly of: number };
  readonly callsToFirstBuild: { readonly mean: number | null; readonly of: number };
  readonly reachedBuild: number;
  /** Builds the engineer ran that failed: its repair attempts. */
  readonly failedBuilds: number;
  /** The turn's time less its tools' time. */
  readonly meanModelMs: number;
  readonly meanToolMs: number;
  readonly approvals: number;
  readonly meanTokens: number;
  /** Failure signatures that had already appeared in an earlier run of the same condition and task. */
  readonly recurringSignatures: number;
  /** Files an included document named that the run then read or edited. */
  readonly includedUsed: number;
  readonly includedIgnored: number;
  /** Files the run read that no included document named. */
  readonly readsNotOffered: number;
  /** Hint servings credited `resolved` whose lesson's stage or routes did not match the failure. */
  readonly unrelatedCredit: number;
  readonly timedOut: number;
}

/** What {@link evaluate} needs. */
export interface EvaluateOptions {
  readonly layout: Layout;
  /** The launcher's own store: where the `learned` condition's lessons come from. Read only. */
  readonly knowledge: Knowledge;
  readonly runs?: number;
  readonly model: () => Promise<LanguageModel>;
  readonly providers: ProvidersFor;
  readonly aiDataDir: string;
  readonly execPath?: string;
  readonly logger: HostLogger;
  /** Defaults to installing nothing: a task's workspace resolves what it sits among. */
  readonly install?: PrepareOptions['install'];
  /** `examples/notes`. */
  readonly notesDir: string;
  readonly templates: Templates;
  readonly versions: { readonly broapp: string; readonly autoapp: string };
  readonly turnTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** One line per run, as it finishes. */
  readonly onRun?: (line: string) => void;
}

/** What each condition serves. */
function servingFor(condition: Condition): 'off' | Pick<CreateServeInput, 'corpus' | 'documents' | 'seed'> {
  switch (condition) {
    case 'baseline':
      return 'off';
    case 'orientation':
      return { documents: { digest: true, evidence: false }, corpus: { match: 'none' }, seed: false };
    case 'orientation+facts':
      return { corpus: { match: 'curated' } };
    case 'learned':
      return { corpus: { match: 'all' } };
  }
}

const noInstall: NonNullable<PrepareOptions['install']> = () =>
  Promise.resolve({ ok: true, detail: 'the evaluation installs nothing' });

/** A task's starting point, prepared once and cloned by every run. */
interface Start {
  readonly layout: Layout;
  readonly rev: string;
  readonly releaseId: string;
}

/**
 * Prepare a task's workspace: import Notes or create the starter, build, make
 * it current, then add the example and commit.
 *
 * The example goes in after the first build, so the release is the application
 * as it was before the request — an example naming a route that does not exist
 * yet would not pass the build — and in a commit, so every run starts from it.
 */
async function prepareTask(directory: string, task: EvaluationTask, options: EvaluateOptions): Promise<Start> {
  const taskLayout = layoutOf(directory);
  const app = taskLayout.app(task.appId);
  const install = options.install ?? noInstall;
  if (task.base === 'notes') {
    mkdirSync(app.dir, { recursive: true, mode: 0o700 });
    cpSync(options.notesDir, app.source, {
      recursive: true,
      filter: (from) => !/(^|[\\/])(node_modules|dist|release|\.git)([\\/]|$)/.test(from),
    });
    // Notes' own dependencies, linked rather than copied or installed: its
    // host reaches provider packages that only its own `node_modules` holds.
    const modules = join(options.notesDir, 'node_modules');
    if (existsSync(modules)) symlinkSync(modules, join(app.source, 'node_modules'), 'junction');
    const prepared = await prepareWorkspace({ layout: taskLayout, appId: task.appId, install, logger: options.logger });
    if (!prepared.ok) {
      throw new Error(`${task.id}: Notes did not build: ${prepared.problems.map((problem) => problem.message).join('; ')}`);
    }
    adopt(taskLayout, task.appId, prepared.releaseId, prepared.spec.manifest.capabilities);
    if (existsSync(join(app.source, '.git', 'info'))) {
      appendFileSync(join(app.source, '.git', 'info', 'exclude'), '\nnode_modules\n');
    }
  } else {
    const created = await createApplication({
      layout: taskLayout,
      templates: options.templates,
      versions: options.versions,
      appId: task.appId,
      name: 'Items',
      install,
      logger: options.logger,
    });
    if (!created.ok) {
      throw new Error(`${task.id}: the starter did not build: ${created.problems.map((problem) => problem.message).join('; ')}`);
    }
  }
  const manifestPath = join(app.source, 'autoapp.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { acceptance?: unknown[] };
  manifest.acceptance = [...(manifest.acceptance ?? []), task.example];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(app.source, ['add', '-A']);
  git(app.source, ['commit', '--quiet', '--no-gpg-sign', '-m', `The evaluation task ${task.id}`]);
  const releaseId = readCurrent(taskLayout, task.appId);
  if (releaseId === null) throw new Error(`${task.id}: nothing is current`);
  return { layout: taskLayout, rev: git(app.source, ['rev-parse', 'HEAD']), releaseId };
}

/** Workspace paths a document names. */
const PATH = /\b(?:src\/[A-Za-z0-9_./-]+\.[A-Za-z]+|autoapp\.json|package\.json)\b/g;

/** One run's numbers. */
interface RunMeasure {
  workingCode: boolean;
  workflowCompleted: boolean;
  firstEdit: number | null;
  firstBuild: number | null;
  reachedBuild: boolean;
  failedBuilds: number;
  ms: number;
  toolMs: number;
  approvals: number;
  tokens: number;
  signatures: Set<string>;
  used: number;
  ignored: number;
  notOffered: number;
  unrelated: number;
  timedOut: boolean;
}

/** The 1-based position of the first call to one of these tools, or `null`. */
function firstWhere(calls: readonly ToolCall[], where: (call: ToolCall) => boolean): number | null {
  const at = calls.findIndex(where);
  return at < 0 ? null : at + 1;
}

/**
 * A build a call performed, from `candidate.build` or from a `candidate.cycle`
 * that got as far as building.
 *
 * Since 12c the instructions route every change through the cycle, and an
 * evaluation that only saw `candidate.build` reported no builds at all for
 * runs that had built and checked — the clean run after 0.4.2 read `–` in
 * five columns. Every column that is about a build or an edit goes through
 * these three functions, so a new tool that builds has one place to be added.
 */
export function buildOf(
  call: ToolCall,
): { ok: true; releaseId: string } | { ok: false; problems: readonly { stage?: unknown; message?: unknown }[] } | null {
  const output = call.output as Record<string, unknown> | undefined;
  if (output === undefined) return null;
  const candidate = call.tool === 'candidate.build' ? output : call.tool === 'candidate.cycle' ? output['build'] : undefined;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const build = candidate as { ok?: unknown; releaseId?: unknown; problems?: unknown; declined?: unknown };
  if (build.declined === true) return null;
  if (build.ok === true && typeof build.releaseId === 'string') return { ok: true, releaseId: build.releaseId };
  if (build.ok === false) return { ok: false, problems: Array.isArray(build.problems) ? (build.problems as { stage?: unknown; message?: unknown }[]) : [] };
  return null;
}

/** Whether a call applied an edit: `source.edit`, `source.change`, or a cycle with hunks or files. */
export function editedBy(call: ToolCall): boolean {
  if (call.tool === 'source.edit' || call.tool === 'source.change') return true;
  if (call.tool !== 'candidate.cycle') return false;
  const input = call.input as { hunks?: unknown; create?: unknown } | undefined;
  return (Array.isArray(input?.hunks) && input.hunks.length > 0) || (Array.isArray(input?.create) && input.create.length > 0);
}

/**
 * A check a call ran on a release: `candidate.check`, with every result, or a
 * cycle that reached its check, which reports only counts and the failures.
 */
export function checkOf(
  call: ToolCall,
): { releaseId: string; allPassed: boolean; ids: readonly string[] | null } | null {
  if (call.tool === 'candidate.check') {
    const releaseId = (call.input as { releaseId?: unknown } | undefined)?.releaseId;
    const results = (call.output as { results?: unknown } | undefined)?.results;
    if (typeof releaseId !== 'string' || !Array.isArray(results)) return null;
    const rows = results as { id?: unknown; passed?: unknown }[];
    return {
      releaseId,
      allPassed: rows.length > 0 && rows.every((row) => row.passed === true),
      ids: rows.map((row) => (typeof row.id === 'string' ? row.id : '')),
    };
  }
  if (call.tool === 'candidate.cycle') {
    const built = buildOf(call);
    const check = (call.output as { check?: unknown } | undefined)?.check as { of?: unknown; failed?: unknown } | undefined;
    if (built === null || !built.ok || check === undefined) return null;
    const of = typeof check.of === 'number' ? check.of : 0;
    const failed = Array.isArray(check.failed) ? check.failed.length : 0;
    // The cycle names only the failures; a clean check of every example is
    // `of > 0` and nothing failed, and which examples ran is the release's list.
    return { releaseId: built.releaseId, allPassed: of > 0 && failed === 0, ids: null };
  }
  return null;
}

/** Paths a call read or edited. */
function pathsOf(call: ToolCall): { read: string[]; edited: string[] } {
  const input = (call.input ?? {}) as { path?: unknown; hunks?: unknown; changes?: unknown; create?: unknown };
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => (entry as { path?: unknown }).path)
          .filter((path): path is string => typeof path === 'string')
      : [];
  const normal = (path: string): string => path.split('\\').join('/');
  if (call.tool === 'source.read' && typeof input.path === 'string') return { read: [normal(input.path)], edited: [] };
  if (call.tool === 'source.edit') return { read: [], edited: list(input.hunks).map(normal) };
  if (call.tool === 'source.change') return { read: [], edited: list(input.changes).map(normal) };
  if (call.tool === 'candidate.cycle') return { read: [], edited: [...list(input.hunks), ...list(input.create)].map(normal) };
  return { read: [], edited: [] };
}

/** How many of a turn's builds failed. */
function failedBuildsOf(calls: readonly ToolCall[]): number {
  return calls.filter((call) => buildOf(call)?.ok === false).length;
}

/**
 * Whether the engineer itself reached a verified preview: after its last
 * passing build, it checked that release; the release still carries the task's
 * example unchanged, by hash; and every example passed, that one included.
 *
 * Separate from the evaluation's own build and check, which says whether the
 * code works whoever verified it. This says whether the engineer got there.
 */
function workflowCompletedBy(calls: readonly ToolCall[], runLayout: Layout, appId: string, task: EvaluationTask): boolean {
  let releaseId: string | null = null;
  let builtAt = -1;
  for (const [index, call] of calls.entries()) {
    const built = buildOf(call);
    if (built !== null && built.ok) {
      releaseId = built.releaseId;
      builtAt = index;
    }
  }
  if (releaseId === null) return false;
  let exampleId: string | null = null;
  try {
    const wanted = exampleHash(task.example);
    exampleId = readRelease(runLayout, appId, releaseId).acceptance.find((example) => exampleHash(example) === wanted)?.id ?? null;
  } catch {
    return false;
  }
  if (exampleId === null) return false;
  // The cycle that built may be the call that checked, so it is included.
  return calls.slice(builtAt).some((call) => {
    const check = checkOf(call);
    if (check === null || check.releaseId !== releaseId || !check.allPassed) return false;
    // A cycle reports no ids; the release carries the example (checked above),
    // and the cycle ran every example the release has.
    return check.ids === null || check.ids.includes(exampleId);
  });
}

/** Failure signatures from the builds a turn ran. */
function buildSignatures(calls: readonly ToolCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const built = buildOf(call);
    if (built === null || built.ok) continue;
    for (const problem of built.problems) {
      if (typeof problem.stage === 'string' && typeof problem.message === 'string') {
        out.push(problemSignature(problem.stage, problem.message));
      }
    }
  }
  return out;
}

/** The workspace files the run's delivered documents named. */
function offeredFiles(store: Knowledge, runId: string): Set<string> {
  const row = store.db.query<{ included: string }, [string]>('SELECT included FROM contexts WHERE run_id = ?').get(runId);
  const files = new Set<string>();
  if (row === null) return files;
  for (const entry of JSON.parse(row.included) as { blob?: string }[]) {
    const content = entry.blob === undefined ? null : store.getBlob(entry.blob);
    for (const match of content?.matchAll(PATH) ?? []) files.add(match[0]);
  }
  return files;
}

/** A condition's name as it can appear in a run id. */
function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Run the evaluation. */
export async function evaluate(
  options: EvaluateOptions,
): Promise<{ readonly model: { provider: string; id: string }; readonly rows: readonly EvaluationRow[]; readonly markdown: string }> {
  const model = identityOf(await options.model());
  const runs = Math.max(1, Math.floor(options.runs ?? 1));
  const timeout = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(options.layout.root, 'evaluate', stamp);

  const starts = new Map<string, Start>();
  for (const task of EVALUATION_TASKS) starts.set(task.id, await prepareTask(join(base, 'base', task.id), task, options));

  const measured = new Map<string, RunMeasure[]>();
  const key = (condition: Condition, task: string): string => `${condition}\n${task}`;

  // Run by run, task by task, condition by condition: whatever drifts in the
  // model over hours touches every condition alike.
  for (let n = 1; n <= runs; n += 1) {
    for (const task of EVALUATION_TASKS) {
      const start = starts.get(task.id);
      if (start === undefined) continue;
      for (const condition of CONDITIONS) {
        const runDir = join(base, condition, task.id, String(n));
        const live = start.layout.app(task.appId);
        const runLayout = prepareRun(runDir, task.appId, {
          sourceDir: live.source,
          rev: start.rev,
          release: { dir: live.release(start.releaseId), id: start.releaseId },
          grants: live.grants,
          data: null,
        });
        const store = openKnowledge(runDir);
        if (condition === 'learned') {
          copyLessons(
            options.knowledge,
            store,
            "origin = 'distilled' AND status IN ('provisional', 'confirmed') AND (diagnosis IS NULL OR diagnosis <> 'method_unclear')",
          );
        }
        const log = createEventLog(store, { source: 'evaluate', tee: options.logger });
        const handle = openRun({
          layout: runLayout,
          appId: task.appId,
          knowledge: { store, log, evidence: createEvidence(store, log) },
          serving: servingFor(condition),
          providers: providersFor(options.providers, { label: condition, appId: task.appId, n }),
          aiDataDir: options.aiDataDir,
          logger: options.logger,
          ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        const runId = `eval-${slug(condition)}-${task.id}-${String(n)}`;
        try {
          const turn = await handle.turn(runId, task.request, timeout);
          const signatures = new Set(buildSignatures(turn.calls));
          // Before the evaluation's own build, which would add a release the
          // engineer never built.
          const workflowCompleted = workflowCompletedBy(turn.calls, runLayout, task.appId, task);
          let workingCode = false;
          try {
            const built = await handle.build();
            if (built.ok) {
              const checked = await handle.check(built.releaseId, [task.example]);
              workingCode = !checked.childDied && checked.results[0]?.passed === true;
            } else {
              for (const problem of built.problems) signatures.add(problemSignature(problem.stage, problem.message));
            }
          } catch (cause) {
            options.logger.error(`[autoapp] ${runId}: the verification did not run: ${String(cause instanceof Error ? cause.message : cause)}`);
          }
          const offered = offeredFiles(store, runId);
          const read = new Set<string>();
          const touched = new Set<string>();
          for (const call of turn.calls) {
            const paths = pathsOf(call);
            for (const path of paths.read) {
              read.add(path);
              touched.add(path);
            }
            for (const path of paths.edited) touched.add(path);
          }
          const measure: RunMeasure = {
            workingCode,
            workflowCompleted,
            firstEdit: firstWhere(turn.calls, editedBy),
            firstBuild: firstWhere(turn.calls, (call) => buildOf(call) !== null),
            reachedBuild: turn.calls.some((call) => buildOf(call) !== null),
            failedBuilds: failedBuildsOf(turn.calls),
            ms: turn.ms,
            toolMs: turn.toolMs,
            approvals: turn.approvals,
            tokens: turn.tokens.input + turn.tokens.output,
            signatures,
            used: [...offered].filter((path) => touched.has(path)).length,
            ignored: [...offered].filter((path) => !touched.has(path)).length,
            notOffered: [...read].filter((path) => !offered.has(path)).length,
            unrelated: unrelatedHintCredit(store).byStageOrRoutes,
            timedOut: turn.timedOut,
          };
          const list = measured.get(key(condition, task.id)) ?? [];
          list.push(measure);
          measured.set(key(condition, task.id), list);
          // Written as each run ends, so a stopped evaluation still leaves every
          // run it finished, and the table can be rebuilt from them.
          appendFileSync(
            join(base, 'runs.jsonl'),
            `${JSON.stringify({ condition, task: task.id, n, ...measure, signatures: [...measure.signatures] })}\n`,
          );
          options.onRun?.(
            `${condition} ${task.id} ${String(n)}: ${workingCode ? 'working code' : 'not working'}, ${workflowCompleted ? 'workflow completed' : 'workflow not completed'}, ${String(turn.calls.length)} calls, first edit ${String(measure.firstEdit ?? '–')}, first build ${String(measure.firstBuild ?? '–')}, ${duration(turn.ms)}${turn.timedOut ? ', timed out' : ''}`,
          );
        } finally {
          await handle.close();
          store.close();
        }
      }
    }
  }

  const rows: EvaluationRow[] = [];
  for (const condition of CONDITIONS) {
    for (const task of EVALUATION_TASKS) {
      const list = measured.get(key(condition, task.id)) ?? [];
      const seen = new Set<string>();
      let recurring = 0;
      for (const measure of list) {
        for (const signature of measure.signatures) if (seen.has(signature)) recurring += 1;
        for (const signature of measure.signatures) seen.add(signature);
      }
      const meanOf = (values: readonly number[]): number | null =>
        values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
      const edits = list.map((measure) => measure.firstEdit).filter((value): value is number => value !== null);
      const builds = list.map((measure) => measure.firstBuild).filter((value): value is number => value !== null);
      const sum = (pick: (measure: RunMeasure) => number): number => list.reduce((total, measure) => total + pick(measure), 0);
      rows.push({
        condition,
        task: task.id,
        runs: list.length,
        workingCode: list.filter((measure) => measure.workingCode).length,
        workflowCompleted: list.filter((measure) => measure.workflowCompleted).length,
        callsToFirstEdit: { mean: meanOf(edits), of: edits.length },
        callsToFirstBuild: { mean: meanOf(builds), of: builds.length },
        reachedBuild: list.filter((measure) => measure.reachedBuild).length,
        failedBuilds: sum((measure) => measure.failedBuilds),
        meanModelMs: meanOf(list.map((measure) => measure.ms - measure.toolMs)) ?? 0,
        meanToolMs: meanOf(list.map((measure) => measure.toolMs)) ?? 0,
        approvals: sum((measure) => measure.approvals),
        meanTokens: meanOf(list.map((measure) => measure.tokens)) ?? 0,
        recurringSignatures: recurring,
        includedUsed: sum((measure) => measure.used),
        includedIgnored: sum((measure) => measure.ignored),
        readsNotOffered: sum((measure) => measure.notOffered),
        unrelatedCredit: sum((measure) => measure.unrelated),
        timedOut: list.filter((measure) => measure.timedOut).length,
      });
    }
  }
  return { model, rows, markdown: evaluationTable(rows, { model, runs, timeout }) };
}

/** The table, as Markdown. */
export function evaluationTable(
  rows: readonly EvaluationRow[],
  about: { readonly model: { provider: string; id: string }; readonly runs: number; readonly timeout: number },
): string {
  const mean = (value: { mean: number | null; of: number }, runs: number): string =>
    value.mean === null ? '–' : `${value.mean.toFixed(1)}${value.of < runs ? ` (${String(value.of)}/${String(runs)})` : ''}`;
  const lines = [
    `Model ${about.model.provider}/${about.model.id}; ${String(about.runs)} run(s) per cell; ${String(LAUNCHER_MAX_STEPS)} steps a turn; ${duration(about.timeout)} a turn.`,
    'Working code: the evaluation built and previewed what the turn left, and the task example passed. Workflow completed: the engineer itself checked the release it last built and every example passed. The harness answers every question at once, so tool time holds no person’s wait; activation is never part of a run.',
    '',
    '| condition | task | runs | working code | workflow completed | calls to first edit | calls to first build | reached a build | failed builds | timed out | mean model time | mean tool time | approvals | mean tokens | recurring signatures | included refs used | included refs ignored | reads not offered | unrelated hint credit |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${[
        row.condition,
        row.task,
        String(row.runs),
        String(row.workingCode),
        String(row.workflowCompleted),
        mean(row.callsToFirstEdit, row.runs),
        mean(row.callsToFirstBuild, row.runs),
        String(row.reachedBuild),
        String(row.failedBuilds),
        String(row.timedOut),
        duration(row.meanModelMs),
        duration(row.meanToolMs),
        String(row.approvals),
        Math.round(row.meanTokens).toLocaleString('en'),
        String(row.recurringSignatures),
        String(row.includedUsed),
        String(row.includedIgnored),
        String(row.readsNotOffered),
        String(row.unrelatedCredit),
      ].join(' | ')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** What `knowledge evaluate` needs from the launcher it runs in. */
export interface EvaluateCommandOptions {
  readonly root: Layout;
  /** Everything after `knowledge evaluate`. */
  readonly argv: readonly string[];
  readonly providers: ProvidersFor;
  readonly aiDataDir: string;
  readonly notesDir: string;
  readonly templates: Templates;
  readonly versions: { readonly broapp: string; readonly autoapp: string };
  readonly execPath?: string;
  readonly install?: PrepareOptions['install'];
  readonly fetch?: typeof fetch;
  readonly turnTimeoutMs?: number;
  readonly out?: (text: string) => void;
  readonly err?: (line: string) => void;
}

/** `knowledge evaluate [--runs n] [--out <path>]`. Returns the exit code. */
export async function runEvaluateCommand(options: EvaluateCommandOptions): Promise<number> {
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((line: string) => console.error(line));
  const at = (name: string): string | undefined => {
    const index = options.argv.indexOf(name);
    return index < 0 ? undefined : options.argv[index + 1];
  };
  const runsArgument = at('--runs');
  const outPath = at('--out');
  if (runsArgument !== undefined && !/^[1-9]\d*$/.test(runsArgument)) {
    err('usage: broapp-autoapp knowledge evaluate [--runs n] [--out <path>]');
    return 1;
  }
  const logger: HostLogger = { warn: () => undefined, error: (line) => err(line) };
  const knowledge = openKnowledge(join(options.root.root, 'launcher'));
  try {
    const ai = createAi({
      dataDir: options.aiDataDir,
      providers: providersFor(options.providers, { label: 'manifest', appId: 'launcher', n: 0 }),
      app: { name: 'Autoapp', purpose: 'Evaluating the knowledge path.' },
      logger,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    try {
      await ai.model();
    } catch (cause) {
      err(`no model is configured: ${String(cause instanceof Error ? cause.message : cause)}`);
      return 2;
    }
    const { markdown } = await evaluate({
      layout: options.root,
      knowledge,
      ...(runsArgument === undefined ? {} : { runs: Number(runsArgument) }),
      model: () => ai.model(),
      providers: options.providers,
      aiDataDir: options.aiDataDir,
      logger,
      notesDir: options.notesDir,
      templates: options.templates,
      versions: options.versions,
      onRun: err,
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
      ...(options.install === undefined ? {} : { install: options.install }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    });
    if (outPath === undefined) out(markdown);
    else {
      writeFileSync(outPath, markdown);
      err(`written to ${outPath}`);
    }
    return 0;
  } catch (cause) {
    err(String(cause instanceof Error ? cause.message : cause));
    return 1;
  } finally {
    knowledge.close();
  }
}
