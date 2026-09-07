/**
 * What makes one release that release and not another.
 *
 * A release identity has to be a function of the release's contents and of
 * nothing else — not a counter, not a timestamp, not a name somebody chose.
 * Two things depend on that. An approval names the release it was given for,
 * so a rebuild has to produce a different identity or an old approval would
 * authorise new code. And a release directory is immutable, so its name has to
 * be enough to say whether what is inside it is what was put there.
 *
 * Three things go into it: the page bytes, the host bundle bytes, and the
 * whole specification. Until prompt 08b the third was only the exported
 * contract, which meant a change to views, migrations, acceptance examples or
 * capabilities hashed to the release it came from — and `activate` runs the
 * acceptance examples as its check, so a person could add a check that could
 * never reach a release. Everything a release contains is now in its name.
 *
 * The specification is hashed as canonical JSON — keys sorted at every depth —
 * because the order a builder happened to write the object in is not part of
 * what the release does.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from 'broapp/host';

import type { AppSpec } from './types.ts';

/** What a release is made of. */
export interface ReleaseParts {
  readonly page: Uint8Array;
  readonly host: Uint8Array;
  readonly spec: AppSpec;
}

/** How many characters of the digest a release is named by. */
const ID_LENGTH = 32;

/**
 * The separator between the three parts.
 *
 * Without it, a page ending in bytes that a host bundle begins with would hash
 * the same as the pair with the boundary moved, and two different releases
 * would share an identity.
 */
const SEPARATOR = new Uint8Array([0]);

/**
 * The specification without the two fields that are about the build rather
 * than about what was built.
 *
 * `releaseId` cannot be an input to its own digest, and `createdAt` is when the
 * build ran — two builds of identical sources differ by it and by nothing that
 * matters. Both are deleted rather than blanked, so a specification that never
 * had them hashes the same as one that had them removed.
 */
export function stripIdentity(spec: AppSpec): unknown {
  const manifest: Record<string, unknown> = { ...spec.manifest };
  delete manifest['releaseId'];
  delete manifest['createdAt'];
  return { ...spec, manifest };
}

/** The identity of a release built from these parts. */
export function releaseId(parts: ReleaseParts): string {
  const digest = createHash('sha256');
  digest.update(parts.page);
  digest.update(SEPARATOR);
  digest.update(parts.host);
  digest.update(SEPARATOR);
  digest.update(canonicalJson(stripIdentity(parts.spec)), 'utf8');
  return digest.digest('hex').slice(0, ID_LENGTH);
}

export { canonicalJson };
