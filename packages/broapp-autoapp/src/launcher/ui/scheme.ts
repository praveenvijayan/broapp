/**
 * Light, dark or the machine's own choice.
 *
 * The choice is one attribute on the document: `data-scheme="light"`,
 * `data-scheme="dark"`, or nothing at all for "system". `launcher.css` keys
 * its palette off it and sets `color-scheme` inside each block, so scrollbars
 * and form controls follow too — and so does the chat panel, whose colours are
 * the launcher's variables.
 *
 * The obvious mechanism — `light-dark()` pairs and
 * `document.documentElement.style.colorScheme` — does not work in a page built
 * by `buildPage`: Bun's CSS bundler rewrites `light-dark()` into a
 * `prefers-color-scheme` query with two toggle variables, so the pairs answer
 * the machine and setting `color-scheme` on the document changes nothing.
 * Measured in the built page before this was written.
 */
import type { BroappScheme } from 'broapp-ai-elements/ui';

/** Where the choice is remembered. */
export const SCHEME_KEY = 'broapp-autoapp:scheme';

/** The attribute the stylesheet reads. */
const SCHEME_ATTRIBUTE = 'data-scheme';

/** What was chosen last, or "system" when nothing was or storage refuses. */
export function readScheme(): BroappScheme {
  try {
    const stored = window.localStorage.getItem(SCHEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Put a choice on the document. Called before the first render, and on a click. */
export function applyScheme(scheme: BroappScheme): void {
  const root = document.documentElement;
  if (scheme === 'system') root.removeAttribute(SCHEME_ATTRIBUTE);
  else root.setAttribute(SCHEME_ATTRIBUTE, scheme);
}
