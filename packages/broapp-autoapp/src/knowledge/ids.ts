/**
 * Identity at the moment of observation.
 *
 * A tool call knows who it is from the envelope the run loop gave it, and the
 * source workspace knows what it is from git. Both are read here, when the
 * thing happens, and nowhere later. The alternative — attributing a row to
 * whichever run ends next, or to whatever `HEAD` is when somebody looks — is
 * how a record ends up saying something true about the wrong thing.
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Envelope } from 'broapp/host';

import type { Layout } from '../spec/index.ts';

import type { Origin } from './log.ts';

/** An origin with everything a case needs. */
export interface FullOrigin extends Origin {
  readonly runId: string;
  readonly callId: string;
  readonly appId: string;
  readonly sourceRev: string;
}

/**
 * Channels whose request identifiers are `<runId>:<callId>`.
 *
 * The same two the run store groups: a chat turn and a workflow make several
 * calls under one run. Anything else is a single-step run, and its request
 * identifier is both.
 */
const GROUPED: readonly string[] = ['ai', 'workflow'];

/**
 * Who a tool call was, from the envelope it received.
 *
 * No envelope — a direct call nobody can attribute — is the empty identity,
 * which the log stores as `NULL` and which nothing later fills in.
 */
export function origin(
  envelope: Envelope | undefined,
  appId: string,
  layout: Layout,
  releaseId: string | null,
): FullOrigin {
  const requestId = envelope?.requestId ?? '';
  const cut = GROUPED.includes(envelope?.channel ?? '') ? requestId.indexOf(':') : -1;
  return {
    runId: cut < 0 ? requestId : requestId.slice(0, cut),
    callId: cut < 0 ? requestId : requestId.slice(cut + 1),
    appId,
    sourceRev: sourceRevision(layout.app(appId).source),
    ...(releaseId === null ? {} : { releaseId }),
  };
}

/**
 * `git rev-parse HEAD` of a source workspace, or `'no-git'`.
 *
 * Only for a workspace that is a repository *of its own*, for the reason
 * `hasGit` in the engineer's workspace gives: one that merely sits inside
 * somebody's checkout would report their project's revision as the
 * application's. A repository with no commit yet has no revision either.
 */
export function sourceRevision(sourceDir: string): string {
  if (!existsSync(sourceDir)) return 'no-git';
  try {
    const probe = Bun.spawnSync({
      cmd: ['git', 'rev-parse', '--show-toplevel', 'HEAD'],
      cwd: sourceDir,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (probe.exitCode !== 0) return 'no-git';
    const [top, head] = new TextDecoder().decode(probe.stdout).trim().split('\n');
    if (top === undefined || head === undefined || !/^[0-9a-f]{40,64}$/.test(head)) return 'no-git';
    const here = realpathSync(resolve(sourceDir));
    return realpathSync(top) === here ? head : 'no-git';
  } catch {
    // No git on this machine. Its absence is an answer, not a failure.
    return 'no-git';
  }
}
