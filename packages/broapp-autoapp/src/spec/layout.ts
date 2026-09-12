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
import { join } from 'node:path';

import { APP_ID_PATTERN } from './types.ts';

/** The directories and files belonging to one application. */
export interface AppLayout {
  readonly dir: string;
  readonly releases: string;
  release(releaseId: string): string;
  readonly source: string;
  readonly data: string;
  readonly dataNext: string;
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
   * Where a removed application's directory is renamed to.
   *
   * Removal moves, and the launcher never empties this: a person who removed
   * the wrong thing has every byte of it here, and nothing in the launcher
   * decides on their behalf that enough time has passed.
   */
  readonly trash: string;
}

/** A release identity, checked before it becomes a directory name. */
const RELEASE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Build the layout rooted at `root`. */
export function layout(root: string): Layout {
  return {
    root,
    journal: join(root, 'journal.sqlite'),
    control: join(root, 'launcher.json'),
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
      return {
        dir,
        releases: join(dir, 'releases'),
        release(releaseId: string): string {
          if (!RELEASE_ID_PATTERN.test(releaseId)) {
            throw new TypeError(
              `release id ${JSON.stringify(releaseId)} must be 32 lowercase hex characters`,
            );
          }
          return join(dir, 'releases', releaseId);
        },
        source: join(dir, 'source'),
        data: join(dir, 'data'),
        dataNext: join(dir, 'data-next'),
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
