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

  test('is scoped to the panel and follows the scheme', () => {
    expect(committed).toContain('.broapp-chat');
    expect(committed).toContain('prefers-color-scheme');
  });
});
