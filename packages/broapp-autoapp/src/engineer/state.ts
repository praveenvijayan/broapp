/**
 * What the engineer has built and previewed, per application.
 *
 * Durable, except for the one part that cannot be. What was built, from which
 * source revision, what it found, what the checks said and whether a preview
 * was running are all written to `<root>/apps/<appId>/candidate.json` on every
 * change, so a person who closes the launcher comes back to the candidate they
 * left rather than to an empty panel. The preview child itself is a process,
 * and a process does not survive a restart; what survives is the fact that
 * there was one, which is how the tab knows to offer to start it again.
 *
 * Two things are derived when asked rather than stored, because storing them
 * would be storing a guess: whether the workspace has moved on since the build
 * (its `git HEAD` against the revision the build was from), and whether the
 * checks on record belong to the preview that is running now.
 *
 * The preview's URL lives here and is never handed to a model. The tab gets it
 * through a route the *person* calls; the engineer's tools are told whether a
 * preview is running and nothing more.
 */
import { existsSync, readFileSync } from 'node:fs';

import type { HostLogger } from 'broapp/host';

import { sourceRevision } from '../knowledge/ids.ts';
import { BUILD_STAGES, type BuildProblem } from '../launcher/candidate.ts';
import type { ChildHandle } from '../launcher/supervisor.ts';
import type { Layout } from '../spec/layout.ts';
import { writeAtomic } from '../spec/store.ts';
import type { Capability, CapabilityDiff } from '../spec/types.ts';

/** One acceptance example's result. */
export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** The last checks, and exactly what they were run against. */
export interface StoredChecks {
  readonly releaseId: string;
  /** The preview they ran on; see {@link previewIdOf}. */
  readonly previewId: string;
  /** Each example by id and content hash, so an edited example is not mistaken for the one that passed. */
  readonly examples: readonly { readonly id: string; readonly hash: string }[];
  readonly results: readonly CheckResult[];
  readonly at: number;
}

/**
 * How many change cycles in one turn may end with the same failure.
 *
 * At this many the cycle says to stop and ask the person; one more in the same
 * turn is refused. A new turn — the person has said something — starts again.
 */
export const MAX_REPAIR_ATTEMPTS = 3;

/** The steps a change cycle can have reached. */
export const CYCLE_STEPS = ['patched', 'build-declined', 'build-failed', 'built', 'preview-declined', 'previewed', 'checked'] as const;

/**
 * Where the last change cycle got to, written at every step.
 *
 * So a turn that was interrupted — the launcher stopped, the model's turn ran
 * out — can be picked up where it stopped by the next one, which reads this in
 * its orientation, and so a failure that keeps coming back is noticed.
 */
export interface CycleProgress {
  readonly step: (typeof CYCLE_STEPS)[number];
  /** The workspace revision at that step. */
  readonly rev: string;
  readonly releaseId: string | null;
  /** What was still wrong: each build problem or failed example, by signature. */
  readonly failures: readonly { readonly signature: string; readonly summary: string }[];
  /** Cycles in a row, in this turn, that ended with these same failures. */
  readonly attempts: number;
  /** The turn the cycle ran in. */
  readonly runId: string;
  readonly next: string;
  readonly at: number;
}

/** The part of a candidate that survives a restart. */
export interface StoredCandidate {
  /** The last build's release, when it succeeded. */
  readonly releaseId: string | null;
  /** The source revision the last build was made from. */
  readonly builtFromRev: string | null;
  readonly builtAt: number | null;
  readonly problems: readonly BuildProblem[];
  readonly stagesRun: readonly BuildProblem['stage'][];
  readonly checks: StoredChecks | null;
  /** True from a preview starting until it is stopped on purpose. */
  readonly previewWasRunning: boolean;
  /** The files the last applied change touched. */
  readonly changed: readonly string[];
  readonly capabilityDiff: CapabilityDiff | null;
  /** The last change cycle's progress, or `null` when none has run. */
  readonly cycle: CycleProgress | null;
}

/** What the engineer has done for one application, so far. */
export interface CandidateState extends StoredCandidate {
  readonly appId: string;
  /** Present while a preview child is alive. Its URL is never given to a model. */
  readonly preview: ChildHandle | null;
  /** Derived at read time: `git HEAD` of the source workspace differs from `builtFromRev`. */
  readonly editsSinceBuild: boolean;
  /** Derived at read time: a preview was running and no child is alive for it now. */
  readonly previewLost: boolean;
}

/** What an update may change. The derived fields are not among them. */
export type CandidatePatch = Partial<Omit<CandidateState, 'appId' | 'editsSinceBuild' | 'previewLost'>>;

/** What a tab is told. Deliberately without the preview's URL. */
export interface CandidateStatus {
  readonly appId: string;
  readonly releaseId: string | null;
  readonly problems: readonly BuildProblem[];
  readonly changed: readonly string[];
  readonly previewRunning: boolean;
  /** The last checks' results, verified or not; see `checksVerified`. */
  readonly checks: readonly CheckResult[];
  readonly addedCapabilities: readonly Capability[];
  readonly removedCapabilities: readonly Capability[];
  readonly editsSinceBuild: boolean;
  readonly previewLost: boolean;
  /** The checks ran against this release, on the preview that is running now. */
  readonly checksVerified: boolean;
  readonly stagesRun: readonly BuildProblem['stage'][];
}

/** The candidate states, one per application. */
export interface CandidateStates {
  get(appId: string): CandidateState;
  update(appId: string, patch: CandidatePatch): CandidateState;
  status(appId: string): CandidateStatus;
  /**
   * Count one edit since the last build; returns the new count.
   *
   * In memory, for this launcher process only. It is advice for the turn —
   * "you have changed three things and verified none" — not a fact about the
   * workspace, which `editsSinceBuild` answers from git.
   */
  noteEdit(appId: string): number;
  /** A build ran: the edits before it are verified, or at least tried. */
  resetEdits(appId: string): void;
  /** Every application with a preview child alive. */
  readonly previews: readonly CandidateState[];
}

/**
 * Which spawn of a preview this is: its release and when it was spawned.
 *
 * A check result is only evidence about the child it ran on. A restart, a new
 * build or a second preview of the same release is a different child, and the
 * checks on record say nothing about it until they are run again.
 */
export function previewIdOf(child: ChildHandle): string {
  return `${child.releaseId}:${String(child.spawnedAt)}`;
}

/** Nothing built yet. */
const EMPTY: StoredCandidate = {
  releaseId: null,
  builtFromRev: null,
  builtAt: null,
  problems: [],
  stagesRun: [],
  checks: null,
  previewWasRunning: false,
  changed: [],
  capabilityDiff: null,
  cycle: null,
};

/** How long a workspace revision is trusted before `git` is asked again. */
const REVISION_TTL_MS = 1_000;

/** One application's entry: what is on disk, and the process that is not. */
interface Entry {
  readonly stored: StoredCandidate;
  readonly preview: ChildHandle | null;
}

/**
 * Build the per-application candidate state.
 *
 * Without a layout nothing is read or written and a restart forgets
 * everything, which is what a test that builds tools by hand wants.
 */
export function createCandidateStates(layout?: Layout, logger: HostLogger = console): CandidateStates {
  const entries = new Map<string, Entry>();
  const revisions = new Map<string, { at: number; rev: string }>();
  const unverified = new Map<string, number>();

  /** The file for an application, or `null` when there is nowhere to keep it. */
  function fileOf(appId: string): { path: string; dir: string } | null {
    if (layout === undefined) return null;
    try {
      const app = layout.app(appId);
      return { path: app.candidate, dir: app.dir };
    } catch {
      // Not an application id at all. A tool refuses it elsewhere; here it
      // simply has nothing on disk.
      return null;
    }
  }

  /** Read what was written, lazily, once. A file that cannot be read is logged and left alone. */
  function load(appId: string): StoredCandidate {
    const file = fileOf(appId);
    if (file === null || !existsSync(file.path)) return EMPTY;
    try {
      return parseStored(JSON.parse(readFileSync(file.path, 'utf8')));
    } catch (cause) {
      // Never deleted: somebody may want to read what was in it, and the next
      // update replaces it with something readable anyway.
      logger.warn(
        `[autoapp] ${appId}'s candidate.json could not be read, so its candidate starts empty: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
      return EMPTY;
    }
  }

  function persist(appId: string, stored: StoredCandidate): void {
    const file = fileOf(appId);
    // Only beside an application that exists. A tool asked about an id nobody
    // has would otherwise make a directory that then lists as an application.
    if (file === null || !existsSync(file.dir)) return;
    try {
      writeAtomic(file.path, `${JSON.stringify(stored, null, 2)}\n`);
    } catch (cause) {
      logger.error(
        `[autoapp] ${appId}'s candidate could not be saved; a restart will not resume it: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    }
  }

  function entryOf(appId: string): Entry {
    const known = entries.get(appId);
    if (known !== undefined) return known;
    const loaded: Entry = { stored: load(appId), preview: null };
    entries.set(appId, loaded);
    return loaded;
  }

  /** The workspace's revision now, at most one `git` call a second per application. */
  function revisionOf(appId: string): string | null {
    if (layout === undefined) return null;
    const cached = revisions.get(appId);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < REVISION_TTL_MS) return cached.rev;
    let rev: string;
    try {
      rev = sourceRevision(layout.app(appId).source);
    } catch {
      return null;
    }
    revisions.set(appId, { at: now, rev });
    return rev;
  }

  function view(appId: string, entry: Entry): CandidateState {
    const { stored, preview } = entry;
    const built = stored.builtFromRev;
    const now = built === null ? null : revisionOf(appId);
    return {
      ...stored,
      appId,
      preview,
      editsSinceBuild: built !== null && now !== null && now !== built,
      previewLost: stored.previewWasRunning && preview === null,
    };
  }

  return {
    get(appId) {
      return view(appId, entryOf(appId));
    },

    update(appId, patch) {
      const entry = entryOf(appId);
      const { preview, ...rest } = patch;
      const stored: StoredCandidate = { ...entry.stored, ...rest };
      const next: Entry = { stored, preview: preview === undefined ? entry.preview : preview };
      entries.set(appId, next);
      if (Object.keys(rest).length > 0) persist(appId, stored);
      return view(appId, next);
    },

    status(appId) {
      const state = view(appId, entryOf(appId));
      const checks = state.checks;
      return {
        appId,
        releaseId: state.releaseId,
        problems: state.problems,
        changed: state.changed,
        // Whether, not where. The URL is a credential.
        previewRunning: state.preview !== null,
        checks: checks?.results ?? [],
        addedCapabilities: state.capabilityDiff?.added ?? [],
        removedCapabilities: state.capabilityDiff?.removed ?? [],
        editsSinceBuild: state.editsSinceBuild,
        previewLost: state.previewLost,
        checksVerified:
          checks !== null &&
          checks.releaseId === state.releaseId &&
          state.preview !== null &&
          previewIdOf(state.preview) === checks.previewId,
        stagesRun: state.stagesRun,
      };
    },

    noteEdit(appId) {
      const count = (unverified.get(appId) ?? 0) + 1;
      unverified.set(appId, count);
      return count;
    },

    resetEdits(appId) {
      unverified.delete(appId);
    },

    get previews() {
      return [...entries.entries()]
        .filter(([, entry]) => entry.preview !== null)
        .map(([appId, entry]) => view(appId, entry));
    },
  };
}

/** A problem, as it was written. */
function isProblem(value: unknown): value is BuildProblem {
  if (typeof value !== 'object' || value === null) return false;
  const { stage, message } = value as { stage?: unknown; message?: unknown };
  return (BUILD_STAGES as readonly unknown[]).includes(stage) && typeof message === 'string';
}

function isCheckResult(value: unknown): value is CheckResult {
  if (typeof value !== 'object' || value === null) return false;
  const { id, title, passed, detail } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof title === 'string' &&
    typeof passed === 'boolean' &&
    (detail === undefined || typeof detail === 'string')
  );
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} is not text`);
  return value;
}

/**
 * A stored candidate, checked field by field.
 *
 * The file is the launcher's own, but a person can edit anything on their
 * disk, and a candidate that resumed with a problem list that is not a list
 * would take the panel down with it. A field that is missing takes its empty
 * value, so a file written by an earlier version still reads.
 */
function parseStored(raw: unknown): StoredCandidate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('the file is not an object');
  }
  const value = raw as Record<string, unknown>;
  const list = <T>(field: string, check: (item: unknown) => item is T): T[] => {
    const items = value[field];
    if (items === undefined) return [];
    if (!Array.isArray(items) || !items.every(check)) throw new TypeError(`${field} is not a valid list`);
    return items;
  };

  let checks: StoredChecks | null = null;
  const rawChecks = value['checks'];
  if (rawChecks !== null && rawChecks !== undefined) {
    const c = rawChecks as Record<string, unknown>;
    const examples = c['examples'];
    const results = c['results'];
    if (
      typeof c['releaseId'] !== 'string' ||
      typeof c['previewId'] !== 'string' ||
      typeof c['at'] !== 'number' ||
      !Array.isArray(examples) ||
      !examples.every(
        (item: unknown) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { id?: unknown }).id === 'string' &&
          typeof (item as { hash?: unknown }).hash === 'string',
      ) ||
      !Array.isArray(results) ||
      !results.every(isCheckResult)
    ) {
      throw new TypeError('checks is not valid');
    }
    checks = {
      releaseId: c['releaseId'],
      previewId: c['previewId'],
      at: c['at'],
      examples: examples as { id: string; hash: string }[],
      results,
    };
  }

  const diff = value['capabilityDiff'];
  const capabilityDiff =
    typeof diff === 'object' &&
    diff !== null &&
    Array.isArray((diff as { added?: unknown }).added) &&
    Array.isArray((diff as { removed?: unknown }).removed)
      ? (diff as CapabilityDiff)
      : null;
  const builtAt = value['builtAt'];

  return {
    releaseId: stringOrNull(value['releaseId'], 'releaseId'),
    builtFromRev: stringOrNull(value['builtFromRev'], 'builtFromRev'),
    builtAt: typeof builtAt === 'number' ? builtAt : null,
    problems: list('problems', isProblem),
    stagesRun: list('stagesRun', (item: unknown): item is BuildProblem['stage'] =>
      (BUILD_STAGES as readonly unknown[]).includes(item),
    ),
    checks,
    previewWasRunning: value['previewWasRunning'] === true,
    changed: list('changed', (item: unknown): item is string => typeof item === 'string'),
    capabilityDiff,
    cycle: parseCycle(value['cycle']),
  };
}

/**
 * The last cycle's progress, or `null` when there is none or it will not read.
 *
 * Unlike the fields above, a progress record that will not read is dropped
 * rather than refusing the whole file: it is advice for the next turn, and the
 * candidate it sits beside is worth more than it is.
 */
function parseCycle(raw: unknown): CycleProgress | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const failures = value['failures'];
  const releaseId = value['releaseId'];
  if (
    !(CYCLE_STEPS as readonly unknown[]).includes(value['step']) ||
    typeof value['rev'] !== 'string' ||
    (releaseId !== null && typeof releaseId !== 'string') ||
    !Array.isArray(failures) ||
    !failures.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { signature?: unknown }).signature === 'string' &&
        typeof (item as { summary?: unknown }).summary === 'string',
    ) ||
    typeof value['attempts'] !== 'number' ||
    typeof value['runId'] !== 'string' ||
    typeof value['next'] !== 'string' ||
    typeof value['at'] !== 'number'
  ) {
    return null;
  }
  return {
    step: value['step'] as CycleProgress['step'],
    rev: value['rev'],
    releaseId,
    failures: failures as CycleProgress['failures'],
    attempts: value['attempts'],
    runId: value['runId'],
    next: value['next'],
    at: value['at'],
  };
}
