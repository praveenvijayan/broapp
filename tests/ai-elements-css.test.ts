/**
 * The committed stylesheet.
 *
 * It is generated, and generated files that live in git go stale silently. So
 * this rebuilds it and compares — and checks the two properties a Broapp page
 * depends on: the panel's rules are scoped, and nothing in them reaches
 * off-origin.
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildCss } from '../packages/broapp-ai-elements/scripts/build-css.ts';

const committed = await readFile(
  join(import.meta.dir, '..', 'packages', 'broapp-ai-elements', 'styles.css'),
  'utf8',
);

describe('styles.css', () => {
  test('is what the build produces', async () => {
    expect(await buildCss()).toBe(committed);
  }, 60_000);

  test('loads nothing from off-origin', () => {
    // `broapp build` fails a page whose CSS carries either of these, so a
    // stylesheet that grew one would break every application that ships it.
    expect(committed).not.toContain('url(');
    expect(committed).not.toContain('@import');
    expect(committed).not.toContain('http:');
    expect(committed).not.toContain('https:');
  });

  test('is scoped to the panel, and to the drawer around it', () => {
    expect(committed).toContain('.broapp-chat');
    expect(committed).toContain('.broapp-chat-drawer');
    expect(committed).toContain('.broapp-chat-toggle');
  });

  test('dresses the workspace pieces too', () => {
    // The list, the scheme toggle and the menu's own content are drawn outside
    // `.broapp-chat` — in a rail, a column, a portal — so each needs its own
    // rules and its own copy of the tokens.
    for (const workspace of [
      '.broapp-chat__topbar',
      '.broapp-chat-picker',
      '.broapp-chat-menu__content',
      '.broapp-chat-threads',
      '.broapp-chat-scheme',
    ]) {
      expect(committed).toContain(workspace);
    }
  });

  test('takes its colour scheme from the page, in three states', () => {
    // `<html data-scheme="light">` → light, `"dark"` → dark, absent → the
    // machine. `light-dark()` said this in one function and cannot be used:
    // Bun's CSS bundler rewrites it into an OS media query, so a stylesheet
    // that was right here asked the machine in every page that shipped
    // (report 07). `tests/build.test.ts` proves it on the built page; these
    // are the rules that page is built from.
    expect(committed).not.toContain('light-dark(');
    expect(committed).toContain('[data-scheme=dark]');
    expect(committed).toContain(':not([data-scheme=light])');
    // The third state, and the only place the panel may ask the machine.
    expect(committed).toContain('prefers-color-scheme');
    expect(committed).toContain('prefers-reduced-motion');
  });

  test('reproduces the part of preflight a form control needs', () => {
    // Without this the textarea takes the page's colour on the panel's ground,
    // which in a dark page meant typing invisibly.
    expect(committed).toContain('.broapp-chat :where(input,textarea,select,button)');
  });
});
