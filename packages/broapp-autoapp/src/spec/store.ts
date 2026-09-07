/**
 * Releases on disk.
 *
 * A release directory is immutable and named by what is in it, so writing one
 * has exactly two acceptable outcomes: the whole thing is there under its own
 * name, or nothing is. Everything here is written into a temporary sibling and
 * renamed into place, which on both POSIX and Windows is the closest thing to
 * an atomic directory publish there is.
 *
 * The `current` pointer is the same idea one level up. A launcher that crashes
 * between deciding to activate and finishing the write must find, on restart,
 * either the old release or the new one — never a truncated file naming
 * neither.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { publicError } from 'broapp/host';

import { checkViewsAgainstContract } from '../views/check.ts';

import type { AppLayout, Layout } from './layout.ts';
import { releaseId as computeReleaseId } from './release-id.ts';
import type { AppSpec } from './types.ts';
import { parseSpec } from './validate.ts';

/** The three files a release directory holds. */
const SPEC_FILE = 'spec.json';
const PAGE_FILE = 'page.html';
const HOST_FILE = 'host.js';

/** The bytes a release is built from. */
export interface ReleaseFiles {
  readonly page: Uint8Array;
  readonly host: Uint8Array;
}

/** One release, as `listReleases` reports it. */
export interface ReleaseSummary {
  readonly releaseId: string;
  readonly createdAt: number;
}

/**
 * Refuse a path that is not inside the application's own directory.
 *
 * The application id pattern already forbids a separator, so this cannot
 * trigger for an id that reached here through `layout`. It is the second lock
 * on the same door: every write in this file goes through it, so a future
 * caller that builds a path some other way is caught rather than trusted.
 */
function within(app: AppLayout, path: string): string {
  const root = resolve(app.dir);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`) && !target.startsWith(`${root}\\`)) {
    throw new TypeError(`refusing to touch ${JSON.stringify(path)}, which is outside ${root}`);
  }
  return target;
}

/** Pretty JSON with a trailing newline, so a release file reads well in a diff. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write one file into place without ever leaving a half-written one behind.
 *
 * A reader that opens the target sees either the old contents or the new ones.
 * The temporary file is a sibling so the rename stays on one filesystem, where
 * it is atomic.
 */
function writeAtomic(path: string, contents: string | Uint8Array): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

/**
 * Write a new release.
 *
 * Refuses to overwrite: a release directory that already exists holds the
 * bytes its name is the hash of, and there is nothing a second write could
 * legitimately change.
 */
export function writeRelease(root: Layout, spec: AppSpec, files: ReleaseFiles): string {
  const app = root.app(spec.manifest.appId);
  const target = within(app, app.release(spec.manifest.releaseId));

  // The identity is checked before anything is written. A manifest whose
  // `releaseId` is not the hash of what is about to be stored beside it would
  // make every later verification meaningless.
  const recomputed = computeReleaseId({ page: files.page, host: files.host, contract: spec.contract });
  if (recomputed !== spec.manifest.releaseId) {
    throw publicError.invalidInput(
      `the manifest names release ${spec.manifest.releaseId}, but these files hash to ${recomputed}`,
    );
  }

  // The views and the contract are edited separately, and a release is the one
  // moment they have to be true together. A table reading a route that no
  // longer exists is a screen that fails the instant somebody opens it.
  const problems = checkViewsAgainstContract(spec.views, spec.contract);
  if (problems.length > 0) {
    throw publicError.invalidInput(
      `the interface does not match the contract: ${problems.join('; ')}`,
    );
  }

  if (existsSync(target)) {
    throw publicError.conflict(`release ${spec.manifest.releaseId} already exists`);
  }

  mkdirSync(app.releases, { recursive: true, mode: 0o700 });
  // A staging directory named after the release, so a crash leaves something
  // recognisable — and so a later attempt can clear it rather than guess.
  const staging = within(app, `${target}.incomplete`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });

  try {
    writeFileSync(join(staging, PAGE_FILE), files.page);
    writeFileSync(join(staging, HOST_FILE), files.host);
    writeFileSync(join(staging, SPEC_FILE), json(spec));

    // Read back what was actually written rather than trusting what was passed
    // in: a short write or a full disk is exactly the failure this catches, and
    // it is far cheaper to find now than at activation.
    const written = computeReleaseId({
      page: readFileSync(join(staging, PAGE_FILE)),
      host: readFileSync(join(staging, HOST_FILE)),
      contract: parseSpec(JSON.parse(readFileSync(join(staging, SPEC_FILE), 'utf8'))).contract,
    });
    if (written !== spec.manifest.releaseId) {
      throw publicError.unavailable(
        `release ${spec.manifest.releaseId} did not survive being written; the directory was discarded`,
      );
    }
    renameSync(staging, target);
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true });
    throw cause;
  }
  return target;
}

/** Read one release back, and check that it is the release it claims to be. */
export function readRelease(root: Layout, appId: string, releaseId: string): AppSpec {
  const app = root.app(appId);
  const directory = within(app, app.release(releaseId));
  let raw: string;
  try {
    raw = readFileSync(join(directory, SPEC_FILE), 'utf8');
  } catch {
    throw publicError.notFound(`release ${releaseId} of ${appId} is not there`);
  }
  const spec = parseSpec(JSON.parse(raw));
  // The directory name is the claim; the manifest is the statement. They have
  // to agree, or the release has been moved or renamed and is no longer the
  // thing an approval was given for.
  if (spec.manifest.releaseId !== releaseId) {
    throw publicError.conflict(
      `the release in ${releaseId} says it is ${spec.manifest.releaseId}`,
    );
  }
  if (spec.manifest.appId !== appId) {
    throw publicError.conflict(`the release in ${releaseId} belongs to ${spec.manifest.appId}`);
  }
  return spec;
}

/** Every complete release of one application, newest first. */
export function listReleases(root: Layout, appId: string): readonly ReleaseSummary[] {
  const app = root.app(appId);
  let names: string[];
  try {
    names = readdirSync(app.releases);
  } catch {
    return [];
  }
  const found: ReleaseSummary[] = [];
  for (const name of names) {
    // A staging directory is not a release. Neither is anything else that does
    // not parse, which includes a release half-copied in by hand.
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    try {
      const spec = readRelease(root, appId, name);
      found.push({ releaseId: name, createdAt: spec.manifest.createdAt });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt || (a.releaseId < b.releaseId ? -1 : 1));
}

/** Which release is active, or `null` when none has been activated. */
export function readCurrent(root: Layout, appId: string): string | null {
  const app = root.app(appId);
  let pointer: string;
  try {
    pointer = readFileSync(app.current, 'utf8').trim();
  } catch {
    return null;
  }
  return /^[0-9a-f]{32}$/.test(pointer) ? pointer : null;
}

/**
 * Point an application at a release.
 *
 * `renameSync` over an existing file replaces it atomically on POSIX. Windows
 * also replaces, through `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, but a
 * reader holding the file open can make it fail — one for prompt 09's platform
 * list rather than something to work around here.
 */
export function setCurrent(root: Layout, appId: string, releaseId: string): void {
  const app = root.app(appId);
  const directory = within(app, app.release(releaseId));
  if (!existsSync(join(directory, SPEC_FILE))) {
    throw publicError.notFound(`release ${releaseId} of ${appId} is not there`);
  }
  mkdirSync(app.dir, { recursive: true, mode: 0o700 });
  writeAtomic(within(app, app.current), `${releaseId}\n`);
}

export { writeAtomic };
