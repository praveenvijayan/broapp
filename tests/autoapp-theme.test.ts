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
import {
  APPLICATION_VARIABLES,
  AUTOAPP_TOKENS,
  declaredValue,
  fallbackFor,
  TOKEN_PREFIX,
  tokensCss,
} from 'broapp-autoapp/react';

const repo = join(import.meta.dir, '..');
const packageDir = join(repo, 'packages', 'broapp-autoapp');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const tokensFile = read(packageDir, 'src', 'react', 'tokens.css');
const viewCss = read(packageDir, 'src', 'react', 'view.css');
const starterCss = read(repo, 'templates', 'autoapp-starter', 'src', 'ui', 'styles.css');
const notesCss = read(repo, 'examples', 'notes', 'src', 'ui', 'styles.css');
const launcherCss = read(packageDir, 'src', 'launcher', 'ui', 'launcher.css');
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

  test('every `reads` names one of the seven application properties', () => {
    const reading = AUTOAPP_TOKENS.filter((token) => token.reads !== undefined);
    expect(reading.length).toBeGreaterThan(0);
    for (const token of reading) {
      // A length or a corner has no application-level meaning: the seven are a
      // palette, and a palette does not decide how much room a button takes.
      expect(token.group).toBe('colour');
      expect([...APPLICATION_VARIABLES] as string[]).toContain(token.reads ?? '');
    }
  });

  test('tokens.css declares `var(--x, default)` for exactly the tokens with a `reads`', () => {
    for (const token of AUTOAPP_TOKENS) {
      const light = `${TOKEN_PREFIX}${token.name}: ${declaredValue(token, 'light')};`;
      expect(tokensFile).toContain(light);
      if (token.reads === undefined) {
        expect(light).not.toMatch(/var\((?!--autoapp-)/);
      } else {
        expect(light).toContain(`var(${token.reads}, ${token.light})`);
      }
      if (token.dark !== token.light) {
        expect(tokensFile).toContain(`${TOKEN_PREFIX}${token.name}: ${declaredValue(token, 'dark')};`);
      }
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

  test('has no weight, tracking or family outside a token', () => {
    // Every `var()` is gone from `outside`, so a tokenised declaration is left
    // as `font-weight: ;` and only a literal has anything after the colon.
    const literals = outside.match(/(?:font-family|font-weight|letter-spacing)\s*:\s*[^;\s}][^;}]*/g);
    expect(literals).toBeNull();
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

/**
 * What a colour token resolves to when a stylesheet sets `set`.
 *
 * The cascade this models is one rule deep on purpose: `tokens.css` declares
 * every token at zero specificity, so the only question is whether the
 * application set the token itself, set the application property the token
 * reads, or set neither. The browser harness proves the same thing in a
 * compiled page; this proves the table's half of it without one.
 */
function resolve(set: Readonly<Record<string, string>>, scheme: 'light' | 'dark' = 'light'): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const token of AUTOAPP_TOKENS) {
    const direct = set[`${TOKEN_PREFIX}${token.name}`];
    if (direct !== undefined) {
      resolved.set(token.name, direct);
      continue;
    }
    const followed = token.reads === undefined ? undefined : set[token.reads];
    resolved.set(token.name, followed ?? (scheme === 'light' ? token.light : token.dark));
  }
  return resolved;
}

describe('the adapter, as a cascade', () => {
  const palette = Object.fromEntries(APPLICATION_VARIABLES.map((name, index) => [name, `#00000${String(index)}`]));

  test('the seven change every token that reads them and no other', () => {
    const themed = resolve(palette);
    const plain = resolve({});
    for (const token of AUTOAPP_TOKENS) {
      const expected = token.reads === undefined ? token.light : palette[token.reads];
      expect(themed.get(token.name)).toBe(expected);
      if (token.reads === undefined) expect(themed.get(token.name)).toBe(plain.get(token.name));
    }
    // And it really is most of the renderer's colours that follow, not two.
    const followed = AUTOAPP_TOKENS.filter((token) => token.reads !== undefined);
    expect(followed.length).toBeGreaterThanOrEqual(8);
  });

  test('a token set directly wins over its reads', () => {
    const themed = resolve({ ...palette, [`${TOKEN_PREFIX}accent`]: '#ff00ff' });
    expect(themed.get('accent')).toBe('#ff00ff');
    // And only that one: the override is not a scheme.
    expect(themed.get('heading')).toBe(palette['--text']);
  });
});

describe('what an application writes', () => {
  test("the starter's styles.css sets the seven and only tokens besides", () => {
    const named = setNames(starterCss);
    expect(named.filter((name) => name.startsWith(TOKEN_PREFIX) && !byName.has(name.slice(TOKEN_PREFIX.length)))).toEqual(
      [],
    );
    const { light, dark } = schemes(starterCss);
    expect(APPLICATION_VARIABLES.filter((name) => !setNames(light).includes(name))).toEqual([]);
    // Every palette property is defined in both schemes, or a dark machine
    // gets a light value for whichever one was forgotten.
    expect(APPLICATION_VARIABLES.filter((name) => !setNames(dark).includes(name))).toEqual([]);
    // What it no longer writes: the tokens that now follow the palette.
    for (const name of ['heading', 'text', 'muted', 'border', 'surface', 'accent']) {
      expect(named).not.toContain(`${TOKEN_PREFIX}${name}`);
    }
  });

  test('Notes sets the seven, and every token it still writes differs from the palette on purpose', () => {
    const { light, dark } = schemes(notesCss);
    expect(APPLICATION_VARIABLES.filter((name) => !setNames(light).includes(name))).toEqual([]);
    expect(APPLICATION_VARIABLES.filter((name) => !setNames(dark).includes(name))).toEqual([]);
    const named = setNames(notesCss).filter((name) => name.startsWith(TOKEN_PREFIX));
    expect(named.filter((name) => !byName.has(name.slice(TOKEN_PREFIX.length)))).toEqual([]);
    // A line for a token that reads a property Notes sets to the same value
    // would be noise; every one it keeps is a token the palette cannot give it,
    // or one it deliberately points elsewhere.
    for (const name of named) {
      const token = byName.get(name.slice(TOKEN_PREFIX.length));
      expect(token).toBeDefined();
    }
    expect(named).toContain(`${TOKEN_PREFIX}input`);
    expect(named).not.toContain(`${TOKEN_PREFIX}surface`);
  });

  test('the launcher feeds the seven from its own palette, in both schemes', () => {
    // The launcher tab is the other application on this contract: it themes the
    // panel, and now the renderer too, through the same seven.
    for (const name of APPLICATION_VARIABLES) {
      expect(launcherCss).toContain(`${name}: var(--launcher-`);
    }
  });

  for (const [name, css] of Object.entries(presets)) {
    test(`the ${name} preset sets the palette and only tokens besides, and resolves every colour in both schemes`, () => {
      const all = setNames(css);
      const allowed = new Set<string>([...APPLICATION_VARIABLES]);
      expect(all.filter((property) => !allowed.has(property) && !byName.has(property.slice(TOKEN_PREFIX.length)))).toEqual(
        [],
      );
      const { light, dark } = schemes(css);
      for (const [scheme, block] of [
        ['light', light],
        ['dark', dark],
      ] as const) {
        expect(APPLICATION_VARIABLES.filter((property) => !setNames(block).includes(property))).toEqual([]);
        // Every colour is decided by this preset in this scheme: either it sets
        // the token, or it sets the property the token reads. A preset that
        // left one to the renderer's default would mix two palettes.
        const set = Object.fromEntries(setNames(block).map((property) => [property, 'set']));
        const undecided = AUTOAPP_TOKENS.filter(
          (token) =>
            token.group === 'colour' &&
            token.light !== `var(${TOKEN_PREFIX}accent)` &&
            resolve(set, scheme).get(token.name) !== 'set',
        );
        expect(undecided.map((token) => `${scheme}: ${token.name}`)).toEqual([]);
      }
      // The palette and tokens on `:root` and nothing else: no selector reaches
      // a renderer class.
      const selectors = [...withoutComments(css).matchAll(/([^{};]+)\{/g)].map((match) => match[1]?.trim());
      expect(selectors).toEqual([':root', '@media (prefers-color-scheme: dark)', ':root']);
    });
  }
});

describe('the authoring gate', () => {
  const rules = read(repo, 'prompts', 'autoapp', '00-common-rules.md');
  const components = read(repo, 'docs', 'autoapp', 'components.md');

  test('the common rules carry the "Adding a component" checklist', () => {
    expect(rules).toMatch(/^## .*Adding a component$/m);
    // Every item the decisions table of prompt 12g names. A model that skips
    // one of these has skipped the part somebody else has to live with.
    for (const item of [
      'where it lives',
      'typed props',
      'controlled',
      'keyboard',
      'focus',
      'accessib',
      'loading',
      'empty',
      'error',
      'disabled',
      'stable id',
      'cva',
      'cn()',
      'Radix',
      'provenance',
      'licence',
      'tokens only',
      'reference topic',
      'gallery',
      'theme-check',
      'test',
    ]) {
      expect(rules.toLowerCase()).toContain(item.toLowerCase());
    }
  });

  test('the strategy is a document, and it is short enough to read', () => {
    expect(components).toContain('# Components');
    expect(components.split('\n').length).toBeLessThan(200);
    // The three layers and the one theme, named.
    expect(components).toContain('broapp-ai-elements');
    expect(components).toContain('.broapp-tokens');
    expect(components).toContain(TOKEN_PREFIX);
  });
});

describe('the theme reference', () => {
  test('names every token as code, generated from the table', () => {
    const text = specReference('theme');
    const missing = AUTOAPP_TOKENS.filter((token) => !text.includes(`\`${TOKEN_PREFIX}${token.name}\``));
    expect(missing.map((token) => token.name)).toEqual([]);
    expect(text).toContain(':where(:root)');
    expect(text).toContain('presets/quiet.css');
  });

  test('it names `reads` for every token that has one, and the seven by name', () => {
    const text = specReference('theme');
    for (const name of APPLICATION_VARIABLES) expect(text).toContain(`\`${name}\``);
    const missing = AUTOAPP_TOKENS.filter(
      (token) => token.reads !== undefined && !text.includes(`follows \`${String(token.reads)}\``),
    );
    expect(missing.map((token) => token.name)).toEqual([]);
    // The precedence rule and the panel's scope, which an engineer cannot work
    // out from the token list.
    expect(text).toContain('.broapp-tokens');
    expect(text).toMatch(/beats what it would have followed/);
  });

  test('it says how a style guide becomes a theme, and what it cannot become', () => {
    const text = specReference('theme');
    expect(text).toContain('## Applying a style guide');
    expect(text).toMatch(/by role, never by name/);
    // Each of the three refusals the engineer has to be able to say out loud.
    expect(text).toMatch(/Marketing-page components/);
    expect(text).toContain("font-src 'self'");
    expect(text).toContain('color-scheme: light');
  });

  test('the views topic points at it, and the workspace topic says where a dependency is decided', () => {
    expect(specReference('views')).toMatch(/`theme` topic/);
    expect(specReference('workspace')).toMatch(/Prefer what the renderer already draws/);
    expect(specReference('workspace')).toMatch(/never in an\s+application's `package\.json`/);
  });
});
