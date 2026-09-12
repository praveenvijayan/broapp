/**
 * Removing an application.
 *
 * Removal moves. `<root>/apps/<appId>` is renamed into `<root>/trash/`, in one
 * `renameSync`, and that is the whole of it: nothing is copied, nothing is
 * walked, and there is no moment at which half an application exists. A
 * rename inside one data directory is atomic on every filesystem this runs on,
 * so the application is either where it was or where it went.
 *
 * The launcher never empties the trash. A person who removed the wrong thing
 * has every byte of it, and no code here decides on their behalf that enough
 * time has passed — `prune` is where that decision will be made, explicitly,
 * with a list and a `--yes`.
 *
 * Who may ask. A person: the route on channel `user`, and the `remove`
 * command. There is no engineer tool, and there is not going to be one: a
 * model asking to delete somebody's application is not a request this launcher
 * relays, and the gate's "ask first" is the wrong answer to it. A test asserts
 * that no such tool exists.
 *
 * What is not moved. The journal keeps its rows, so `journalList` still
 * answers for a removed application and a person can see what happened to it;
 * knowledge rows scoped to the id stay, because a lesson learnt from an
 * application is not about the directory it was learnt in.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { publicError } from 'broapp/host';
import type { HostLogger } from 'broapp/host';

import type { CandidateStates } from '../engineer/state.ts';
import type { EventLog } from '../knowledge/log.ts';
import type { Session } from '../knowledge/session.ts';
import { readCurrent, type Layout } from '../spec/index.ts';

import { serving } from './apps.ts';
import type { Journal } from './journal.ts';
import type { Supervisor } from './supervisor.ts';

/** What a removal moved, as the person who asked for it is told. */
export interface RemovalReceipt {
  readonly appId: string;
  /** Where it went, relative to the launcher's root. */
  readonly trashPath: string;
  readonly releases: number;
  readonly hadSource: boolean;
  readonly dataBytes: number;
  readonly snapshots: number;
  readonly dataPrev: number;
  /** A preview was running and was stopped so its directory could move. */
  readonly previewStopped: boolean;
}

/** What a removal would move: the receipt, before there is anywhere to say it went. */
export type RemovalDescription = Omit<RemovalReceipt, 'trashPath' | 'previewStopped'>;

/** How long a preview child gets to stop. */
const STOP_DEADLINE_MS = 10_000;

/** How many entries a directory has, or none when there is no directory. */
function count(directory: string): number {
  try {
    return readdirSync(directory).length;
  } catch {
    return 0;
  }
}

/**
 * Every byte under `directory`.
 *
 * Walked rather than asked of the filesystem, because there is no portable
 * "how big is this tree" and the number's whole job is to be in a sentence a
 * person reads before they agree to something. A directory that cannot be read
 * contributes nothing rather than failing the description: this runs before a
 * removal, and a removal must not be refused because one file was unreadable.
 */
function bytesUnder(directory: string): number {
  let total = 0;
  let entries: readonly { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += bytesUnder(path);
    else if (entry.isFile()) {
      try {
        total += statSync(path).size;
      } catch {
        // A file that vanished between the listing and the stat is a file that
        // is not going to be moved either.
      }
    }
  }
  return total;
}

/** What would move if this application were removed. */
export function describeRemoval(layout: Layout, appId: string): RemovalDescription {
  const app = layout.app(appId);
  if (!existsSync(app.dir)) {
    throw publicError.notFound(`There is no application called ${appId}.`);
  }
  return {
    appId,
    releases: count(app.releases),
    hadSource: existsSync(app.source),
    dataBytes: bytesUnder(app.data),
    snapshots: count(app.snapshots),
    dataPrev: readdirSync(app.dir).filter((entry) => entry.startsWith('data-prev-')).length,
  };
}

/**
 * A timestamp that is a legal directory name everywhere.
 *
 * An ISO instant carries colons, which Windows will not accept in a path, and
 * the launcher is built for Windows. The characters change; the ordering — the
 * only thing a person or a future `prune` reads out of this — does not.
 */
function stamp(at: number): string {
  return new Date(at).toISOString().replaceAll(':', '-');
}

/** What {@link removeApplication} needs. */
export interface RemoveDeps {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly states: CandidateStates;
  readonly journal: Journal;
  readonly session?: Session;
  readonly logger?: HostLogger;
  /** Where the removal is written down. Absent, nothing is. */
  readonly log?: EventLog;
}

/**
 * Move one application to the trash.
 *
 * Refuses while it is serving: a live child holds its data directory open, and
 * renaming the directory out from under a process that is writing to it is how
 * a person loses the data this is trying not to lose. Stopping it first is the
 * person's decision, not this function's.
 */
export async function removeApplication(deps: RemoveDeps, appId: string): Promise<RemovalReceipt> {
  const { layout: root, supervisor, states, journal } = deps;
  const app = root.app(appId);
  const described = describeRemoval(root, appId);

  if (serving(supervisor, appId) !== null) {
    throw publicError.unavailable(`${appId} is running. Stop it first, then remove it.`);
  }

  // A preview is the launcher's own child on a copy of the data, and the
  // person has already said to remove the application it belongs to. Stopped
  // rather than refused — and said in the receipt, because something they were
  // looking at has just closed.
  const preview = states.get(appId).preview;
  const previewStopped = preview !== null;
  if (preview !== null) {
    await preview.shutdown(STOP_DEADLINE_MS);
    states.update(appId, { preview: null, previewWasRunning: false });
  }

  const currentRelease = readCurrent(root, appId);
  const target = join(root.trash, `${appId}-${stamp(Date.now())}`);
  mkdirSync(root.trash, { recursive: true, mode: 0o700 });
  renameSync(app.dir, target);

  // Written after the move, not before: the journal's write-ahead discipline is
  // for a sequence that can be interrupted halfway, and this one cannot be.
  // What the row is for is answering "where did it go" afterwards.
  const activation = journal.begin({
    appId,
    fromRelease: currentRelease,
    // Not null, and there is no release being moved to. The id it was on when
    // it went is the honest answer; `none` when it never had one.
    toRelease: currentRelease ?? 'none',
  });
  journal.advance(activation, 'removed');

  // The launcher's memory of it goes too. A selection naming a directory that
  // is not there would send the engineer's next turn at nothing, and a
  // candidate state would resume a build for an application nobody has.
  if (deps.session?.get().selectedAppId === appId) deps.session.clear();
  states.drop(appId);

  const receipt: RemovalReceipt = {
    ...described,
    trashPath: relative(root.root, target),
    previewStopped,
  };
  deps.log?.event(
    'remove',
    `${appId} was moved to the trash`,
    {
      trashPath: receipt.trashPath,
      releases: receipt.releases,
      hadSource: receipt.hadSource,
      dataBytes: receipt.dataBytes,
      snapshots: receipt.snapshots,
      dataPrev: receipt.dataPrev,
      previewStopped: receipt.previewStopped,
    },
    { appId, ...(currentRelease === null ? {} : { releaseId: currentRelease }) },
  );
  deps.logger?.warn(`[autoapp] ${appId} was moved to ${receipt.trashPath}`);
  return receipt;
}

/** What a removal moved, as one line for a terminal. */
export function describeReceipt(receipt: RemovalDescription): string {
  return [
    `${String(receipt.releases)} release${receipt.releases === 1 ? '' : 's'}`,
    receipt.hadSource ? 'a source workspace' : 'no source workspace',
    `${String(receipt.dataBytes)} bytes of data`,
    `${String(receipt.snapshots)} snapshot${receipt.snapshots === 1 ? '' : 's'}`,
    `${String(receipt.dataPrev)} previous data director${receipt.dataPrev === 1 ? 'y' : 'ies'}`,
  ].join(', ');
}
