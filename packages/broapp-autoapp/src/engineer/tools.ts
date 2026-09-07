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
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import { guardedTool } from 'broapp/ai/host';
import type { GuardedTool } from 'broapp/ai/host';
import { publicError } from 'broapp/host';
import type { Gate, HostLogger } from 'broapp/host';
import { s } from 'broapp/shared';

import { activate } from '../launcher/activate.ts';
import { buildCandidate } from '../launcher/candidate.ts';
import { connectToChild } from '../launcher/client.ts';
import type { Journal } from '../launcher/journal.ts';
import { snapshotDirectory } from '../launcher/snapshot.ts';
import type { Supervisor } from '../launcher/supervisor.ts';
import {
  diffCapabilities,
  readCurrent,
  readGrants,
  readRelease,
  type AppSpec,
  type Layout,
} from '../spec/index.ts';

import type { CandidateStates, CheckResult } from './state.ts';
import {
  applyChange,
  applyEdits,
  diffSummary,
  readTree,
  readWorkspaceFile,
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
}

/** How long a preview child gets to stop. */
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

  tools['spec.read'] = guardedTool(gate, {
    name: 'spec.read',
    description:
      'The current release of an application: its manifest, its contract, its views, its migrations and its acceptance examples, plus what the person has granted it.',
    inputSchema: appIdInput.toJsonSchema(),
    effect: 'read',
    run: (input) => {
      const { appId } = appIdInput.parse(input);
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
      return Promise.resolve({ path, content: readWorkspaceFile(root.app(appId).source, path) });
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
    run: (input) => {
      const { appId, message, changes } = changeInput.parse(input);
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
      return Promise.resolve({ changed: applied.changed, undo: applied.undo, diff: summary });
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
      'Change files in an application’s source workspace by exact find-and-replace. Each hunk’s "find" must occur exactly once in its file, so include two or three lines of surrounding context. Every hunk is checked before any file is written. Only src/ and autoapp.json may be changed.',
    inputSchema: editInput.toJsonSchema(),
    effect: 'write',
    run: (input) => {
      const { appId, message, hunks } = editInput.parse(input);
      const sourceDir = root.app(appId).source;
      const before = snapshot(sourceDir);
      const applied = applyEdits(sourceDir, hunks, message);
      const summary = diffSummary(before, snapshot(sourceDir));
      states.update(appId, { changed: applied.changed });
      return Promise.resolve({ changed: applied.changed, undo: applied.undo, diff: summary });
    },
  });

  tools['candidate.build'] = guardedTool(gate, {
    name: 'candidate.build',
    description:
      'Build a candidate release from the source workspace. Returns the release id, or the problems to fix.',
    inputSchema: appIdInput.toJsonSchema(),
    effect: 'write',
    run: async (input) => {
      const { appId } = appIdInput.parse(input);
      const built = await buildCandidate({ layout: root, appId, logger });
      if (!built.ok) {
        // Returned verbatim rather than summarised: the model is going to fix
        // them, and a paraphrase of a compiler error is worth nothing.
        states.update(appId, { problems: built.problems, releaseId: null });
        return { ok: false, problems: built.problems };
      }
      const granted = readGrants(root, appId)?.capabilities ?? [];
      states.update(appId, {
        releaseId: built.releaseId,
        problems: [],
        capabilityDiff: diffCapabilities(built.spec.manifest.capabilities, granted),
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
    run: async (input) => {
      const { appId, releaseId } = releaseInput.parse(input);
      const app = root.app(appId);
      const previous = states.get(appId).preview;
      if (previous !== null) await previous.shutdown(STOP_DEADLINE_MS);

      const directory = app.preview(releaseId);
      // A fresh copy every time. A preview that reused the last one would show
      // the person the effects of the previous preview as if they were theirs.
      rmSync(directory, { recursive: true, force: true });
      if (existsSync(app.data)) snapshotDirectory(app.data, directory);
      else mkdirSync(directory, { recursive: true, mode: 0o700 });

      const child = await supervisor.start({
        appId,
        releaseDir: app.release(releaseId),
        releaseId,
        dataDir: directory,
        mode: 'preview',
      });
      states.update(appId, { preview: child, releaseId, checks: [] });
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
    run: async (input) => {
      const { appId, releaseId } = releaseInput.parse(input);
      const preview = states.get(appId).preview;
      if (preview === null) {
        throw publicError.unavailable('There is no preview running for this application.');
      }
      const spec = readRelease(root, appId, releaseId);
      const results: CheckResult[] = [];
      // One connection for every example: a launch URL carries a single-use
      // token, so a second `connect` to the same URL is refused.
      const bridge = await connectToChild(preview.url);
      try {
        for (const example of spec.acceptance) {
          try {
            let detail = '';
            let passed = true;
            for (const step of example.steps) {
              const output: unknown = await bridge.call(step.route, step.input);
              if (step.expect !== undefined && JSON.stringify(output) !== JSON.stringify(step.expect)) {
                passed = false;
                detail = `${step.route} returned ${JSON.stringify(output)}, not ${JSON.stringify(step.expect)}`;
                break;
              }
            }
            results.push({ id: example.id, title: example.title, passed, ...(detail === '' ? {} : { detail }) });
          } catch (cause) {
            results.push({
              id: example.id,
              title: example.title,
              passed: false,
              detail: String(cause instanceof Error ? cause.message : cause),
            });
          }
        }
      } finally {
        await bridge.close();
      }
      states.update(appId, { checks: results });
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
    run: async (input) => {
      const { appId, releaseId } = releaseInput.parse(input);
      const preview = states.get(appId).preview;
      if (preview !== null) {
        // The preview holds a copy of the data open; the switch is cleaner
        // without it, and the candidate is about to become the real thing.
        await preview.shutdown(STOP_DEADLINE_MS);
        states.update(appId, { preview: null });
      }
      const result = await activate({ layout: root, supervisor, journal, appId, releaseId, logger });
      return result.ok
        ? { ok: true, previousRelease: result.previousRelease }
        : { ok: false, phase: result.phase, reason: result.reason, recovered: result.recovered };
    },
  });

  tools['preview.stop'] = guardedTool(gate, {
    name: 'preview.stop',
    description: 'Stop the preview and throw away its copy of the data.',
    inputSchema: appIdInput.toJsonSchema(),
    effect: 'write',
    run: async (input) => {
      const { appId } = appIdInput.parse(input);
      const state = states.get(appId);
      if (state.preview !== null) await state.preview.shutdown(STOP_DEADLINE_MS);
      if (state.releaseId !== null) {
        rmSync(root.app(appId).preview(state.releaseId), { recursive: true, force: true });
      }
      states.update(appId, { preview: null });
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
