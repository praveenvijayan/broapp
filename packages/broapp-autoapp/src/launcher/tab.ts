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
import type { DeliveredContext, ProviderAdapter } from 'broapp/ai/host';
import type { Gate, HostLogger } from 'broapp/host';
import type { Bridge } from 'brobridge';

import { ENGINEER_INSTRUCTIONS } from '../engineer/instructions.ts';
import { createCandidateStates, type CandidateStates } from '../engineer/state.ts';
import { engineerTools, type TurnRecord } from '../engineer/tools.ts';
import type { RunStore } from '../host/run-store.ts';
import { recordContext, type Evidence } from '../knowledge/evidence.ts';
import type { EventLog } from '../knowledge/log.ts';
import type { Knowledge } from '../knowledge/store.ts';
import { AUTOAPP_VERSION } from '../knowledge/version.ts';
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
  /**
   * The launcher's knowledge store, its log and its evidence writer.
   *
   * Opened by `main.ts` and handed in, never opened here, so a test can build
   * the same three over a temporary directory and read them afterwards.
   * Absent, nothing is written down and the tab behaves as it always did.
   */
  readonly knowledge?: {
    readonly store: Knowledge;
    readonly log: EventLog;
    readonly evidence: Evidence;
  };
}

/** Everything that mounts on the launcher's bridge. */
export interface LauncherTab {
  mount(bridge: Bridge): void;
  readonly app: LauncherApp;
  readonly ai: Ai;
  readonly states: CandidateStates;
  /** The store this tab writes to, for a test to read; `null` when it writes nowhere. */
  readonly knowledge: Knowledge | null;
}

/** What the engineer is, in the words the model is given first. */
const PURPOSE =
  'You change the applications on this computer. Each one has a source workspace you edit and a release you build from it; a release that is running is never edited in place.';

/** Assemble the launcher's tab. */
export function createLauncherTab(options: CreateLauncherTabOptions): LauncherTab {
  const logger: HostLogger = options.logger ?? console;
  // Over the layout, so the candidate a person left is the one they come back to.
  const states = createCandidateStates(options.layout, logger);
  const knowledge = options.knowledge;

  /**
   * The live turns: what the person asked and what the turn was given.
   *
   * Filled from `onContext`, which arrives before the model is called, and not
   * from `onRunEnd`, which arrives after every tool the turn made has already
   * run — too late for the case a failed build opens to say what was asked.
   */
  const turns = new Map<string, TurnRecord>();

  const app = createLauncherApp({
    layout: options.layout,
    supervisor: options.supervisor,
    journal: options.journal,
    states,
    gate: options.gate,
    logger,
    ...(knowledge === undefined ? {} : { log: knowledge.log }),
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
      ...(knowledge === undefined
        ? {}
        : {
            knowledge: {
              log: knowledge.log,
              evidence: knowledge.evidence,
              autoappVersion: AUTOAPP_VERSION,
              turn: (runId: string) => turns.get(runId),
            },
          }),
    }),
    ...(knowledge === undefined
      ? {}
      : {
          onContext: (runId: string, delivered: DeliveredContext) => {
            // The turn is remembered even when its context cannot be written,
            // so a case opened during it still carries what was asked.
            let contextId: number | null = null;
            try {
              contextId = recordContext(knowledge.store, {
                runId,
                appId: null,
                instructions: ENGINEER_INSTRUCTIONS,
                delivered,
                // Nothing serves knowledge yet, so nothing was asked for or found.
                requested: [],
                resolved: [],
              });
            } catch (cause) {
              logger.error(
                `[autoapp] could not record what a turn was given: ${String(cause instanceof Error ? cause.message : cause)}`,
              );
            }
            turns.set(runId, { message: delivered.message, contextId, model: delivered.model });
          },
        }),
    onRunEnd: (runId, status, summary, detail) => {
      turns.delete(runId);
      if (knowledge !== undefined) {
        knowledge.log.event(
          'run',
          `a turn ended: ${status}`,
          { status, ...(detail === undefined ? {} : { steps: detail.steps, ms: detail.ms }) },
          { runId },
        );
        if (detail?.usage !== undefined) {
          knowledge.log.event('usage', 'tokens a turn used', { ...detail.usage }, { runId });
        }
      }
      options.store.finishRun(runId, status, summary);
    },
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
    knowledge: knowledge?.store ?? null,
  };
}
