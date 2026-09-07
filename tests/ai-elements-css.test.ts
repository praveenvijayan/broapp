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

  test('follows the page\'s colour scheme, never the operating system\'s', () => {
    // `light-dark()` resolves against the inherited `color-scheme`, so the
    // panel is light inside a light page even on a machine set to dark. A
    // `prefers-color-scheme` query anywhere in here would ask the machine
    // instead — including the ones Tailwind's `dark:` variant generates.
    expect(committed).toContain('light-dark(');
    expect(committed).not.toContain('prefers-color-scheme');
    // The one media query that should still be here.
    expect(committed).toContain('prefers-reduced-motion');
  });

  test('reproduces the part of preflight a form control needs', () => {
    // Without this the textarea takes the page's colour on the panel's ground,
    // which in a dark page meant typing invisibly.
    expect(committed).toContain('.broapp-chat :where(input,textarea,select,button)');
  });
});
