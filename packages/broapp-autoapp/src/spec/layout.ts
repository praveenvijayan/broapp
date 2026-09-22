/**
 * Where everything lives.
 *
 * One module owns every path Autoapp writes to, so that "is this inside the
 * directory it is supposed to be inside" is a question with one answer rather
 * than a convention each caller remembers. The application id is validated
 * here, at the point a path is derived from it, and not only where it was
 * first read — a path built from an unchecked id is the shape of every
 * directory-traversal bug there has ever been.
 */
import { ensureDataDir } from 'broapp/host';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { APP_ID_PATTERN } from './types.ts';

/**
 * Where an application's source workspace is, as its pointer says.
 *
 * `default` is `<dir>/source`, which every application created before 19a
 * has. `chosen` is a folder a person named. `unreadable` is a pointer that is
 * there and cannot be believed; `source` is then the default path, but only so
 * that the field is a string — nothing builds from it, because every reader of
 * the workspace goes through the guard in `launcher/location.ts`, which refuses
 * this state before anything is read.
 */
export type SourceLocation =
  | { readonly kind: 'default' }
  | { readonly kind: 'chosen'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The directories and files belonging to one application. */
export interface AppLayout {
  readonly dir: string;
  readonly releases: string;
  release(releaseId: string): string;
  /**
   * The source workspace: `<dir>/source`, unless `location.json` names another
   * directory. Read from the pointer when asked, never cached beyond this one
   * `layout.app()` call, so a pointer rewritten by `locate` is seen at once.
   */
  readonly source: string;
  readonly sourceLocation: SourceLocation;
  /** The pointer naming a workspace outside the launcher's directory (19a). */
  readonly location: string;
  readonly data: string;
  readonly dataNext: string;
  /**
   * A throwaway copy of `dataNext`, made after the migration, that activation
   * runs the acceptance examples on. Examples write; the copy that becomes live
   * must not be written before the switch, so they are given this one and it
   * is removed however the activation ends.
   */
  readonly dataCheck: string;
  dataPrev(timestamp: number): string;
  readonly snapshots: string;
  /** Data copies a preview child runs against, one per release being looked at. */
  preview(releaseId: string): string;
  /** Previous contents of files an engineer changed, when git is not available. */
  readonly sourceHistory: string;
  /** The pointer file naming the active release. */
  readonly current: string;
  readonly grants: string;
  /** What the engineer last built and previewed, kept so a restart resumes there. */
  readonly candidate: string;
}

/** The launcher's own directory, and every application under it. */
export interface Layout {
  readonly root: string;
  app(appId: string): AppLayout;
  readonly journal: string;
  readonly control: string;
  /**
   * The person's standing approval for the engineer's edits, builds and
   * previews, one switch for the whole launcher. Absent means off: turning it
   * off removes the file, so a launcher never touched and one turned back off
   * look the same on disk.
   */
  readonly standing: string;
  /**
   * Where a removed application's directory is renamed to.
   *
   * Removal moves, and the launcher never empties this: a person who removed
   * the wrong thing has every byte of it here, and nothing in the launcher
   * decides on their behalf that enough time has passed.
   */
  readonly trash: string;
}

/** The one version of `location.json` this launcher writes and reads. */
export const LOCATION_VERSION = 1;

/** Whether `inner` is `outer` or somewhere beneath it. */
export function isWithin(outer: string, inner: string): boolean {
  const between = relative(outer, inner);
  return between === '' || (!between.startsWith('..') && !isAbsolute(between));
}

/** The real path of something that may not exist, or the resolved path when it does not. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Read an application's pointer.
 *
 * Never throws: an application whose pointer is damaged must still be
 * listed, opened and removed, and every one of those starts with
 * `layout.app()`. What is wrong is returned as a reason for the sentence.
 */
function readLocation(root: string, file: string): SourceLocation {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    if ((cause as { code?: unknown }).code === 'ENOENT') return { kind: 'default' };
    return { kind: 'unreadable', reason: 'it could not be opened' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'it is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unreadable', reason: 'it is not an object' };
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== LOCATION_VERSION) {
    return { kind: 'unreadable', reason: `its version is not ${String(LOCATION_VERSION)}` };
  }
  const source = record['source'];
  if (typeof source !== 'string' || source === '' || !isAbsolute(source)) {
    return { kind: 'unreadable', reason: 'it does not name a full path' };
  }
  // A pointer back into the launcher's own directory is refused here as well
  // as at creation: a pointer can be edited by hand, and one naming another
  // application's directory would confine one engineer to another's files.
  if (isWithin(resolve(root), resolve(source)) || isWithin(realOrResolved(root), realOrResolved(source))) {
    return { kind: 'unreadable', reason: 'it names a folder inside the launcher’s own folder' };
  }
  return { kind: 'chosen', path: source };
}

/** A release identity, checked before it becomes a directory name. */
const RELEASE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Build the layout rooted at `root`. */
export function layout(root: string): Layout {
  return {
    root,
    journal: join(root, 'journal.sqlite'),
    control: join(root, 'launcher.json'),
    standing: join(root, 'standing.json'),
    trash: join(root, 'trash'),
    app(appId: string): AppLayout {
      // The pattern already forbids a separator and a dot, so this cannot fail
      // for a well-formed id. It is checked anyway, because every path below is
      // built by joining it and a caller that skipped its own validation should
      // find out here rather than three directories up.
      if (!APP_ID_PATTERN.test(appId)) {
        throw new TypeError(
          `application id ${JSON.stringify(appId)} must be 3 to 40 lowercase letters, digits or hyphens, starting with a letter`,
        );
      }
      const dir = join(root, 'apps', appId);
      const locationFile = join(dir, 'location.json');
      // Read on first use and kept for the life of this object only: most
      // callers of `layout.app()` want a release or the data directory and
      // should not pay for a file read, and none of them holds the object
      // long enough for a stale answer to matter.
      let read: SourceLocation | null = null;
      const where = (): SourceLocation => (read ??= readLocation(root, locationFile));
      return {
        dir,
        location: locationFile,
        get sourceLocation(): SourceLocation {
          return where();
        },
        get source(): string {
          const found = where();
          return found.kind === 'chosen' ? found.path : join(dir, 'source');
        },
        releases: join(dir, 'releases'),
        release(releaseId: string): string {
          if (!RELEASE_ID_PATTERN.test(releaseId)) {
            throw new TypeError(
              `release id ${JSON.stringify(releaseId)} must be 32 lowercase hex characters`,
            );
          }
          return join(dir, 'releases', releaseId);
        },
        data: join(dir, 'data'),
        dataNext: join(dir, 'data-next'),
        dataCheck: join(dir, 'data-check'),
        dataPrev: (timestamp: number) => join(dir, `data-prev-${String(timestamp)}`),
        snapshots: join(dir, 'snapshots'),
        preview(releaseId: string): string {
          if (!RELEASE_ID_PATTERN.test(releaseId)) {
            throw new TypeError(
              `release id ${JSON.stringify(releaseId)} must be 32 lowercase hex characters`,
            );
          }
          return join(dir, 'previews', releaseId);
        },
        sourceHistory: join(dir, 'source-history'),
        current: join(dir, 'current'),
        grants: join(dir, 'grants.json'),
        candidate: join(dir, 'candidate.json'),
      };
    },
  };
}

/**
 * The launcher's own data directory.
 *
 * `autoapp` is appended so that the launcher's applications sit beside, rather
 * than inside, whatever else a future version of the launcher keeps for itself.
 */
export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(ensureDataDir('broapp-autoapp', env), 'autoapp');
}
