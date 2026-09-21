/**
 * What the launcher's page remembers in the browser, and how it survives a
 * browser that will not remember anything.
 *
 * Storage can be unavailable — a private window, a policy, a full quota — and
 * that is not a fault: the page works, it just forgets. Every read and write
 * goes through here so that no caller has to remember the `try`.
 */

/** Read a remembered flag. */
export function remembered(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === 'true';
  } catch {
    return fallback;
  }
}

/**
 * Read a remembered string, or `null`: nothing stored, storage refused, or a
 * value that is not a string or is longer than `max` (a value from a later
 * page, or one somebody typed into devtools, is ignored rather than trusted).
 */
export function rememberedText(key: string, max: number): string | null {
  try {
    const stored: unknown = window.localStorage.getItem(key);
    return typeof stored === 'string' && stored !== '' && stored.length <= max ? stored : null;
  } catch {
    return null;
  }
}

/** Write one, ignoring a storage that refuses. */
export function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the launcher still works, it just forgets.
  }
}
