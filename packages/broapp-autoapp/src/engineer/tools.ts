/**
 * What the engineer can do, and nothing else.
 *
 * Every tool is a `guardedTool`, so every one of them is a request through the
 * launcher's own gate: `read` runs, `write` asks, and `external` — which is
 * only ever `release.activate` — asks and is refused outright in a preview.
 * There is no bare `execute` in this file, and a test greps for one.
 *
 * Two things are deliberately *not* in any tool's output. A child's launch URL
 * is a credential; the tab gets it from a route a person calls, and the model is
 * told only whether a preview is running. And no path outside the workspace is
 * ever returned, because a path is a suggestion about where to look next.
 */
import { existsSync, rmSync } from 'node:fs';

import { guardedTool } from 'broapp/ai/host';
import type { GuardedTool } from 'broapp/ai/host';
import { publicError } from 'broapp/host';
import type { Envelope, Gate, HostLogger } from 'broapp/host';
import { s } from 'broapp/shared';

import { showLesson } from '../knowledge/cli.ts';
import { exampleHash, type Evidence, type OpenEpisode } from '../knowledge/evidence.ts';
import { origin as originOf, type FullOrigin } from '../knowledge/ids.ts';
import type { EventLog } from '../knowledge/log.ts';
import { scoreBuild, scoreCheck } from '../knowledge/scoring.ts';
import type { Hint, Serve } from '../knowledge/serve.ts';
import type { Session } from '../knowledge/session.ts';
import type { Knowledge } from '../knowledge/store.ts';
import { activate } from '../launcher/activate.ts';
import { listApps } from '../launcher/apps.ts';
import { buildCandidate, type BuildProblem } from '../launcher/candidate.ts';
import { createApplication } from '../launcher/create.ts';
import type { Journal } from '../launcher/journal.ts';
import type { StarterTemplate } from '../launcher/starter.ts';
import type { Supervisor } from '../launcher/supervisor.ts';
import type { PrepareOptions } from '../launcher/workspace.ts';
import {
  diffCapabilities,
  readCurrent,
  readGrants,
  readRelease,
  type AppSpec,
  type Layout,
} from '../spec/index.ts';

import { runAcceptance } from './check.ts';
import { startPreview } from './preview.ts';
import { previewIdOf, type CandidateStates, type CheckResult } from './state.ts';
import {
  applyChange,
  applyEdits,
  diffSummary,
  readTree,
  readWorkspaceFile,
  searchWorkspace,
  snapshot,
} from './workspace.ts';

/** What the engineer's tools need. */
export interface EngineerToolsOptions {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  /** The launcher's own gate. Every tool call passes it. */
  readonly gate: Gate;
  readonly states: CandidateStates;
  readonly logger?: HostLogger;
  /** The starter workspace `apps.create` writes, and what it depends on. */
  readonly template: StarterTemplate;
  readonly versions: { readonly broapp: string; readonly autoapp: string };
  /** Creation's two spawns, injectable so a test reaches no registry and no git. */
  readonly install?: PrepareOptions['install'];
  readonly initGit?: PrepareOptions['initGit'];
  /** Where what the engineer does is written down. Absent, nothing is. */
  readonly knowledge?: EngineerKnowledge;
  /** Where the application the engineer is working on is remembered for the next turn. */
  readonly session?: Session;
}

/** What the tab knows about one live turn, for the case a failure in it opens. */
export interface TurnRecord {
  /** The person's message. */
  readonly message: string;
  /** The `contexts` row for the turn. */
  readonly contextId: number | null;
  readonly model: { readonly provider: string; readonly id: string } | null;
}

/** The launcher's knowledge store, as the tools write to it. */
export interface EngineerKnowledge {
  readonly log: EventLog;
  readonly evidence: Evidence;
  readonly autoappVersion: string;
  /**
   * The turn a run id belongs to, while it is live.
   *
   * The tools see an envelope, which names the run and nothing else; what the
   * person asked for is in the tab, which saw the turn begin.
   */
  readonly turn?: (runId: string) => TurnRecord | undefined;
  /** The store servings are scored in. Absent, nothing is scored. */
  readonly store?: Knowledge;
  /** Where a failed build's hints come from. Absent, a build returns none. */
  readonly serve?: Pick<Serve, 'hints'>;
}

/** Small counts in words, as a person would write them in a sentence. */
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** How many unverified edits earn a warning. */
const UNVERIFIED_WARNING_AT = 3;

const STOP_DEADLINE_MS = 10_000;

/** The most lines of an existing file `source.change` will replace wholesale. */
const MAX_REWRITE_LINES = 60;

/** Just an application id, which is most of these tools' whole input. */
const appIdInput = s.object({ appId: s.string({ min: 1, max: 40 }) });

/** The release that is current, or a refusal that says why not. */
function currentRelease(root: Layout, appId: string): { releaseId: string; spec: AppSpec } {
  const releaseId = readCurrent(root, appId);
  if (releaseId === null) {
    throw publicError.notFound(`${appId} has no current release yet.`);
  }
  return { releaseId, spec: readRelease(root, appId, releaseId) };
}

/** Build the engineer's tools. */
export function engineerTools(options: EngineerToolsOptions): Record<string, GuardedTool> {
  const { layout: root, gate, states, supervisor, journal } = options;
  const logger: HostLogger = options.logger ?? console;

  const tools: Record<string, GuardedTool> = {};

  const knowledge = options.knowledge;
  /**
   * Write something down, and never let that fail the tool.
   *
   * The tool's result is what the person approved. A record of it is worth
   * having and not worth losing the result over, so a store that refuses — a
   * full disk, a resolved case something tried to change — is logged and the
   * tool carries on.
   */
  const note = (what: string, write: (k: EngineerKnowledge) => void): void => {
    if (knowledge === undefined) return;
    try {
      write(knowledge);
    } catch (cause) {
      logger.error(
        `[autoapp] could not record ${what}: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    }
  };
  /** Who a call was, when anything is going to write it down. */
  const identity = (envelope: Envelope | undefined, appId: string, releaseId: string | null): FullOrigin =>
    originOf(envelope, appId, root, releaseId);
  /** Open a case, with what the tab knows about the turn it happened in. */
  const openCase = (
    k: EngineerKnowledge,
    fields: Pick<OpenEpisode, 'appId' | 'stage' | 'problem' | 'example' | 'origin' | 'releaseBefore'>,
  ): void => {
    const turn = k.turn?.(fields.origin.runId);
    k.evidence.open({
      ...fields,
      request: turn?.message ?? '',
      contextId: turn?.contextId ?? null,
      dataSnapshot: null,
      model: turn?.model ?? null,
      autoappVersion: k.autoappVersion,
    });
  };
  /**
   * Remember the application a tool was called for, so the next turn's
   * orientation is about it. Only one that exists: a tool refusing an unknown
   * id must not make it the person's selection.
   */
  const select = (appId: string): void => {
    const session = options.session;
    if (session === undefined) return;
    try {
      if (existsSync(root.app(appId).dir)) session.select(appId);
    } catch {
      // Not an application id; the tool itself says so.
    }
  };
  /**
   * What an edit result says about verification: advisory, never a refusal.
   *
   * Report 08c watched a model make three correct edits and then plan for
   * twenty minutes without building. Every edit now names the next step, and
   * from the third unverified one says so plainly; whether that moves the
   * stall is measured before anything stronger is designed.
   */
  const verification = (
    appId: string,
  ): { editsSinceBuild: number; lastBuild: 'ok' | 'failed' | 'none'; next: 'candidate.build'; warning?: string } => {
    const count = states.noteEdit(appId);
    const state = states.get(appId);
    const lastBuild = state.builtAt === null ? 'none' : state.problems.length === 0 && state.releaseId !== null ? 'ok' : 'failed';
    return {
      editsSinceBuild: count,
      lastBuild,
      next: 'candidate.build',
      ...(count >= UNVERIFIED_WARNING_AT
        ? { warning: `${COUNT_WORDS[count] ?? String(count)} edits are unverified; build before editing more` }
        : {}),
    };
  };
  /** Hints for a failed build, or `undefined` when nothing serves them. */
  const hintsFor = (appId: string, problems: readonly BuildProblem[], who: FullOrigin): readonly Hint[] | undefined => {
    const serve = knowledge?.serve;
    if (serve === undefined) return undefined;
    try {
      return serve.hints(appId, problems, who);
    } catch (cause) {
      logger.error(`[autoapp] could not look up hints: ${String(cause instanceof Error ? cause.message : cause)}`);
      return [];
    }
  };

  tools['apps.list'] = guardedTool(gate, {
    name: 'apps.list',
    description:
      'Every application on this computer: its id, its name, the release it is on, whether it is running, and its data schema version. Start here when you were not told which application to change.',
    inputSchema: s.void().toJsonSchema(),
    effect: 'read',
    // The same rows `launcher.appsList` shows the person, minus the process id:
    // a model has nothing to do with a pid, and a number it cannot use is a
    // number it will try to use.
    run: () =>
      Promise.resolve({
        apps: listApps(root, supervisor, journal).map((row) => ({
          appId: row.appId,
          name: row.name,
          currentRelease: row.currentRelease,
          serving: row.serving,
          schemaVersion: row.schemaVersion,
        })),
      }),
  });

  const createInput = s.object({
    appId: s.string({ min: 3, max: 40 }),
    name: s.string({ min: 1, max: 200 }),
    description: s.optional(s.string({ max: 400 })),
  });
  tools['apps.create'] = guardedTool(gate, {
    name: 'apps.create',
    description:
      'Create a new application from the starter: a list of items with a label, a note and a done flag. Writes the source workspace, installs its dependencies, builds the first release and makes it current. Choose a short id from the name. Creation needs the network once.',
    inputSchema: createInput.toJsonSchema(),
    // `external`, because creation installs the application's dependencies from
    // the registry: it reaches the network, which is what that classification
    // names. The person is asked before an application appears on their
    // computer, as they are for every write.
    effect: 'external',
    run: async (input) => {
      const { appId, name, description } = createInput.parse(input);
      const created = await createApplication({
        layout: root,
        template: options.template,
        versions: options.versions,
        appId,
        name,
        ...(description === undefined ? {} : { description }),
        logger,
        ...(options.install === undefined ? {} : { install: options.install }),
        ...(options.initGit === undefined ? {} : { initGit: options.initGit }),
      });
      select(appId);
      // The route's output without `opened`: a tool never opens a tab, and a
      // model that was told one had opened would say so to somebody looking at
      // a screen where nothing had.
      return created.ok
        ? { ok: true, releaseId: created.releaseId, installed: created.installed, notes: created.notes, problems: [] }
        : {
            ok: false,
            releaseId: null,
            installed: created.installed,
            notes: created.notes,
            problems: created.problems,
          };
    },
  });

  tools['spec.read'] = guardedTool(gate, {
    name: 'spec.read',
    description:
      'The current release of an application: its manifest, its contract, its views, its migrations and its acceptance examples, plus what the person has granted it.',
    inputSchema: appIdInput.toJsonSchema(),
    effect: 'read',
    run: (input) => {
      const { appId } = appIdInput.parse(input);
      select(appId);
      const { releaseId, spec } = currentRelease(root, appId);
      const grants = readGrants(root, appId);
      return Promise.resolve({
        releaseId,
        manifest: spec.manifest,
        contract: spec.contract,
        views: spec.views,
        migrations: spec.migrations,
        acceptance: spec.acceptance,
        granted: grants?.capabilities ?? [],
      });
    },
  });

  tools['source.list'] = guardedTool(gate, {
    name: 'source.list',
    description: "Every file in an application's source workspace, with its size in bytes.",
    inputSchema: appIdInput.toJsonSchema(),
    effect: 'read',
    run: (input) => {
      const { appId } = appIdInput.parse(input);
      select(appId);
      return Promise.resolve({ files: readTree(root.app(appId).source) });
    },
  });

  const readInput = s.object({
    appId: s.string({ min: 1, max: 40 }),
    path: s.string({ min: 1, max: 400 }),
  });
  tools['source.read'] = guardedTool(gate, {
    name: 'source.read',
    description: 'The text of one file in an application’s source workspace.',
    inputSchema: readInput.toJsonSchema(),
    effect: 'read',
    run: (input) => {
      const { appId, path } = readInput.parse(input);
      select(appId);
      return Promise.resolve({ path, content: readWorkspaceFile(root.app(appId).source, path) });
    },
  });

  const searchInput = s.object({
    appId: s.string({ min: 1, max: 40 }),
    pattern: s.string({ min: 1, max: 200 }),
    literal: s.optional(s.boolean()),
    files: s.optional(s.string({ min: 1, max: 200 })),
  });
  tools['source.search'] = guardedTool(gate, {
    name: 'source.search',
    description:
      'Search an application’s source workspace for a regular expression, or for plain text with literal: true. Returns at most 50 matching lines as path, line and text. files is a glob over workspace paths, default src/**. Use it where the evidence says unknown.',
    inputSchema: searchInput.toJsonSchema(),
    effect: 'read',
    run: (input) => {
      const { appId, pattern, literal, files } = searchInput.parse(input);
      select(appId);
      return Promise.resolve(
        searchWorkspace(root.app(appId).source, pattern, {
          ...(literal === undefined ? {} : { literal }),
          ...(files === undefined ? {} : { files }),
        }),
      );
    },
  });

  const changeInput = s.object({
    appId: s.string({ min: 1, max: 40 }),
    message: s.string({ min: 1, max: 500 }),
    changes: s.array(
      s.object({
        path: s.string({ min: 1, max: 400 }),
        content: s.optional(s.string({ max: 200_000 })),
        delete: s.optional(s.boolean()),
      }),
      { min: 1, max: 100 },
    ),
  });
  tools['source.change'] = guardedTool(gate, {
    name: 'source.change',
    description:
      'Create a file, or replace one that is under 60 lines, in an application’s source workspace. For anything else use source.edit. Only src/ and autoapp.json may be changed. Returns a summary of what changed.',
    inputSchema: changeInput.toJsonSchema(),
    effect: 'write',
    run: (input, _signal, envelope) => {
      const { appId, message, changes } = changeInput.parse(input);
      select(appId);
      const sourceDir = root.app(appId).source;
      const before = snapshot(sourceDir);

      // Whole-file rewrites of large files were measured to stall models: the
      // tool call grows with the file rather than with the change, and report
      // 07 watched twenty-two minutes go by composing one. Creating a file is
      // unlimited, because there is no smaller way to say it.
      for (const change of changes) {
        if (change.delete === true) continue;
        const existing = before.get(change.path.split('\\').join('/'));
        if (existing === undefined) continue;
        const lines = existing.split('\n').length;
        if (lines > MAX_REWRITE_LINES) {
          throw publicError.rejected(
            `${change.path} is ${String(lines)} lines, and source.change only replaces files under ${String(MAX_REWRITE_LINES)}. Use source.edit with the smallest hunks that make the change.`,
          );
        }
      }

      const applied = applyChange(
        sourceDir,
        changes.map((change) =>
          change.delete === true
            ? { path: change.path, delete: true as const }
            : { path: change.path, content: change.content ?? '' },
        ),
        message,
      );
      const summary = diffSummary(before, snapshot(sourceDir));
      states.update(appId, { changed: applied.changed });
      note('a change', (k) => {
        // After the commit, so the revision is the one this change produced.
        k.log.event(
          'edit',
          `changed ${String(applied.changed.length)} file(s)`,
          {
            paths: applied.changed,
            hunks: changes.length,
            bytes: Buffer.byteLength(JSON.stringify(changes), 'utf8'),
          },
          identity(envelope, appId, null),
        );
        k.evidence.appendEdit(appId, `${message}\n${summary}`);
      });
      return Promise.resolve({
        changed: applied.changed,
        undo: applied.undo,
        diff: summary,
        verification: verification(appId),
      });
    },
  });

  const editInput = s.object({
    appId: s.string({ min: 1, max: 40 }),
    message: s.string({ min: 1, max: 500 }),
    hunks: s.array(
      s.object({
        path: s.string({ min: 1, max: 400 }),
        find: s.string({ min: 1, max: 20_000 }),
        replace: s.string({ max: 20_000 }),
      }),
      { min: 1, max: 50 },
    ),
  });
  tools['source.edit'] = guardedTool(gate, {
    name: 'source.edit',
    description:
      'Change files in an application’s source workspace by find-and-replace. Each hunk’s "find" must match exactly one place in its file, so make it the smallest unique block — three to eight lines. Leading whitespace need not match: the file keeps its own indentation. Every hunk is checked before any file is written. Only src/ and autoapp.json may be changed.',
    inputSchema: editInput.toJsonSchema(),
    effect: 'write',
    run: (input, _signal, envelope) => {
      const { appId, message, hunks } = editInput.parse(input);
      select(appId);
      const sourceDir = root.app(appId).source;
      const before = snapshot(sourceDir);
      const applied = applyEdits(sourceDir, hunks, message);
      const summary = diffSummary(before, snapshot(sourceDir));
      states.update(appId, { changed: applied.changed });
      note('an edit', (k) => {
        // The size of what the model composed, which is the number report 08b
        // measured the stall against.
        k.log.event(
          'edit',
          `edited ${String(applied.changed.length)} file(s)`,
          {
            paths: applied.changed,
            hunks: hunks.length,
            matchedBy: applied.matchedBy ?? [],
            bytes: Buffer.byteLength(JSON.stringify(hunks), 'utf8'),
          },
          identity(envelope, appId, null),
        );
        k.evidence.appendEdit(appId, `${message}\n${summary}`);
      });
      return Promise.resolve({
        changed: applied.changed,
        undo: applied.undo,
        // Told rather than hidden: a hunk that only matched once whitespace was
        // ignored is a hunk the model should write more carefully next time.
        matchedBy: applied.matchedBy ?? [],
        diff: summary,
        verification: verification(appId),
      });
    },
  });

  tools['candidate.build'] = guardedTool(gate, {
    name: 'candidate.build',
    description:
      'Build a candidate release from the source workspace. Returns the release id, or the problems to fix.',
    inputSchema: appIdInput.toJsonSchema(),
    effect: 'write',
    run: async (input, _signal, envelope) => {
      const { appId } = appIdInput.parse(input);
      select(appId);
      // Taken before the build, so the revision is the one that was built and
      // the release is the one that was running when it was.
      const who = identity(envelope, appId, null);
      const releaseBefore = readCurrent(root, appId);
      const started = Date.now();
      const built = await buildCandidate({ layout: root, appId, logger });
      const ms = Date.now() - started;
      states.resetEdits(appId);
      // Scored before this build's own hints are served, so a hint is judged by
      // the next build and never by the one that produced it.
      note('a score', (k) => {
        if (k.store !== undefined) scoreBuild(k.store, appId, built, who, k.log);
      });
      const stamp = { builtFromRev: who.sourceRev, builtAt: Date.now(), stagesRun: built.stagesRun };
      if (!built.ok) {
        // Returned verbatim rather than summarised: the model is going to fix
        // them, and a paraphrase of a compiler error is worth nothing.
        states.update(appId, { ...stamp, problems: built.problems, releaseId: null });
        note('a build', (k) => {
          k.log.event(
            'build',
            `the build failed with ${String(built.problems.length)} problem(s)`,
            { ok: false, stagesRun: built.stagesRun, problems: built.problems, ms },
            who,
          );
          // One case per distinct failure; the same failure still open is a
          // no-op in the store.
          for (const problem of built.problems) {
            openCase(k, { appId, stage: problem.stage, problem: problem.message, origin: who, releaseBefore });
          }
          // A stage that ran and found nothing has had its failure repaired,
          // even though the build as a whole still fails: that is what
          // `stagesRun` exists to say. A stage that ran into a problem of its
          // own resolves nothing — its old failure became a new one, which is
          // not a repair.
          const clean = built.stagesRun.filter(
            (stage) => !built.problems.some((problem) => problem.stage === stage),
          );
          k.evidence.resolveBuild(appId, clean, who, null);
        });
        // Facts from earlier work that match these problems. Not instructions:
        // the method stays in the engineer's instructions.
        const hints = hintsFor(appId, built.problems, who);
        return { ok: false, problems: built.problems, ...(hints === undefined ? {} : { hints }) };
      }
      const granted = readGrants(root, appId)?.capabilities ?? [];
      states.update(appId, {
        ...stamp,
        releaseId: built.releaseId,
        problems: [],
        capabilityDiff: diffCapabilities(built.spec.manifest.capabilities, granted),
      });
      note('a build', (k) => {
        const after = { ...who, releaseId: built.releaseId };
        k.log.event('build', 'the build succeeded', { ok: true, releaseId: built.releaseId, stagesRun: built.stagesRun, ms }, after);
        k.evidence.resolveBuild(appId, built.stagesRun, after, built.releaseId);
      });
      return { ok: true, releaseId: built.releaseId, schemaVersion: built.spec.manifest.schemaVersion };
    },
  });

  const releaseInput = s.object({
    appId: s.string({ min: 1, max: 40 }),
    releaseId: s.string({ min: 32, max: 32 }),
  });

  tools['candidate.preview'] = guardedTool(gate, {
    name: 'candidate.preview',
    description:
      'Start a candidate release on a copy of the application’s data, so the person can look at it. Nothing it does reaches outside this machine.',
    inputSchema: releaseInput.toJsonSchema(),
    effect: 'write',
    run: async (input, _signal, envelope) => {
      const { appId, releaseId } = releaseInput.parse(input);
      select(appId);
      // The same function the person's Start preview reaches after a restart.
      await startPreview(
        { layout: root, supervisor, states, ...(knowledge === undefined ? {} : { log: knowledge.log }) },
        appId,
        releaseId,
        knowledge === undefined ? {} : identity(envelope, appId, releaseId),
      );
      // Deliberately not the URL. The person opens the preview from the tab.
      return { ok: true };
    },
  });

  tools['candidate.check'] = guardedTool(gate, {
    name: 'candidate.check',
    description:
      'Run the release’s acceptance examples against the running preview, and report what each one did.',
    inputSchema: releaseInput.toJsonSchema(),
    effect: 'read',
    run: async (input, _signal, envelope) => {
      const { appId, releaseId } = releaseInput.parse(input);
      select(appId);
      const preview = states.get(appId).preview;
      if (preview === null) {
        throw publicError.unavailable('There is no preview running for this application.');
      }
      const spec = readRelease(root, appId, releaseId);
      const results: CheckResult[] = await runAcceptance(preview, spec.acceptance);
      // Written down with the example and the child they are about, so a
      // restart, a rebuild or an edited example is not taken as verified.
      const previewId = previewIdOf(preview);
      const hashes = spec.acceptance.map((example) => exampleHash(example));
      states.update(appId, {
        checks: {
          releaseId,
          previewId,
          examples: spec.acceptance.map((example, index) => ({ id: example.id, hash: hashes[index] ?? '' })),
          results,
          at: Date.now(),
        },
      });
      note('a check', (k) => {
        const who = identity(envelope, appId, releaseId);
        const passed = results.filter((result) => result.passed).length;
        k.log.event(
          'check',
          `${String(passed)} of ${String(results.length)} acceptance example(s) passed`,
          { releaseId, previewId, results },
          who,
        );
        spec.acceptance.forEach((example, index) => {
          const result = results[index];
          if (result === undefined) return;
          if (result.passed) {
            k.evidence.resolveCheck(appId, hashes[index] ?? '', who, releaseId);
          } else {
            openCase(k, {
              appId,
              stage: 'check',
              problem: result.detail ?? 'the example failed',
              example: { id: example.id, content: example },
              origin: who,
              releaseBefore: readCurrent(root, appId),
            });
          }
        });
        if (k.store !== undefined) {
          const examples = spec.acceptance.map((example, index) => ({ id: example.id, hash: hashes[index] ?? '' }));
          scoreCheck(k.store, appId, results, examples, releaseId, who);
        }
      });
      return { results };
    },
  });

  tools['candidate.explain'] = guardedTool(gate, {
    name: 'candidate.explain',
    description:
      'The facts about what a candidate changes, compared with what is running: routes, views, migrations, capabilities, schema version. Turn these into the explanation; do not read them out.',
    inputSchema: releaseInput.toJsonSchema(),
    effect: 'read',
    run: (input) => {
      const { appId, releaseId } = releaseInput.parse(input);
      select(appId);
      const candidate = readRelease(root, appId, releaseId);
      const currentId = readCurrent(root, appId);
      const current = currentId === null ? null : readRelease(root, appId, currentId);
      const granted = readGrants(root, appId)?.capabilities ?? [];
      return Promise.resolve(compare(current, candidate, granted));
    },
  });

  tools['release.activate'] = guardedTool(gate, {
    name: 'release.activate',
    // `external` on purpose: it is the one action whose consequences the person
    // has to weigh, it is refused outright in a preview, and it always asks.
    description:
      'Replace what the person is using with this candidate, moving their data across. Ask them first; this is the only action that changes what they are actually running.',
    inputSchema: releaseInput.toJsonSchema(),
    effect: 'external',
    run: async (input, _signal, envelope) => {
      const { appId, releaseId } = releaseInput.parse(input);
      select(appId);
      const preview = states.get(appId).preview;
      // The preview holds a copy of the data open; the switch is cleaner
      // without it, and the candidate is about to become the real thing. It was
      // stopped on purpose, so a restart has nothing to offer to start again.
      if (preview !== null) await preview.shutdown(STOP_DEADLINE_MS);
      states.update(appId, { preview: null, previewWasRunning: false });
      const result = await activate({ layout: root, supervisor, journal, appId, releaseId, logger });
      note('an activation', (k) => {
        k.log.event(
          'activate',
          result.ok ? 'the release was activated' : 'the activation did not complete',
          result.ok
            ? { ok: true, releaseId }
            : { ok: false, phase: result.phase, reason: result.reason, recovered: result.recovered, releaseId },
          identity(envelope, appId, releaseId),
        );
      });
      return result.ok
        ? { ok: true, previousRelease: result.previousRelease }
        : { ok: false, phase: result.phase, reason: result.reason, recovered: result.recovered };
    },
  });

  const lessonInput = s.object({ lessonId: s.number({ int: true, min: 1 }) });
  tools['knowledge.show'] = guardedTool(gate, {
    name: 'knowledge.show',
    description:
      'The whole of one lesson from earlier work: its summary and detail, where it applies, the case it came from, and what happened each time it was served. Use it to read the detail behind a hint or a lesson in your documents.',
    inputSchema: lessonInput.toJsonSchema(),
    effect: 'read',
    run: (input) => {
      const { lessonId } = lessonInput.parse(input);
      const store = knowledge?.store;
      if (store === undefined) throw publicError.unavailable('Nothing is written down in this launcher.');
      const record = showLesson(store, lessonId);
      // A `method_unclear` lesson is a note about the instructions for a person
      // to read, and never enters a prompt — this tool's result included.
      if (record === null || record.diagnosis === 'method_unclear') {
        throw publicError.notFound(`There is no lesson ${String(lessonId)}.`);
      }
      // Without the reviewer's name: who confirmed a lesson is the person's
      // business, not something the model needs to act on.
      return Promise.resolve(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'reviewedBy')));
    },
  });

  tools['preview.stop'] = guardedTool(gate, {
    name: 'preview.stop',
    description: 'Stop the preview and throw away its copy of the data.',
    inputSchema: appIdInput.toJsonSchema(),
    effect: 'write',
    run: async (input) => {
      const { appId } = appIdInput.parse(input);
      select(appId);
      const state = states.get(appId);
      if (state.preview !== null) await state.preview.shutdown(STOP_DEADLINE_MS);
      if (state.releaseId !== null) {
        rmSync(root.app(appId).preview(state.releaseId), { recursive: true, force: true });
      }
      states.update(appId, { preview: null, previewWasRunning: false });
      return { ok: true };
    },
  });

  return tools;
}

/** The machine facts a candidate differs by. */
function compare(
  current: AppSpec | null,
  candidate: AppSpec,
  granted: readonly { kind: string }[],
): Record<string, unknown> {
  const before = current?.contract.operations ?? {};
  const after = candidate.contract.operations;

  const routesAdded = Object.keys(after).filter((route) => !(route in before));
  const routesRemoved = Object.keys(before).filter((route) => !(route in after));
  const effectChanged = Object.keys(after)
    .filter((route) => route in before && before[route]?.effect !== after[route]?.effect)
    .map((route) => ({ route, from: before[route]?.effect, to: after[route]?.effect }));

  const componentIds = (spec: AppSpec | null): Set<string> => {
    const out = new Set<string>();
    const walk = (components: readonly { id: string; children?: readonly unknown[] }[]): void => {
      for (const component of components) {
        out.add(component.id);
        if (component.children !== undefined) {
          walk(component.children as readonly { id: string; children?: readonly unknown[] }[]);
        }
      }
    };
    for (const page of spec?.views.pages ?? []) walk(page.children);
    return out;
  };
  const beforeIds = componentIds(current);
  const afterIds = componentIds(candidate);

  const beforeMigrations = new Set((current?.migrations ?? []).map((step) => step.id));
  const diff = diffCapabilities(candidate.manifest.capabilities, granted as never);

  return {
    routesAdded,
    routesRemoved,
    effectChanged,
    componentsAdded: [...afterIds].filter((id) => !beforeIds.has(id)),
    componentsRemoved: [...beforeIds].filter((id) => !afterIds.has(id)),
    migrationsAdded: candidate.migrations
      .filter((step) => !beforeMigrations.has(step.id))
      .map((step) => ({ id: step.id, description: step.description })),
    capabilitiesAdded: diff.added,
    capabilitiesRemoved: diff.removed,
    schemaVersionFrom: current?.manifest.schemaVersion ?? 0,
    schemaVersionTo: candidate.manifest.schemaVersion,
  };
}
