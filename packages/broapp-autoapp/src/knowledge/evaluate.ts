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
import type { StarterTemplate } from '../launcher/starter.ts';
import { adopt, prepareWorkspace, type PrepareOptions } from '../launcher/workspace.ts';
import { layout as layoutOf, readCurrent, type AcceptanceExample, type Layout } from '../spec/index.ts';

import { createEvidence } from './evidence.ts';
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
 * a person would reasonably expect — in the one form a check can judge: an
 * output with no timestamps in it. The engineer can read it in `autoapp.json`,
 * as it can read any example there.
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
      id: 'eval-archive-hides',
      title: 'An archived note leaves the main list',
      steps: [
        { route: 'notes.create', input: { title: 'Archive me', body: '' } },
        { route: 'notes.archive', input: { id: 1 } },
        { route: 'notes.list', input: {}, expect: { notes: [] } },
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
      title: 'Filtering to done items leaves out the open ones',
      steps: [
        { route: 'items.add', input: { label: 'Still open' } },
        { route: 'items.list', input: { done: true }, expect: { items: [], count: 0 } },
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
      title: 'Filtering by a tag leaves out untagged notes',
      steps: [
        { route: 'notes.create', input: { title: 'Untagged', body: '' } },
        { route: 'notes.list', input: { tag: 'work' }, expect: { notes: [] } },
      ],
    },
  },
];

/** One line of the table. */
export interface EvaluationRow {
  readonly condition: Condition;
  readonly task: string;
  readonly runs: number;
  readonly verified: number;
  /** Mean over the runs that edited; how many did. */
  readonly callsToFirstEdit: { readonly mean: number | null; readonly of: number };
  readonly callsToFirstBuild: { readonly mean: number | null; readonly of: number };
  readonly reachedBuild: number;
  readonly meanMs: number;
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
  readonly template: StarterTemplate;
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
      template: options.template,
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
  verified: boolean;
  firstEdit: number | null;
  firstBuild: number | null;
  reachedBuild: boolean;
  ms: number;
  tokens: number;
  signatures: Set<string>;
  used: number;
  ignored: number;
  notOffered: number;
  unrelated: number;
  timedOut: boolean;
}

/** The 1-based position of the first call to one of these tools, or `null`. */
function firstCall(calls: readonly ToolCall[], tools: readonly string[]): number | null {
  const at = calls.findIndex((call) => tools.includes(call.tool));
  return at < 0 ? null : at + 1;
}

/** Paths a call read or edited. */
function pathsOf(call: ToolCall): { read: string[]; edited: string[] } {
  const input = (call.input ?? {}) as { path?: unknown; hunks?: unknown; changes?: unknown };
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
  return { read: [], edited: [] };
}

/** Failure signatures from the builds a turn ran. */
function buildSignatures(calls: readonly ToolCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    if (call.tool !== 'candidate.build') continue;
    const problems = (call.output as { problems?: unknown } | undefined)?.problems;
    if (!Array.isArray(problems)) continue;
    for (const problem of problems as { stage?: unknown; message?: unknown }[]) {
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
          let verified = false;
          try {
            const built = await handle.build();
            if (built.ok) {
              const checked = await handle.check(built.releaseId, [task.example]);
              verified = !checked.childDied && checked.results[0]?.passed === true;
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
            verified,
            firstEdit: firstCall(turn.calls, ['source.edit', 'source.change']),
            firstBuild: firstCall(turn.calls, ['candidate.build']),
            reachedBuild: turn.calls.some((call) => call.tool === 'candidate.build'),
            ms: turn.ms,
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
          options.onRun?.(
            `${condition} ${task.id} ${String(n)}: ${verified ? 'verified' : 'not verified'}, ${String(turn.calls.length)} calls, first edit ${String(measure.firstEdit ?? '–')}, first build ${String(measure.firstBuild ?? '–')}, ${duration(turn.ms)}${turn.timedOut ? ', timed out' : ''}`,
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
        verified: list.filter((measure) => measure.verified).length,
        callsToFirstEdit: { mean: meanOf(edits), of: edits.length },
        callsToFirstBuild: { mean: meanOf(builds), of: builds.length },
        reachedBuild: list.filter((measure) => measure.reachedBuild).length,
        meanMs: meanOf(list.map((measure) => measure.ms)) ?? 0,
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
    '',
    '| condition | task | runs | verified | calls to first edit | calls to first build | reached a build | timed out | mean time | mean tokens | recurring signatures | included refs used | included refs ignored | reads not offered | unrelated hint credit |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${[
        row.condition,
        row.task,
        String(row.runs),
        String(row.verified),
        mean(row.callsToFirstEdit, row.runs),
        mean(row.callsToFirstBuild, row.runs),
        String(row.reachedBuild),
        String(row.timedOut),
        duration(row.meanMs),
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
  readonly template: StarterTemplate;
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
      template: options.template,
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
