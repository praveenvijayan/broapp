/**
 * Which application the person is looking at.
 *
 * A turn's orientation and evidence are about one application, and a message
 * rarely names it: "add a tag column" means the one whose row is selected, or
 * the one the engineer was just working on. So every tool that takes an
 * application id, and the tab's own row click, write the choice here, and the
 * next turn starts from it. A small JSON file rather than a table, because it
 * is one value and a person may want to read or delete it.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HostLogger } from 'broapp/host';

import { writeAtomic } from '../spec/store.ts';
import { APP_ID_PATTERN } from '../spec/types.ts';

/** The file, inside the launcher's own data directory. */
export const SESSION_FILE = 'session.json';

/** The launcher's memory of what the person last chose. */
export interface Session {
  get(): { selectedAppId: string | null };
  select(appId: string): void;
  /**
   * Forget the choice.
   *
   * What a removal calls when the application that went was the selected one.
   * The file is rewritten rather than deleted: its absence and a `null` in it
   * mean the same thing, and rewriting is one code path instead of two.
   */
  clear(): void;
}

/** Open the session file in `dataDir`, creating nothing until something is chosen. */
export function openSession(dataDir: string, logger: HostLogger = console): Session {
  const path = join(dataDir, SESSION_FILE);
  let selected: string | null | undefined;

  function load(): string | null {
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { selectedAppId?: unknown };
      const id = raw.selectedAppId;
      // An id that is not an id is no choice at all; it is never used to build a path.
      return typeof id === 'string' && APP_ID_PATTERN.test(id) ? id : null;
    } catch (cause) {
      logger.warn(
        `[autoapp] ${SESSION_FILE} could not be read, so no application is selected: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
      return null;
    }
  }

  /** Write the choice down. A failure is reported and the choice still stands. */
  function save(appId: string | null): void {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeAtomic(path, `${JSON.stringify({ selectedAppId: appId }, null, 2)}\n`);
    } catch (cause) {
      // Remembered for this process anyway: a choice that cannot be saved is
      // still the person's choice until the launcher stops.
      logger.error(
        `[autoapp] the selected application could not be saved: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    }
  }

  return {
    get() {
      if (selected === undefined) selected = load();
      return { selectedAppId: selected };
    },
    select(appId) {
      if (!APP_ID_PATTERN.test(appId)) return;
      if (selected === appId) return;
      selected = appId;
      save(appId);
    },

    clear() {
      if (selected === null) return;
      selected = null;
      save(null);
    },
  };
}
