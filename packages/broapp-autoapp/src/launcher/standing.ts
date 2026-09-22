/**
 * The person's standing approval, on disk.
 *
 * `<root>/standing.json`, beside the journal and the control file:
 * `{ "version": 1, "standing": true, "since": <ms> }`. One switch for the whole
 * launcher, nothing per application.
 *
 * Read at every question and never cached. The switch flipped in Settings or
 * at the command line answers the next question, and nothing in memory can
 * disagree with the disk. Anything but a version-1 file saying `true` is off:
 * a stand-in that answers for the person must never do so on a guess, and a
 * file nobody can read is not a person saying yes.
 *
 * Turning it off removes the file rather than writing `false`, so a launcher
 * that was never touched and one that was turned back off look the same.
 */
import { readFileSync, rmSync } from 'node:fs';

import type { HostLogger } from 'broapp/host';

import type { Layout } from '../spec/layout.ts';
import { writeAtomic } from '../spec/store.ts';

/** The one version of `standing.json` this launcher writes and reads. */
export const STANDING_VERSION = 1;

/** Whether the switch is on, and since when. */
export interface Standing {
  readonly standing: boolean;
  /** When it was turned on; `null` while it is off. */
  readonly since: number | null;
}

export const STANDING_OFF: Standing = { standing: false, since: null };

/**
 * Read the switch.
 *
 * Absent is off and says nothing. Unreadable, not JSON, another version, or
 * `standing` not `true` is off with one warning per read, so a person who
 * edited the file by hand finds out why the engineer is still asking.
 */
export function readStanding(layout: Layout, logger?: Pick<HostLogger, 'warn'>): Standing {
  let text: string;
  try {
    text = readFileSync(layout.standing, 'utf8');
  } catch (cause) {
    if ((cause as { code?: unknown }).code === 'ENOENT') return STANDING_OFF;
    logger?.warn(`[autoapp] ${layout.standing} could not be read, so the engineer asks as usual`);
    return STANDING_OFF;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger?.warn(`[autoapp] ${layout.standing} is not JSON, so the engineer asks as usual`);
    return STANDING_OFF;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger?.warn(`[autoapp] ${layout.standing} is not an object, so the engineer asks as usual`);
    return STANDING_OFF;
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== STANDING_VERSION) {
    logger?.warn(`[autoapp] ${layout.standing} is not version ${String(STANDING_VERSION)}, so the engineer asks as usual`);
    return STANDING_OFF;
  }
  if (record['standing'] !== true) {
    logger?.warn(`[autoapp] ${layout.standing} does not say "standing": true, so the engineer asks as usual`);
    return STANDING_OFF;
  }
  const since = record['since'];
  return { standing: true, since: typeof since === 'number' && Number.isFinite(since) ? since : null };
}

/**
 * Turn the switch on.
 *
 * Already on, the file is left as it is, so "on since" keeps meaning when the
 * person first turned it on rather than when somebody last pressed a button.
 */
export function writeStanding(layout: Layout, now: number = Date.now()): Standing {
  const current = readStanding(layout);
  if (current.standing && current.since !== null) return current;
  const file = { version: STANDING_VERSION, standing: true, since: now };
  writeAtomic(layout.standing, `${JSON.stringify(file, null, 2)}\n`);
  return { standing: true, since: now };
}

/** Turn the switch off: the file goes, whatever was in it. */
export function clearStanding(layout: Layout): Standing {
  rmSync(layout.standing, { force: true });
  return STANDING_OFF;
}
