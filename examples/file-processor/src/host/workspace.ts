/**
 * The authorized root, and the one function that decides what is inside it.
 *
 * Path containment is where this kind of application usually goes wrong, so it
 * is one small function with one rule, used by every filesystem operation here.
 * There is no second way to turn a browser-supplied name into a path.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { publicError } from 'broapp/host';

/** The directory this application is allowed to touch. */
export interface Workspace {
  /** The resolved, symlink-free root. */
  readonly root: string;
  /** True when the operator passed --root. */
  readonly explicit: boolean;
  /** Subdirectory of the root that reports are written into. */
  readonly outputDirName: string;
}

/**
 * Resolve a browser-supplied name against the root.
 *
 * The check is done on the **resolved** path, not on the input string. Testing
 * the input for `".."` looks like the same thing and is not: it misses an
 * absolute path, it misses an encoded separator, and it misses a symlink whose
 * target is elsewhere. Resolving first and asking "is the result under the
 * root?" catches all three, because by then there is only one answer to check.
 *
 * `existing` controls whether symlinks are followed before the check. For a
 * file being read it must be `true` — otherwise a symlink inside the root
 * pointing at `/etc/passwd` would pass. For a file about to be created the
 * target does not exist yet, so the resolved parent is what gets checked.
 */
export async function resolveInside(
  workspace: Workspace,
  name: string,
  options: { readonly existing: boolean },
): Promise<string> {
  if (name === '' || name.includes('\0')) {
    throw publicError.invalidInput('That is not a usable file name.');
  }
  if (isAbsolute(name)) {
    throw publicError.rejected('Give a name relative to the folder this application may read.');
  }

  const candidate = resolve(workspace.root, name);

  // Follow symlinks before deciding. A link inside the root may point anywhere.
  let actual = candidate;
  if (options.existing) {
    try {
      actual = await realpath(candidate);
    } catch {
      throw publicError.notFound('That file is not in the folder this application may read.');
    }
  } else {
    try {
      // The file does not exist yet; its parent must still be inside.
      const parent = await realpath(resolve(candidate, '..'));
      actual = join(parent, candidate.slice(candidate.lastIndexOf(sep) + 1));
    } catch {
      throw publicError.notFound('That destination folder does not exist.');
    }
  }

  const inside = relative(workspace.root, actual);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    // Deliberately vague: the caller learns that it was refused, not where the
    // boundary is or what else exists on the disk.
    throw publicError.rejected('That file is outside the folder this application may read.');
  }
  return actual;
}
