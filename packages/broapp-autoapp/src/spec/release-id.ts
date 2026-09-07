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
 * exported contract. The contract is hashed as canonical JSON — keys sorted at
 * every depth — because the order a builder happened to write the object in is
 * not part of what the release does.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from 'broapp/host';

import type { ContractExport } from './types.ts';

/** What a release is made of. */
export interface ReleaseParts {
  readonly page: Uint8Array;
  readonly host: Uint8Array;
  readonly contract: ContractExport;
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

/** The identity of a release built from these parts. */
export function releaseId(parts: ReleaseParts): string {
  const digest = createHash('sha256');
  digest.update(parts.page);
  digest.update(SEPARATOR);
  digest.update(parts.host);
  digest.update(SEPARATOR);
  digest.update(canonicalJson(parts.contract), 'utf8');
  return digest.digest('hex').slice(0, ID_LENGTH);
}

export { canonicalJson };
