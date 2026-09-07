/**
 * What an application asked for, and what a person allowed.
 *
 * The comparison is the point. A person grants capabilities while looking at
 * one release; a later release may ask for more, and "more" is the only thing
 * that has to interrupt them again. So capabilities are compared by a
 * canonical key that ignores everything which is not part of what is being
 * allowed — the order paths were listed in, and the sentence explaining why.
 * A reworded reason is not a new permission, and re-asking for one would train
 * a person to click through the question that matters.
 */
import { mkdirSync, readFileSync } from 'node:fs';

import { publicError } from 'broapp/host';

import type { Layout } from './layout.ts';
import { writeAtomic } from './store.ts';
import type { Capability, CapabilityDiff, Grants } from './types.ts';
import { parseGrants } from './validate.ts';

/**
 * A capability as one comparable string.
 *
 * `reason` is deliberately absent: it is written for a person to read, not for
 * a machine to compare, and including it would make an editorial change look
 * like an escalation.
 */
export function capabilityKey(capability: Capability): string {
  switch (capability.kind) {
    case 'files': {
      const access = capability.access ?? 'read';
      const paths = [...(capability.paths ?? [])].sort().join(',');
      return `files:${access}:${paths}`;
    }
    case 'network':
      return `network:${[...(capability.hosts ?? [])].sort().join(',')}`;
    case 'spawn':
      return 'spawn';
  }
}

/** What is asked for that was not allowed, what was allowed and is no longer asked for, and the rest. */
export function diffCapabilities(
  requested: readonly Capability[],
  granted: readonly Capability[],
): CapabilityDiff {
  const grantedKeys = new Set(granted.map(capabilityKey));
  const requestedKeys = new Set(requested.map(capabilityKey));
  return {
    added: requested.filter((capability) => !grantedKeys.has(capabilityKey(capability))),
    removed: granted.filter((capability) => !requestedKeys.has(capabilityKey(capability))),
    unchanged: requested.filter((capability) => grantedKeys.has(capabilityKey(capability))),
  };
}

/**
 * True when nothing new is being asked for.
 *
 * A capability that was granted and is no longer requested does not need
 * anybody's attention: an application asking for less is not a decision a
 * person has to make.
 */
export function isGranted(diff: CapabilityDiff): boolean {
  return diff.added.length === 0;
}

/** What a person has allowed this application, or `null` when they have not been asked. */
export function readGrants(root: Layout, appId: string): Grants | null {
  const app = root.app(appId);
  let raw: string;
  try {
    raw = readFileSync(app.grants, 'utf8');
  } catch {
    return null;
  }
  return parseGrants(JSON.parse(raw));
}

/** Record what a person allowed. Written atomically, like every other pointer. */
export function writeGrants(root: Layout, appId: string, grants: Grants): void {
  if (grants.appId !== appId) {
    throw publicError.invalidInput(`these grants are for ${grants.appId}, not ${appId}`);
  }
  const app = root.app(appId);
  // Grants may be the first thing ever written for an application: a person can
  // be asked what to allow before there is a release to allow it for.
  mkdirSync(app.dir, { recursive: true, mode: 0o700 });
  writeAtomic(app.grants, `${JSON.stringify(grants, null, 2)}\n`);
}
