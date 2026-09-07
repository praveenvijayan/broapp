/**
 * `instanceof` across the release boundary.
 *
 * An Autoapp release bundles its own copy of `broapp`; the child runtime that
 * supervises it carries the copy compiled into the launcher. A class from one
 * is not `instanceof` the same class from the other, so a check that happens
 * to be written that way is false exactly when it matters — and silently. Two
 * bugs already came out of this: every deliberate refusal reduced to "internal
 * error" (report 05), and a `ValidationError` message thrown away.
 *
 * The rule is therefore mechanical rather than a matter of judgement: nothing
 * in these two source trees may use `instanceof` on a name that is not on the
 * list below, and every entry on the list says why it is safe. Adding a name
 * here is a deliberate act somebody has to justify in a diff.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOTS = [
  join(import.meta.dir, '..', 'packages', 'broapp', 'src'),
  join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src'),
];

/**
 * What may be tested with `instanceof`, and why each one is safe.
 *
 * "Safe" means one of two things: the value is a platform intrinsic, whose
 * identity is the runtime's rather than a bundle's, or the value provably never
 * crosses from a release's bundle into the launcher's.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  Error: 'A platform intrinsic; every realm here shares one.',
  InjectedCrash: 'The launcher’s own test seam; it is thrown and caught inside the launcher process.',
  LauncherNotRunning: 'Constructed and caught inside the MCP adapter, which is one process and one bundle.',
  AdapterError: 'Lives inside the AI layer; a release never runs a provider adapter.',
  BroappError:
    'Built by the client from a transport error. Every remaining use is under react/, which is one browser bundle; the one shared-code use is a shape check.',
};

/**
 * Platform intrinsics, allowed but not required to appear.
 *
 * A realm shares these with every bundle in it, so `instanceof` on one means
 * what it says. They are listed separately from {@link ALLOWED} because the
 * test below insists every entry there is actually used — an exception nobody
 * needs any more is an exception that outlived its case — and an intrinsic
 * that happens to be unused today is not an exception at all.
 */
const INTRINSICS: readonly string[] = ['TypeError', 'AbortSignal', 'Uint8Array', 'Map', 'Set', 'Date', 'RegExp'];

/** Every `.ts`/`.tsx` file under a directory. */
async function filesUnder(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await filesUnder(path)));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** Every `instanceof <Name>` in a source file, with the line it is on. */
function usages(source: string): readonly { name: string; line: number }[] {
  const found: { name: string; line: number }[] = [];
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    // Comments talk about `instanceof` a great deal in this codebase, and a
    // sentence about the rule is not a violation of it.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    for (const match of code.matchAll(/instanceof\s+([A-Za-z_$][\w$]*)/g)) {
      const name = match[1];
      if (name !== undefined) found.push({ name, line: index + 1 });
    }
  }
  return found;
}

describe('the release boundary', () => {
  test('nothing uses instanceof on a value that can cross it', async () => {
    const offences: string[] = [];
    let checked = 0;
    for (const root of ROOTS) {
      for (const file of await filesUnder(root)) {
        const source = await readFile(file, 'utf8');
        checked += 1;
        for (const use of usages(source)) {
          if (use.name in ALLOWED || INTRINSICS.includes(use.name)) continue;
          offences.push(`${file}:${String(use.line)}: instanceof ${use.name}`);
        }
      }
    }
    // A test that reads nothing passes for the wrong reason.
    expect(checked).toBeGreaterThan(50);
    expect(offences).toEqual([]);
  });

  test('every name on the allow-list has a reason, and is actually used', async () => {
    const used = new Set<string>();
    for (const root of ROOTS) {
      for (const file of await filesUnder(root)) {
        for (const use of usages(await readFile(file, 'utf8'))) used.add(use.name);
      }
    }
    for (const [name, reason] of Object.entries(ALLOWED)) {
      expect(`${name}: ${reason.length > 20 ? 'has a reason' : reason}`).toBe(`${name}: has a reason`);
      // An entry nobody needs any more is an exception that outlived its case.
      expect(`${name}: ${String(used.has(name))}`).toBe(`${name}: true`);
    }
  });

  test('the shape checks the rule depends on exist and work across realms', async () => {
    const { isPublicError, isValidationError, publicError, ValidationError } = await import(
      'broapp/shared'
    );

    // The real thing.
    expect(isPublicError(publicError.notFound('gone'))).toBe(true);
    expect(isValidationError(new ValidationError([{ path: [], message: 'no' }]))).toBe(true);

    // What the same class from another bundle looks like: same shape, no shared
    // identity. This is exactly the value that used to be reduced to "internal
    // error" before report 05 found it.
    class OtherRealmPublicError extends Error {
      readonly code = 'rejected';
      constructor(message: string) {
        super(message);
        this.name = 'PublicError';
      }
    }
    expect(isPublicError(new OtherRealmPublicError('declined'))).toBe(true);

    class OtherRealmValidationError extends Error {
      readonly issues = [{ path: [], message: 'no' }];
      constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
      }
    }
    expect(isValidationError(new OtherRealmValidationError('n: expected a number'))).toBe(true);

    // And what must not pass: anything that only claims the name.
    const liar = new Error('not really');
    liar.name = 'PublicError';
    expect(isPublicError(liar)).toBe(false);
    expect(isValidationError(liar)).toBe(false);
  });
});
