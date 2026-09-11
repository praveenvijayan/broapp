/**
 * One run of the engineer, away from everything live.
 *
 * A replay and the evaluation need the same thing: a checkout of one source
 * revision in a directory of its own, the release it was running, the
 * launcher's tab over that directory with a knowledge store of its own, one
 * turn, and then a build and — where there is an example — a check the
 * engineer did not run and could not change. Nothing here writes to the live
 * application: its workspace is read by `git clone`, its release and data are
 * copied, its dependencies are linked, and every child a run starts is stopped
 * before `close` returns.
 *
 * The turn is the `ai.chat` route's own loop, run in-process by `Ai.turn`
 * (core change for 12d) rather than over a bridge, because there is no browser
 * here to hold one. The run stands in for the person: it allows the edits,
 * builds and previews a turn asks for, and declines activation and creation
 * outright — a replay never changes what anybody is running, and never
 * fetches anything.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { LanguageModel } from 'ai';
import type { ChatEvent, ProviderAdapter } from 'broapp/ai/host';
import type { HostLogger } from 'broapp/host';

import { runAcceptance } from '../engineer/check.ts';
import { startPreview } from '../engineer/preview.ts';
import type { CheckResult } from '../engineer/state.ts';
import { createRunStore } from '../host/run-store.ts';
import { createLauncherGate, LAUNCHER_MAX_STEPS } from '../launcher/app.ts';
import { buildCandidate, type BuildCandidateResult } from '../launcher/candidate.ts';
import { openJournal } from '../launcher/journal.ts';
import { snapshotDirectory } from '../launcher/snapshot.ts';
import { createSupervisor } from '../launcher/supervisor.ts';
import { createLauncherTab, type CreateLauncherTabOptions } from '../launcher/tab.ts';
import type { PrepareOptions } from '../launcher/workspace.ts';
import { layout as layoutOf, setCurrent, type AcceptanceExample, type Layout } from '../spec/index.ts';

import type { Evidence } from './evidence.ts';
import type { EventLog } from './log.ts';
import { openSession } from './session.ts';
import type { Knowledge } from './store.ts';

/** Which run a set of providers is for, so a test can script each one. */
export interface RunLabel {
  /** `with`, `without` or `regression` in a replay; the condition in an evaluation. */
  readonly label: string;
  readonly appId: string;
  readonly n: number;
}

/** The providers a run's tab is built with: the same for every run, or chosen per run. */
export type ProvidersFor = readonly ProviderAdapter[] | ((run: RunLabel) => readonly ProviderAdapter[]);

/** The providers for one run. */
export function providersFor(providers: ProvidersFor, run: RunLabel): readonly ProviderAdapter[] {
  return typeof providers === 'function' ? providers(run) : providers;
}

/** The provider and model a model instance names. */
export function identityOf(model: LanguageModel): { readonly provider: string; readonly id: string } {
  if (typeof model === 'string') return { provider: 'unknown', id: model };
  return { provider: model.provider, id: model.modelId };
}

/** Where a run's workspace, release and data come from. */
export interface RunSource {
  /** The live workspace. Cloned, never written. */
  readonly sourceDir: string;
  readonly rev: string;
  /** The release the checkout was running, copied in and made current. */
  readonly release: { readonly dir: string; readonly id: string } | null;
  readonly grants: string | null;
  /** A data directory, copied in as the application's data. */
  readonly data: string | null;
}

/** Git with an identity, so a machine that has none configured can still commit. */
export function git(cwd: string, args: readonly string[]): string {
  const done = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Autoapp replay',
      GIT_AUTHOR_EMAIL: 'replay@localhost',
      GIT_COMMITTER_NAME: 'Autoapp replay',
      GIT_COMMITTER_EMAIL: 'replay@localhost',
    },
  });
  if (done.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed: ${new TextDecoder().decode(done.stderr).trim()}`);
  }
  return new TextDecoder().decode(done.stdout).trim();
}

/**
 * Lay out one run's directory: the checkout, the release, the data.
 *
 * A clone at the revision rather than a worktree or an archive: nothing is
 * registered in the live repository, and the checkout's `HEAD` is the revision
 * the manifest names, so every row the run writes carries that revision and
 * the engineer's commits land on top of it.
 */
export function prepareRun(runDir: string, appId: string, from: RunSource): Layout {
  const runLayout = layoutOf(runDir);
  const app = runLayout.app(appId);
  mkdirSync(app.dir, { recursive: true, mode: 0o700 });
  git(app.dir, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', from.sourceDir, app.source]);
  git(app.source, ['checkout', '--quiet', '--detach', from.rev]);

  // Linked rather than installed: a run must not fetch anything, and must
  // build against exactly what the case built against. Excluded, so an edit's
  // `git add -A` does not commit the link.
  const modules = join(from.sourceDir, 'node_modules');
  if (existsSync(modules) && !existsSync(join(app.source, 'node_modules'))) {
    symlinkSync(modules, join(app.source, 'node_modules'), 'junction');
    appendFileSync(join(app.source, '.git', 'info', 'exclude'), '\nnode_modules\n');
  }
  if (from.release !== null) {
    cpSync(from.release.dir, app.release(from.release.id), { recursive: true });
    setCurrent(runLayout, appId, from.release.id);
  }
  if (from.grants !== null && existsSync(from.grants)) cpSync(from.grants, app.grants);
  // `VACUUM INTO` again rather than a byte copy: the rule is the same whether or
  // not anything has the source open.
  if (from.data !== null && existsSync(from.data)) snapshotDirectory(from.data, app.data);
  return runLayout;
}

/** One tool call of a turn, with what it returned. */
export interface ToolCall {
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
}

/** How one turn went. */
export interface TurnOutcome {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  /** The run's time limit ended it. */
  readonly timedOut: boolean;
  readonly error?: string;
  readonly ms: number;
  readonly calls: readonly ToolCall[];
  readonly tokens: { readonly input: number; readonly output: number };
}

/** What {@link openRun} needs. */
export interface OpenRunOptions {
  /** The run's own root, from {@link prepareRun}. */
  readonly layout: Layout;
  readonly appId: string;
  readonly knowledge: { readonly store: Knowledge; readonly log: EventLog; readonly evidence: Evidence };
  readonly serving: NonNullable<CreateLauncherTabOptions['serving']>;
  readonly providers: readonly ProviderAdapter[];
  /** Where the configured provider's settings are. Read, never changed. */
  readonly aiDataDir: string;
  /** The binary a run's children are started from. Defaults to this launcher. */
  readonly execPath?: string;
  readonly logger: HostLogger;
  readonly install?: PrepareOptions['install'];
  readonly maxSteps?: number;
  readonly fetch?: typeof fetch;
}

/** One run's tab, and what can be done with it. */
export interface RunHandle {
  readonly layout: Layout;
  readonly appId: string;
  /** One turn, ended by its own finish or by `timeoutMs`. */
  turn(runId: string, message: string, timeoutMs: number): Promise<TurnOutcome>;
  build(): Promise<BuildCandidateResult>;
  /** Start a release on the run's data and run examples; `childDied` when the preview did not survive them. */
  check(
    releaseId: string,
    examples: readonly AcceptanceExample[],
  ): Promise<{ readonly results: readonly CheckResult[]; readonly childDied: boolean }>;
  close(): Promise<void>;
}

/** The questions a run answers yes to. Activation and creation are declined, always. */
export const RUN_APPROVES: ReadonlySet<string> = new Set([
  'source.edit',
  'source.change',
  'candidate.build',
  'candidate.preview',
  'preview.stop',
]);

const STOP_DEADLINE_MS = 10_000;
/** How long a preview is given to show that it died. */
const DEATH_WINDOW_MS = 100;

/** A run installs nothing: its dependencies are the live workspace's, linked. */
const noInstall: NonNullable<PrepareOptions['install']> = () =>
  Promise.resolve({ ok: true, detail: 'a run installs nothing; its dependencies are linked' });

/** Build a run's tab over its directory. */
export function openRun(options: OpenRunOptions): RunHandle {
  const { layout, appId, logger } = options;
  const dataDir = join(layout.root, 'launcher');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const journal = openJournal(layout.journal);
  const supervisor = createSupervisor({
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    logger: options.knowledge.log,
  });
  const store = createRunStore(dataDir, logger);
  const gate = createLauncherGate({ releaseId: 'launcher', recorder: store.recorder(), logger });
  const tab = createLauncherTab({
    layout,
    supervisor,
    journal,
    gate,
    // The launcher's own AI settings, so a run uses the provider a person
    // configured without its key being copied anywhere.
    dataDir: options.aiDataDir,
    session: openSession(dataDir, logger),
    store,
    providers: options.providers,
    logger,
    openBrowser: () => Promise.resolve(false),
    template: { files: {} },
    versions: { broapp: '*', autoapp: '*' },
    install: options.install ?? noInstall,
    initGit: () => false,
    knowledge: options.knowledge,
    maxSteps: options.maxSteps ?? LAUNCHER_MAX_STEPS,
    serving: options.serving,
    distil: false,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  let closed = false;
  return {
    layout,
    appId,

    async turn(runId, message, timeoutMs) {
      const started = Date.now();
      const limit = AbortSignal.timeout(timeoutMs);
      const result = await tab.ai.turn(
        { runId, message },
        { answer: ({ tool }) => RUN_APPROVES.has(tool), signal: limit },
      );
      return {
        status: result.status,
        timedOut: limit.aborted,
        ...(result.error === undefined ? {} : { error: result.error }),
        ms: Date.now() - started,
        calls: callsOf(result.events),
        tokens: tokensOf(result.events),
      };
    },

    build: () => buildCandidate({ layout, appId, logger }),

    async check(releaseId, examples) {
      let preview;
      try {
        preview = await startPreview({ layout, supervisor, states: tab.states, log: options.knowledge.log }, appId, releaseId);
      } catch (cause) {
        const detail = `the preview did not start: ${String(cause instanceof Error ? cause.message : cause)}`;
        return {
          results: examples.map((example) => ({ id: example.id, title: example.title, passed: false, detail })),
          childDied: true,
        };
      }
      const results = await runAcceptance(preview, examples);
      const died = await Promise.race([
        preview.exited.then(() => true),
        Bun.sleep(DEATH_WINDOW_MS).then(() => false),
      ]);
      return { results, childDied: died };
    },

    async close() {
      if (closed) return;
      closed = true;
      tab.ai.abortAll('the run is over');
      await supervisor.stopAll(STOP_DEADLINE_MS);
      tab.ai.close();
      store.close();
      journal.close();
    },
  };
}

/** A turn's tool calls, in order, each with its result. */
function callsOf(events: readonly ChatEvent[]): ToolCall[] {
  const calls: { callId: string; tool: string; input: unknown; output: unknown }[] = [];
  for (const event of events) {
    if (event.type === 'tool-call') {
      calls.push({ callId: event.callId ?? '', tool: event.tool ?? '', input: event.input, output: undefined });
    } else if (event.type === 'tool-result') {
      const call = calls.find((entry) => entry.callId === event.callId);
      if (call !== undefined) call.output = event.output;
    }
  }
  return calls.map(({ tool, input, output }) => ({ tool, input, output }));
}

/** What a turn's usage events add up to. */
function tokensOf(events: readonly ChatEvent[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const event of events) {
    if (event.type !== 'usage') continue;
    input += event.inputTokens ?? 0;
    output += event.outputTokens ?? 0;
  }
  return { input, output };
}
