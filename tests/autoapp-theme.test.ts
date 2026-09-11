/**
 * The theme contract.
 *
 * One table in `theme.ts` declares every `--autoapp-*` token. Everything else
 * that names a token — the generated defaults, the renderer's stylesheet, the
 * starter, the presets, the engineer's reference — is either built from that
 * table or held to it here, because a list kept in two places drifts, and the
 * copy that drifted is always the one somebody is reading.
 *
 * Nothing is rendered. Whether no application changes appearance is proved
 * another way: every length and colour in `view.css` sits in a token's
 * fallback, and every fallback is the value the renderer used before the table
 * existed, which is also the table's default.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { specReference } from 'broapp-autoapp/engineer';
import { AUTOAPP_TOKENS, fallbackFor, TOKEN_PREFIX, tokensCss } from 'broapp-autoapp/react';

const repo = join(import.meta.dir, '..');
const packageDir = join(repo, 'packages', 'broapp-autoapp');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const tokensFile = read(packageDir, 'src', 'react', 'tokens.css');
const viewCss = read(packageDir, 'src', 'react', 'view.css');
const starterCss = read(repo, 'templates', 'autoapp-starter', 'src', 'ui', 'styles.css');
const presets = {
  quiet: read(packageDir, 'presets', 'quiet.css'),
  dense: read(packageDir, 'presets', 'dense.css'),
};

const byName = new Map(AUTOAPP_TOKENS.map((token) => [token.name, token]));

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The index of the parenthesis that closes the one opened at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '(') depth++;
    if (text[index] === ')' && --depth === 0) return index;
  }
  throw new Error(`unbalanced parenthesis at ${String(open)}`);
}

interface Use {
  readonly name: string;
  readonly fallback: string | null;
}

/**
 * Every `var(--autoapp-…)` in `css`, nested ones included, and the text with
 * each top-level one removed — which is where a stray literal would be left.
 */
function scan(css: string): { uses: Use[]; outside: string } {
  const uses: Use[] = [];
  let outside = '';
  let at = 0;
  for (;;) {
    const found = css.indexOf('var(', at);
    if (found === -1) break;
    const end = closing(css, found + 3);
    const inner = css.slice(found + 4, end);
    outside += css.slice(at, found);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    if (name.startsWith(TOKEN_PREFIX)) {
      uses.push({ name: name.slice(TOKEN_PREFIX.length), fallback });
      if (fallback !== null) uses.push(...scan(fallback).uses);
    } else {
      // Not ours: keep it in view, literals and all.
      outside += css.slice(found, end + 1);
    }
    at = end + 1;
  }
  return { uses, outside: outside + css.slice(at) };
}

/** The body of the dark-scheme block, and everything else. */
function schemes(css: string): { light: string; dark: string } {
  const text = withoutComments(css);
  const start = text.indexOf('@media (prefers-color-scheme: dark)');
  if (start === -1) return { light: text, dark: '' };
  const open = text.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < text.length; end++) {
    if (text[end] === '{') depth++;
    if (text[end] === '}' && --depth === 0) break;
  }
  return { light: text.slice(0, start) + text.slice(end + 1), dark: text.slice(open + 1, end) };
}

/** The custom properties a stylesheet sets. */
function setNames(css: string): string[] {
  return [...withoutComments(css).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? '');
}

describe('the token table', () => {
  test('tokens.css is exactly what the table generates', () => {
    expect(tokensFile).toBe(tokensCss());
  });

  test('every name is unique, prefixed once, and a length is the same in both schemes', () => {
    const names = AUTOAPP_TOKENS.map((token) => token.name);
    expect(new Set(names).size).toBe(names.length);
    for (const token of AUTOAPP_TOKENS) {
      expect(token.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(token.name.startsWith('autoapp')).toBe(false);
      expect(token.purpose.length).toBeGreaterThan(0);
      if (token.group !== 'colour') expect(token.dark).toBe(token.light);
    }
  });

  test('tokens.css sets nothing but tokens, and only on :where(:root)', () => {
    const selectors = [...withoutComments(tokensFile).matchAll(/([^{};]+)\{/g)].map((match) => match[1]?.trim());
    expect(selectors).toEqual([':where(:root)', '@media (prefers-color-scheme: dark)', ':where(:root)']);
    for (const name of setNames(tokensFile)) expect(byName.has(name.slice(TOKEN_PREFIX.length))).toBe(true);
  });
});

describe('view.css', () => {
  const { uses, outside } = scan(withoutComments(viewCss));

  test('has no length or colour outside a token', () => {
    expect(outside.match(/\d(?:px|rem)\b/g)).toBeNull();
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  test("every fallback is the table's default for that token", () => {
    expect(uses.length).toBeGreaterThan(80);
    const wrong = uses
      .filter((use) => {
        const token = byName.get(use.name);
        return token === undefined || use.fallback !== fallbackFor(token);
      })
      .map((use) => `${use.name}: ${String(use.fallback)}`);
    expect(wrong).toEqual([]);
  });

  test('reads only tokens in the table, and every token the table says something reads', () => {
    const used = new Set(uses.map((use) => use.name));
    expect([...used].filter((name) => !byName.has(name))).toEqual([]);
    const unread = AUTOAPP_TOKENS.filter((token) => token.consumers.length > 0 && !used.has(token.name));
    expect(unread.map((token) => token.name)).toEqual([]);
  });

  test('never sets a token, so an application setting one on :root always wins', () => {
    expect(setNames(viewCss)).toEqual([]);
    expect(viewCss).not.toContain(':root');
  });
});

describe('what an application writes', () => {
  test("the starter's styles.css sets only tokens in the table", () => {
    const named = setNames(starterCss).filter((name) => name.startsWith(TOKEN_PREFIX));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !byName.has(name.slice(TOKEN_PREFIX.length)))).toEqual([]);
  });

  for (const [name, css] of Object.entries(presets)) {
    test(`the ${name} preset sets only tokens, and every colour in both schemes`, () => {
      const all = setNames(css);
      expect(all.filter((property) => !byName.has(property.slice(TOKEN_PREFIX.length)))).toEqual([]);
      const { light, dark } = schemes(css);
      const colours = AUTOAPP_TOKENS.filter((token) => token.group === 'colour').map(
        (token) => `${TOKEN_PREFIX}${token.name}`,
      );
      expect(colours.filter((property) => !setNames(light).includes(property))).toEqual([]);
      expect(colours.filter((property) => !setNames(dark).includes(property))).toEqual([]);
      // Tokens on `:root` and nothing else: no selector reaches a renderer class.
      const selectors = [...withoutComments(css).matchAll(/([^{};]+)\{/g)].map((match) => match[1]?.trim());
      expect(selectors).toEqual([':root', '@media (prefers-color-scheme: dark)', ':root']);
    });
  }
});

describe('the theme reference', () => {
  test('names every token as code, generated from the table', () => {
    const text = specReference('theme');
    const missing = AUTOAPP_TOKENS.filter((token) => !text.includes(`\`${TOKEN_PREFIX}${token.name}\``));
    expect(missing.map((token) => token.name)).toEqual([]);
    expect(text).toContain(':where(:root)');
    expect(text).toContain('presets/quiet.css');
  });

  test('the views topic points at it, and the workspace topic says where a dependency is decided', () => {
    expect(specReference('views')).toMatch(/`theme` topic/);
    expect(specReference('workspace')).toMatch(/Prefer what the renderer already draws/);
    expect(specReference('workspace')).toMatch(/never in an\s+application's `package\.json`/);
  });
});
