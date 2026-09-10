/**
 * The steps between "there is a source workspace" and "there is a release".
 *
 * Import copies a workspace somebody wrote; create writes one out of the
 * starter in the binary. After that the two are the same thing, and this is
 * where that sameness lives: install, `git init`, build. What follows a build
 * is deliberately *not* here — whether to ask a person about the capabilities a
 * release asks for is the caller's business, and `import` asks while `create`
 * refuses a starter that asks at all.
 *
 * Nothing here prints. The sentences `import` writes to a terminal are returned
 * as `notes`, because the route and the engineer's tool have to show the same
 * facts somewhere that is not a terminal.
 */
import type { HostLogger } from 'broapp/host';

import { setCurrent, writeGrants, type AppSpec, type Capability, type Layout } from '../spec/index.ts';

import { buildCandidate, type BuildProblem } from './candidate.ts';

/** What {@link prepareWorkspace} needs. */
export interface PrepareOptions {
  readonly layout: Layout;
  readonly appId: string;
  readonly logger?: HostLogger;
  /**
   * Install dependencies in the workspace.
   *
   * Defaults to `BUN_BE_BUN=1 <self> install --production`; tests inject one so
   * a suite reaches no registry.
   */
  readonly install?: (sourceDir: string) => Promise<{ ok: boolean; detail: string }>;
  /** `git init` the workspace. Defaults to the real thing; tests inject one. */
  readonly initGit?: (sourceDir: string) => boolean;
}

/** A release, or everything that is wrong with the workspace. */
export type PrepareResult =
  | {
      readonly ok: true;
      readonly releaseId: string;
      readonly spec: AppSpec;
      readonly installed: boolean;
      readonly notes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly installed: boolean;
      readonly problems: readonly BuildProblem[];
      readonly notes: readonly string[];
    };

/**
 * Install a workspace's dependencies with this binary, acting as `bun`.
 *
 * `BUN_BE_BUN=1` turns a compiled launcher back into the plain `bun` CLI;
 * report 02 verified that. This is the one moment creating or importing an
 * application fetches anything — every candidate build after it resolves what
 * is already on disk, which is what makes editing an application offline mean
 * anything.
 *
 * There is no `--frozen-lockfile`. A workspace written from the starter has no
 * lockfile to freeze, and the one this install writes becomes the workspace's.
 *
 * Spawned rather than `spawnSync` on purpose: this runs inside the launcher's
 * own process, and `launcher.appCreate` is a bridge call. A synchronous spawn
 * would hold the event loop for as long as the registry took, and Brobridge
 * calls a connection with no heartbeat for 45 seconds a dead one.
 */
async function installWithSelf(sourceDir: string): Promise<{ ok: boolean; detail: string }> {
  const running = Bun.spawn({
    cmd: [process.execPath, 'install', '--production'],
    cwd: sourceDir,
    env: { ...process.env, BUN_BE_BUN: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, , stderr] = await Promise.all([
    running.exited,
    new Response(running.stdout as ReadableStream<Uint8Array>).text(),
    new Response(running.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  return {
    ok: code === 0,
    detail: stderr.trim().split('\n').pop() ?? 'no reason given',
  };
}

/** `git init`, quietly. A workspace without history still works. */
function initGitHere(sourceDir: string): boolean {
  const done = Bun.spawnSync({
    cmd: ['git', 'init', '--quiet'],
    cwd: sourceDir,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return done.exitCode === 0;
}

/**
 * Install, initialise a repository, and build the first release.
 *
 * A failed install is not a failed creation: the workspace stays, the build is
 * attempted anyway — a dependency may already be resolvable from somewhere
 * above the workspace — and if it is genuinely missing the build says which
 * package it is.
 */
export async function prepareWorkspace(options: PrepareOptions): Promise<PrepareResult> {
  const app = options.layout.app(options.appId);
  const notes: string[] = [];

  const install = options.install ?? installWithSelf;
  const installed = await install(app.source);
  notes.push(
    installed.ok
      ? 'installed the application’s dependencies'
      : `could not install dependencies here (${installed.detail}); the build will say if one is missing`,
  );

  // Git is optional. A candidate workspace is more useful with history, and the
  // launcher has to work on a machine without it.
  const git = (options.initGit ?? initGitHere)(app.source);
  notes.push(
    git
      ? 'initialised a git repository in the workspace'
      : 'git is not available; the workspace has no history',
  );

  const built = await buildCandidate({
    layout: options.layout,
    appId: options.appId,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  if (!built.ok) return { ok: false, installed: installed.ok, problems: built.problems, notes };
  return { ok: true, releaseId: built.releaseId, spec: built.spec, installed: installed.ok, notes };
}

/**
 * Record the grant and make the release current.
 *
 * Separate from {@link prepareWorkspace} because it is the step after a
 * decision: `import` asks about the capabilities a release wants, `create`
 * refuses a starter that wants any, and only then does either of them say what
 * this application is allowed to do and what it runs.
 */
export function adopt(
  layout: Layout,
  appId: string,
  releaseId: string,
  capabilities: readonly Capability[],
): void {
  writeGrants(layout, appId, {
    appId,
    releaseId,
    grantedAt: Date.now(),
    capabilities,
  });
  setCurrent(layout, appId, releaseId);
}
