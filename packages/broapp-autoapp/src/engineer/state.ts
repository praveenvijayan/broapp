/**
 * What the engineer has built and previewed, per application.
 *
 * In memory, on purpose: a candidate that is being looked at is a thing that
 * exists while the launcher is running and a preview child is alive. The
 * durable parts — the release itself, the journal, the grants — are already on
 * disk, and this is the volatile remainder.
 *
 * The preview's URL lives here and is never handed to a model. The tab gets it
 * through a route the *person* calls; the engineer's tools are told whether a
 * preview is running and nothing more.
 */
import type { BuildProblem } from '../launcher/candidate.ts';
import type { ChildHandle } from '../launcher/supervisor.ts';
import type { Capability, CapabilityDiff } from '../spec/types.ts';

/** One acceptance example's result. */
export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** What the engineer has done for one application, so far. */
export interface CandidateState {
  readonly appId: string;
  /** The last build's release, when it succeeded. */
  readonly releaseId: string | null;
  readonly problems: readonly BuildProblem[];
  /** The files the last applied change touched. */
  readonly changed: readonly string[];
  /** Present while a preview child is alive. Its URL is never given to a model. */
  readonly preview: ChildHandle | null;
  readonly checks: readonly CheckResult[];
  readonly capabilityDiff: CapabilityDiff | null;
}

/** What a tab is told. Deliberately without the preview's URL. */
export interface CandidateStatus {
  readonly appId: string;
  readonly releaseId: string | null;
  readonly problems: readonly BuildProblem[];
  readonly changed: readonly string[];
  readonly previewRunning: boolean;
  readonly checks: readonly CheckResult[];
  readonly addedCapabilities: readonly Capability[];
  readonly removedCapabilities: readonly Capability[];
}

/** The candidate states, one per application. */
export interface CandidateStates {
  get(appId: string): CandidateState;
  update(appId: string, patch: Partial<Omit<CandidateState, 'appId'>>): CandidateState;
  status(appId: string): CandidateStatus;
  /** Every application with a preview child alive. */
  readonly previews: readonly CandidateState[];
}

/** Nothing built yet. */
function empty(appId: string): CandidateState {
  return {
    appId,
    releaseId: null,
    problems: [],
    changed: [],
    preview: null,
    checks: [],
    capabilityDiff: null,
  };
}

/** Build the per-application candidate state. */
export function createCandidateStates(): CandidateStates {
  const states = new Map<string, CandidateState>();

  return {
    get(appId) {
      return states.get(appId) ?? empty(appId);
    },

    update(appId, patch) {
      const next: CandidateState = { ...(states.get(appId) ?? empty(appId)), ...patch };
      states.set(appId, next);
      return next;
    },

    status(appId) {
      const state = states.get(appId) ?? empty(appId);
      return {
        appId,
        releaseId: state.releaseId,
        problems: state.problems,
        changed: state.changed,
        // Whether, not where. The URL is a credential.
        previewRunning: state.preview !== null,
        checks: state.checks,
        addedCapabilities: state.capabilityDiff?.added ?? [],
        removedCapabilities: state.capabilityDiff?.removed ?? [],
      };
    },

    get previews() {
      return [...states.values()].filter((state) => state.preview !== null);
    },
  };
}
