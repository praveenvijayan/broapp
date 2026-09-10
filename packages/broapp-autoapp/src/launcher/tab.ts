/**
 * The launcher's own tab: its host app, its engineer, and its page.
 *
 * Assembled here rather than in `main.ts` so the same assembly can be built in
 * a test without a compiled binary. What it puts together is the whole of
 * prompt 07: the launcher's routes, the engineer's tools over the launcher's
 * gate, and the AI layer that connects the two.
 *
 * The engineer's gate is the launcher's gate. That is deliberate: `spec.read`
 * runs, `source.change` and `candidate.build` ask, and `release.activate` —
 * the only `external` tool — always asks and could never run in a preview.
 */
import { createAi, type Ai } from 'broapp/ai/host';
import type { ProviderAdapter } from 'broapp/ai/host';
import type { Gate, HostLogger } from 'broapp/host';
import type { Bridge } from 'brobridge';

import { ENGINEER_INSTRUCTIONS } from '../engineer/instructions.ts';
import { createCandidateStates, type CandidateStates } from '../engineer/state.ts';
import { engineerTools } from '../engineer/tools.ts';
import type { RunStore } from '../host/run-store.ts';
import type { Layout } from '../spec/index.ts';

import { createLauncherApp, LAUNCHER_CONFIRM_TIMEOUT_MS, type LauncherApp } from './app.ts';
import type { Journal } from './journal.ts';
import type { StarterTemplate } from './starter.ts';
import type { Supervisor } from './supervisor.ts';
import type { PrepareOptions } from './workspace.ts';

/** What the launcher's tab needs to exist. */
export interface CreateLauncherTabOptions {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly gate: Gate;
  /** Where the launcher keeps its own AI settings and its own run history. */
  readonly dataDir: string;
  readonly store: RunStore;
  /** The providers compiled into this launcher. */
  readonly providers: readonly ProviderAdapter[];
  /** Tests inject one that reaches nothing. */
  readonly fetch?: typeof fetch;
  /** How long a question waits. Defaults to the launcher's ten minutes. */
  readonly confirmTimeoutMs?: number;
  readonly logger?: HostLogger;
  /** How a tab is opened for an application or a preview. Tests stub it. */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  /** The starter workspace this launcher carries, and what it depends on. */
  readonly template: StarterTemplate;
  readonly versions: { readonly broapp: string; readonly autoapp: string };
  /** Creation's two spawns, injectable so a test reaches no registry and no git. */
  readonly install?: PrepareOptions['install'];
  readonly initGit?: PrepareOptions['initGit'];
}

/** Everything that mounts on the launcher's bridge. */
export interface LauncherTab {
  mount(bridge: Bridge): void;
  readonly app: LauncherApp;
  readonly ai: Ai;
  readonly states: CandidateStates;
}

/** What the engineer is, in the words the model is given first. */
const PURPOSE =
  'You change the applications on this computer. Each one has a source workspace you edit and a release you build from it; a release that is running is never edited in place.';

/** Assemble the launcher's tab. */
export function createLauncherTab(options: CreateLauncherTabOptions): LauncherTab {
  const logger: HostLogger = options.logger ?? console;
  const states = createCandidateStates();

  const app = createLauncherApp({
    layout: options.layout,
    supervisor: options.supervisor,
    journal: options.journal,
    states,
    gate: options.gate,
    logger,
    template: options.template,
    versions: options.versions,
    ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
    ...(options.install === undefined ? {} : { install: options.install }),
    ...(options.initGit === undefined ? {} : { initGit: options.initGit }),
  });

  const ai = createAi({
    dataDir: options.dataDir,
    providers: options.providers,
    // The same window the gate was built with. The AI layer applies a deadline
    // of its own (report 01, deviation 2), and a shorter one here would quietly
    // undercut the gate's — the person would watch a countdown that was already
    // over.
    confirmTimeoutMs: options.confirmTimeoutMs ?? LAUNCHER_CONFIRM_TIMEOUT_MS,
    app: {
      name: 'Autoapp',
      purpose: PURPOSE,
      terminology: ['application', 'release', 'candidate', 'preview', 'activation', 'capability'],
      instructions: ENGINEER_INSTRUCTIONS,
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    tools: engineerTools({
      layout: options.layout,
      supervisor: options.supervisor,
      journal: options.journal,
      // The same gate the tab's own clicks pass. One door, two directions.
      gate: options.gate,
      states,
      logger,
      template: options.template,
      versions: options.versions,
      ...(options.install === undefined ? {} : { install: options.install }),
      ...(options.initGit === undefined ? {} : { initGit: options.initGit }),
    }),
    onRunEnd: (runId, status, summary) => options.store.finishRun(runId, status, summary),
    logger,
  });

  return {
    mount: (bridge: Bridge) => {
      app.mount(bridge);
      ai.mount(bridge);
    },
    app,
    ai,
    states,
  };
}
