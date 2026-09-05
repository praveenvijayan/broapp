/**
 * Input validation for the generator.
 *
 * Everything here refuses rather than repairs. A generator that silently
 * "fixes" a name produces a project whose package name does not match what the
 * developer typed, and a generator that silently accepts a traversing path
 * writes files somewhere nobody asked for.
 */
import { isAbsolute, resolve, relative } from 'node:path';

/** The outcome of a check. */
export type Check = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const ok: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });

/**
 * npm's rules for an unscoped package name, plus the ones that matter here.
 *
 * The name becomes the `package.json` name, the executable's base name, and
 * the data directory's name, so it has to be safe as a filename on every
 * platform as well as legal on npm.
 */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** Windows refuses these as filenames regardless of extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Is `name` usable as this application's package name and executable name? */
export function checkAppName(name: string): Check {
  if (name === '') return no('the name is empty');
  if (name.length > 128) return no('the name is longer than 128 characters');
  if (name !== name.toLowerCase()) return no('the name must be lower case');
  if (!NAME_PATTERN.test(name)) {
    return no(
      'the name may contain only lower-case letters, digits, hyphens, underscores and dots, and must start and end with a letter or digit',
    );
  }
  if (RESERVED.has(name)) return no(`"${name}" is a reserved device name on Windows`);
  if (name.startsWith('.') || name.startsWith('_')) return no('the name may not start with "." or "_"');
  if (name === 'node_modules' || name === 'favicon.ico') return no(`"${name}" is not allowed by npm`);
  return ok;
}

/**
 * Is `target` a safe destination?
 *
 * The rule is that the resolved destination must stay inside the directory the
 * generator was invoked from, unless it was given as an absolute path. That
 * makes `create-broapp ../../etc/app` an error rather than a surprise, while
 * leaving a deliberate `/opt/things/app` alone.
 */
export function checkDestination(target: string, cwd: string): Check {
  if (target === '') return no('the destination is empty');
  if (target.includes('\0')) return no('the destination contains a null byte');
  if (isAbsolute(target)) return ok;
  const resolved = resolve(cwd, target);
  const inside = relative(cwd, resolved);
  if (inside.startsWith('..')) {
    return no('the destination is outside the current directory; pass an absolute path if that is intended');
  }
  return ok;
}

/**
 * Derive a default application name from a destination path.
 *
 * Lower-cases and replaces runs of illegal characters with a hyphen. Returns
 * `null` when nothing usable survives, in which case the caller must ask.
 */
export function suggestName(target: string): string | null {
  const base = target.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return cleaned !== '' && checkAppName(cleaned).ok ? cleaned : null;
}
