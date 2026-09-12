#!/usr/bin/env bun
/**
 * The first rendered check: one palette, two vocabularies, measured in a browser.
 *
 *   bun x playwright install chromium   # once
 *   bun run theme-check
 *
 * Three styling vocabularies share an Autoapp page. The renderer draws its own
 * components from `--autoapp-*` tokens. The AI panel is vendored shadcn source
 * on Radix, and reads seven application properties — `--bg`, `--surface`,
 * `--border`, `--text`, `--text-muted`, `--accent`, `--accent-contrast`. Since
 * prompt 12g the renderer's colour tokens read those same seven by meaning, so
 * an application sets its palette once. Every check of that arrangement until
 * now was a string in a test: this one builds the page with the real build,
 * opens it in Chromium, drives one ordinary control and one portalled
 * component under three themes and three schemes, and reads what the browser
 * actually computed.
 *
 * What it can say: that a colour resolved to the theme's value rather than to
 * a fallback literal, that a portal carries the panel's scope with it, and that
 * every text/background pair it measures meets 4.5:1. What it cannot say: that
 * the page looks good. A failure here is a named combination and property, not
 * a screenshot.
 *
 * Playwright is a root devDependency and nothing else: never a dependency of a
 * package, never in a binary, and not needed to build or run an application.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildPage } from 'broapp/build';

import { AUTOAPP_TOKENS, TOKEN_PREFIX, APPLICATION_VARIABLES } from 'broapp-autoapp/react';

const repo = resolve(import.meta.dir, '..');
const fixtureDir = join(repo, 'scripts', 'theme-check');
const outDir = join(repo, '.broapp-tmp', 'theme-check');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

/* ------------------------------------------------------------------ themes */

/**
 * An override an application writes by hand.
 *
 * The accent is set as a token, directly, to something the palette does not
 * say. That is the one case the precedence rule exists for: the renderer must
 * follow the token and the panel must keep following `--accent`, because the
 * panel never reads an `--autoapp-*` property.
 */
const OVERRIDE_CSS = `/* Written by the harness, not by an application. */
:root {
  ${TOKEN_PREFIX}accent: #8a1d6e;
}

@media (prefers-color-scheme: dark) {
  :root {
    ${TOKEN_PREFIX}accent: #ff9ede;
  }
}
`;

interface Theme {
  readonly id: string;
  readonly title: string;
  /** The application's whole stylesheet, in the order a page would carry it. */
  readonly css: string;
}

function themes(): readonly Theme[] {
  const starter = read(repo, 'templates', 'autoapp-starter', 'src', 'ui', 'styles.css');
  const quiet = read(repo, 'packages', 'broapp-autoapp', 'presets', 'quiet.css');
  return [
    { id: 'starter', title: 'The starter’s palette', css: starter },
    // A preset is used by copying it to the end of `styles.css`; so is this.
    { id: 'quiet', title: 'The quiet preset', css: `${starter}\n${quiet}` },
    { id: 'override', title: 'The starter’s palette, accent overridden by hand', css: `${starter}\n${OVERRIDE_CSS}` },
  ];
}

/* ------------------------------------------------------- the theme, resolved */

const DARK_MEDIA = '@media (prefers-color-scheme: dark)';

/** The index of the brace that closes the one at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}' && --depth === 0) return index;
  }
  throw new Error('unbalanced brace in a stylesheet');
}

/** The custom properties a block sets, in source order. */
function propertiesIn(block: string, into: Map<string, string>): void {
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) into.set(name, value.trim());
  }
}

/**
 * What a stylesheet sets on the document root, in each scheme.
 *
 * Only rules whose selector speaks about the root are read: a rule for a class
 * of the application's own cannot reach a token, because the renderer's
 * defaults are on `:where(:root)` and nothing else declares one. The dark map
 * is the light map with the dark blocks applied over it, which is the cascade.
 */
function rootProperties(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const light = new Map<string, string>();
  const darkOnly = new Map<string, string>();
  let at = 0;
  for (;;) {
    const brace = text.indexOf('{', at);
    if (brace === -1) break;
    const selector = text.slice(at, brace).trim();
    const end = closing(text, brace);
    const body = text.slice(brace + 1, end);
    if (selector.startsWith('@media') && selector.includes('prefers-color-scheme: dark')) {
      for (let inner = 0; ; ) {
        const innerBrace = body.indexOf('{', inner);
        if (innerBrace === -1) break;
        const innerSelector = body.slice(inner, innerBrace).trim();
        const innerEnd = closing(body, innerBrace);
        if (innerSelector.includes(':root')) propertiesIn(body.slice(innerBrace + 1, innerEnd), darkOnly);
        inner = innerEnd + 1;
      }
    } else if (selector.includes(':root')) {
      propertiesIn(body, light);
    }
    at = end + 1;
  }
  return { light, dark: new Map([...light, ...darkOnly]) };
}

/**
 * What the panel falls back to when an application says nothing.
 *
 * The renderer's fallbacks are in the token table, so they are read from
 * there. The panel's live in its own stylesheet, and this is the only one a
 * rule names: `--radius`, which an application may set and the panel reads
 * through `--radius-base`. Written out rather than parsed, because parsing
 * compiled Tailwind to find one literal would be a worse kind of coupling.
 */
const PANEL_FALLBACKS: Readonly<Record<string, string>> = { '--radius': '8px' };

/** The default `tokens.css` declares for a token in one scheme. */
function tokenDefault(name: string, scheme: Scheme): string | undefined {
  const token = AUTOAPP_TOKENS.find((one) => one.name === name);
  if (token === undefined) return undefined;
  return scheme === 'dark' ? token.dark : token.light;
}

const READS = new Map(
  AUTOAPP_TOKENS.filter((token) => token.reads !== undefined).map((token) => [
    `${TOKEN_PREFIX}${token.name}`,
    token.reads as string,
  ]),
);

/**
 * What a custom property resolves to for this theme, as a colour or a length.
 *
 * The cascade is short enough to do by hand: an application's own `:root`
 * beats the renderer's `:where(:root)`, a token that is not set follows its
 * `reads`, and a property that is not set anywhere falls back to the literal
 * in the declaration. `var()` chains are expanded the same way the browser
 * expands them, which is what makes the expected value independent of the
 * browser that is being measured.
 */
function resolveProperty(name: string, set: Map<string, string>, scheme: Scheme, seen: readonly string[] = []): string {
  if (seen.includes(name)) throw new Error(`${name} refers to itself: ${seen.join(' -> ')}`);
  const declared = set.get(name);
  if (declared !== undefined) return expand(declared, set, scheme, [...seen, name]);
  if (name.startsWith(TOKEN_PREFIX)) {
    const followed = READS.get(name);
    if (followed !== undefined && set.has(followed)) {
      return expand(set.get(followed) as string, set, scheme, [...seen, name]);
    }
    const fallback = tokenDefault(name.slice(TOKEN_PREFIX.length), scheme);
    if (fallback !== undefined) return expand(fallback, set, scheme, [...seen, name]);
  }
  return PANEL_FALLBACKS[name] ?? '';
}

/** Every `var(--x, fallback)` in `value`, replaced by what it resolves to. */
function expand(value: string, set: Map<string, string>, scheme: Scheme, seen: readonly string[]): string {
  let out = '';
  let at = 0;
  for (;;) {
    const found = value.indexOf('var(', at);
    if (found === -1) break;
    out += value.slice(at, found);
    const end = closingParen(value, found + 3);
    const inner = value.slice(found + 4, end);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    const resolved = resolveProperty(name, set, scheme, seen);
    out += resolved !== '' ? resolved : fallback === null ? '' : expand(fallback, set, scheme, seen);
    at = end + 1;
  }
  return (out + value.slice(at)).trim();
}

function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '(') depth++;
    if (text[index] === ')' && --depth === 0) return index;
  }
  throw new Error('unbalanced parenthesis in a stylesheet');
}

/* ---------------------------------------------------------- what is measured */

export type Scheme = 'light' | 'dark' | 'no-preference';

const SCHEMES: readonly Scheme[] = ['light', 'dark', 'no-preference'];

/** One thing on the page, and what its colours are supposed to come from. */
interface Target {
  readonly id: string;
  readonly selector: string;
  /** The vocabulary it belongs to, for the report. */
  readonly drawnBy: 'renderer' | 'panel';
  /** The property its background must resolve to, if it is claimed. */
  readonly background?: string;
  /** The property its text colour must resolve to. */
  readonly colour?: string;
  readonly border?: string;
  readonly radius?: string;
  /** A text/background pair worth a contrast ratio. */
  readonly contrast?: boolean;
}

const TARGETS: readonly Target[] = [
  // The ordinary control: the renderer's button.
  {
    id: 'button',
    selector: '.autoapp-button',
    drawnBy: 'renderer',
    background: `${TOKEN_PREFIX}button`,
    // A button takes the page's ink: `color: inherit`, and the page says
    // `color: var(--text)`. One palette property, two vocabularies.
    colour: '--text',
    border: `${TOKEN_PREFIX}border`,
    radius: `${TOKEN_PREFIX}radius-sm`,
    contrast: true,
  },
  { id: 'page-title', selector: '.autoapp-page__title', drawnBy: 'renderer', colour: `${TOKEN_PREFIX}heading`, contrast: true },
  // The card: what the panel's popover has to agree with, because both are a
  // surface a shade off the page's ground.
  {
    id: 'card',
    selector: '.autoapp-form',
    drawnBy: 'renderer',
    background: `${TOKEN_PREFIX}surface`,
    border: `${TOKEN_PREFIX}border`,
    radius: `${TOKEN_PREFIX}radius-lg`,
  },
  { id: 'table-cell', selector: '.autoapp-table__grid td', drawnBy: 'renderer', colour: '--text', contrast: true },
  {
    id: 'column-header',
    selector: '.autoapp-table__grid th',
    drawnBy: 'renderer',
    colour: `${TOKEN_PREFIX}muted`,
    contrast: true,
  },
  { id: 'link', selector: '.autoapp-link', drawnBy: 'renderer', colour: `${TOKEN_PREFIX}accent`, contrast: true },
  {
    id: 'field',
    selector: '.autoapp-field__input',
    drawnBy: 'renderer',
    background: `${TOKEN_PREFIX}input`,
    colour: '--text',
    border: `${TOKEN_PREFIX}border`,
    contrast: true,
  },
  // The portalled component: the panel's select, opened.
  {
    id: 'select-trigger',
    selector: '[data-check="select-trigger"]',
    drawnBy: 'panel',
    colour: '--text',
    border: '--border',
    contrast: true,
  },
  {
    id: 'select-content',
    selector: '[data-slot="select-content"]',
    drawnBy: 'panel',
    background: '--surface',
    colour: '--text',
    radius: '--radius',
    contrast: true,
  },
  { id: 'select-item', selector: '[data-slot="select-item"]', drawnBy: 'panel', colour: '--text', contrast: true },
];

/** What the browser reported for one target. */
export interface Measured {
  readonly id: string;
  readonly drawnBy: 'renderer' | 'panel';
  readonly found: boolean;
  readonly backgroundColor: string;
  /** The nearest painted background behind it, for contrast. */
  readonly effectiveBackground: string;
  readonly color: string;
  readonly borderColor: string;
  readonly borderRadius: string;
  readonly fontFamily: string;
  readonly fontWeight: string;
  /** Whether it sits inside the panel's token scope, portal included. */
  readonly inTokenScope: boolean;
  readonly contrast: number | null;
}

export interface Combination {
  readonly theme: string;
  readonly scheme: Scheme;
  readonly targets: readonly Measured[];
  readonly panelPrimary: string;
  readonly rootAccentToken: string;
  readonly failures: readonly string[];
}

export interface CheckReport {
  readonly combinations: readonly Combination[];
  readonly failures: readonly string[];
  readonly pageBytes: Readonly<Record<string, number>>;
  readonly seconds: number;
}

/* --------------------------------------------------------------- the browser */

/**
 * What is read in the page, once per combination.
 *
 * Source text rather than a function: `page.evaluate` is given a
 * self-calling expression with the input already inside it, so this file needs
 * no DOM types and the browser needs no serialised closure.
 */
const PROBE = `(input) => {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  // Every colour is compared as the browser spells it: the expected value goes
  // through the same parser as the computed one, so \`#fff\` and \`rgb(255 255 255)\`
  // cannot disagree over nothing.
  const canonical = (value) => {
    if (value === '' || value === undefined) return '';
    probe.style.color = '';
    probe.style.color = value;
    const parsed = getComputedStyle(probe).color;
    return probe.style.color === '' ? '' : parsed;
  };
  // A length goes through the same door: \`0.5rem\` and \`8px\` are one value once
  // the browser has resolved the root font size, and a radius is compared as
  // the browser spells it too.
  const canonicalLength = (value) => {
    if (value === '' || value === undefined) return '';
    probe.style.borderTopLeftRadius = '';
    probe.style.borderTopLeftRadius = value;
    if (probe.style.borderTopLeftRadius === '') return '';
    probe.style.display = 'block';
    const parsed = getComputedStyle(probe).borderTopLeftRadius;
    probe.style.display = 'none';
    return parsed;
  };
  const painted = (element) => {
    for (let node = element; node !== null; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor;
      if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return value;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };
  const channel = (part) => {
    const value = part / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance = (colour) => {
    const parts = colour.match(/[\\d.]+/g);
    if (parts === null || parts.length < 3) return null;
    const [r, g, b] = parts.map(Number);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (text, background) => {
    const one = luminance(text);
    const two = luminance(background);
    if (one === null || two === null) return null;
    const light = Math.max(one, two);
    const dark = Math.min(one, two);
    return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
  };

  const targets = input.targets.map((target) => {
    const element = document.querySelector(target.selector);
    if (element === null) {
      return { id: target.id, drawnBy: target.drawnBy, found: false, backgroundColor: '', effectiveBackground: '', color: '', borderColor: '', borderRadius: '', fontFamily: '', fontWeight: '', inTokenScope: false, contrast: null };
    }
    const style = getComputedStyle(element);
    const background = painted(element);
    return {
      id: target.id,
      drawnBy: target.drawnBy,
      found: true,
      backgroundColor: style.backgroundColor,
      effectiveBackground: background,
      color: style.color,
      borderColor: style.borderTopColor,
      borderRadius: style.borderTopLeftRadius,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      inTokenScope: element.closest('.broapp-chat, .broapp-tokens, .broapp-chat-drawer, .broapp-chat-menu__content') !== null,
      contrast: target.contrast === true ? ratio(style.color, background) : null,
    };
  });

  const panel = document.querySelector('[data-check="panel"]');
  const result = {
    targets,
    expected: Object.fromEntries(Object.entries(input.expected).map(([key, value]) => [key, canonical(value)])),
    expectedLength: Object.fromEntries(
      Object.entries(input.expected).map(([key, value]) => [key, canonicalLength(value)]),
    ),
    panelPrimary: panel === null ? '' : canonical(getComputedStyle(panel).getPropertyValue('--primary')),
    rootAccentToken: canonical(getComputedStyle(document.documentElement).getPropertyValue('${TOKEN_PREFIX}accent')),
  };
  probe.remove();
  return result;
}`;

/** The probe, as an expression that calls itself with this input. */
function call(input: { targets: readonly Target[]; expected: Readonly<Record<string, string>> }): string {
  return `(${PROBE})(${JSON.stringify(input)})`;
}

/* ----------------------------------------------------------------- the rules */

/** 4.5:1, the WCAG 2 minimum for body text. */
const MINIMUM_CONTRAST = 4.5;

function judge(
  theme: Theme,
  scheme: Scheme,
  measured: readonly Measured[],
  expected: Readonly<Record<string, string>>,
  lengths: Readonly<Record<string, string>>,
  literals: Readonly<Record<string, string>>,
  panelPrimary: string,
  rootAccentToken: string,
): readonly string[] {
  const failures: string[] = [];
  const where = `${theme.id}/${scheme}`;
  const byId = new Map(measured.map((one) => [one.id, one]));

  for (const target of TARGETS) {
    const found = byId.get(target.id);
    if (found === undefined || !found.found) {
      failures.push(`${where}: ${target.id} was not on the page`);
      continue;
    }
    const check = (property: keyof Measured, wanted: string | undefined, label: string): void => {
      if (wanted === undefined) return;
      const want = expected[wanted];
      if (want === undefined || want === '') {
        failures.push(`${where}: ${target.id} ${label} has no expected value for ${wanted}`);
        return;
      }
      const got = String(found[property]);
      if (got !== want) failures.push(`${where}: ${target.id} ${label} is ${got}, the theme says ${wanted} is ${want}`);
      // And it is not the literal the declaration falls back to, when the
      // theme decided the property. A value that resolved to its own fallback
      // is exactly the failure this harness exists to catch.
      const literal = literals[wanted];
      if (literal !== undefined && literal !== '' && literal !== want && got === literal) {
        failures.push(`${where}: ${target.id} ${label} fell back to the declaration's literal ${literal}`);
      }
    };
    check('backgroundColor', target.background, 'background');
    check('color', target.colour, 'colour');
    check('borderColor', target.border, 'border');
    if (target.radius !== undefined) {
      const want = lengths[target.radius];
      if (want !== undefined && want !== '' && found.borderRadius !== want) {
        failures.push(`${where}: ${target.id} radius is ${found.borderRadius}, the theme says ${target.radius} is ${want}`);
      }
    }
    if (target.drawnBy === 'panel' && !found.inTokenScope) {
      failures.push(`${where}: ${target.id} is drawn outside the panel's token scope, so it cannot read the panel's colours`);
    }
    if (target.contrast === true && found.contrast !== null && found.contrast < MINIMUM_CONTRAST) {
      failures.push(
        `${where}: ${target.id} is ${String(found.contrast)}:1 (${found.color} on ${found.effectiveBackground}), under ${String(MINIMUM_CONTRAST)}:1`,
      );
    }
  }

  // The override reaches the renderer and not the panel.
  if (theme.id === 'override') {
    const accent = expected['--accent'];
    if (rootAccentToken === accent) {
      failures.push(`${where}: the renderer's accent token is still the palette's ${String(accent)}, so the override did not reach it`);
    }
    if (panelPrimary !== accent) {
      failures.push(`${where}: the panel's --primary is ${panelPrimary}, but the palette says --accent is ${String(accent)}; an --autoapp-* override must not reach the panel`);
    }
  } else if (panelPrimary !== expected['--accent']) {
    failures.push(`${where}: the panel's --primary is ${panelPrimary}, the palette says ${String(expected['--accent'])}`);
  }
  return failures;
}

/* ------------------------------------------------------------------- running */

/** Expected values, per theme and scheme, for everything a rule names. */
function expectations(theme: Theme, scheme: Scheme): { expected: Record<string, string>; literals: Record<string, string> } {
  const { light, dark } = rootProperties(theme.css);
  const set = scheme === 'dark' ? dark : light;
  const wanted = new Set<string>([...APPLICATION_VARIABLES]);
  for (const target of TARGETS) {
    for (const property of [target.background, target.colour, target.border, target.radius]) {
      if (property !== undefined) wanted.add(property);
    }
  }
  const expected: Record<string, string> = {};
  const literals: Record<string, string> = {};
  for (const name of wanted) {
    expected[name] = resolveProperty(name, set, scheme);
    // What the same property resolves to with the theme removed: the literal
    // in `tokens.css`, or the panel's own fallback.
    literals[name] = resolveProperty(name, new Map(), scheme);
  }
  return { expected, literals };
}

/** Build the page for one theme and return where it was written. */
async function build(theme: Theme): Promise<{ file: string; bytes: number }> {
  writeFileSync(join(fixtureDir, 'theme.css'), `/* ${theme.title} — written by scripts/theme-check.ts */\n${theme.css}`, 'utf8');
  const file = join(outDir, `${theme.id}.html`);
  const built = await buildPage({
    entry: 'scripts/theme-check/main.tsx',
    template: 'scripts/theme-check/index.html',
    outFile: file,
    root: repo,
    // Readable in devtools, which is the point of a page somebody debugs.
    minify: false,
  });
  return { file, bytes: built.bytes };
}

/** Run every combination. Nothing is written; the caller decides. */
export async function themeCheck(): Promise<CheckReport> {
  const started = Date.now();
  mkdirSync(outDir, { recursive: true });
  const { chromium } = await import('playwright');
  const all = themes();
  const pageBytes: Record<string, number> = {};
  const combinations: Combination[] = [];
  const failures: string[] = [];

  const browser = await chromium.launch();
  try {
    for (const theme of all) {
      const built = await build(theme);
      pageBytes[theme.id] = built.bytes;
      for (const scheme of SCHEMES) {
        const page = await browser.newPage();
        try {
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(String(error)));
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(`file://${built.file}`);
          await page.waitForSelector('.autoapp-button', { state: 'attached' });
          // The fonts the page ships, so a family is measured after they load
          // rather than while the browser is still deciding.
          await page.evaluate('document.fonts.ready');
          // Opening it is the whole point: the content is portalled to the end
          // of the document, and what it reads there is what is being checked.
          await page.click('[data-check="select-trigger"]');
          await page.waitForSelector('[data-slot="select-content"]', { state: 'visible' });
          const { expected, literals } = expectations(theme, scheme);
          const result = (await page.evaluate(call({ targets: TARGETS, expected }))) as {
            targets: readonly Measured[];
            expected: Record<string, string>;
            expectedLength: Record<string, string>;
            panelPrimary: string;
            rootAccentToken: string;
          };
          const canonicalLiterals = (await page.evaluate(call({ targets: [], expected: literals }))) as {
            expected: Record<string, string>;
          };
          const combinationFailures = [
            ...errors.map((error) => `${theme.id}/${scheme}: the page threw ${error}`),
            ...judge(
              theme,
              scheme,
              result.targets,
              result.expected,
              result.expectedLength,
              canonicalLiterals.expected,
              result.panelPrimary,
              result.rootAccentToken,
            ),
          ];
          combinations.push({
            theme: theme.id,
            scheme,
            targets: result.targets,
            panelPrimary: result.panelPrimary,
            rootAccentToken: result.rootAccentToken,
            failures: combinationFailures,
          });
          failures.push(...combinationFailures);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    rmSync(join(fixtureDir, 'theme.css'), { force: true });
  }
  return { combinations, failures, pageBytes, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

/** Whether a browser can be launched at all, so a test can skip instead of fail. */
export async function chromiumRuns(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- the report */

function markdown(report: CheckReport): string {
  const lines: string[] = [
    '# theme-check',
    '',
    `Nine combinations, ${String(report.combinations.length * TARGETS.length)} measurements, ${String(report.seconds)}s.`,
    '',
    '| theme | scheme | target | drawn by | background | colour | border | radius | contrast | panel scope |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const combination of report.combinations) {
    for (const target of combination.targets) {
      lines.push(
        `| ${combination.theme} | ${combination.scheme} | ${target.id} | ${target.drawnBy} | ${target.backgroundColor || '—'} | ${target.color} | ${target.borderColor} | ${target.borderRadius} | ${target.contrast === null ? '—' : `${String(target.contrast)}:1`} | ${target.inTokenScope ? 'yes' : 'no'} |`,
      );
    }
  }
  lines.push('', '## What the panel resolved', '', '| theme | scheme | panel --primary | renderer --autoapp-accent |', '|---|---|---|---|');
  for (const combination of report.combinations) {
    lines.push(`| ${combination.theme} | ${combination.scheme} | ${combination.panelPrimary} | ${combination.rootAccentToken} |`);
  }
  lines.push('', '## Failures', '');
  lines.push(report.failures.length === 0 ? 'None.' : report.failures.map((failure) => `- ${failure}`).join('\n'));
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<number> {
  const report = await themeCheck();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, '..', 'theme-check.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, '..', 'theme-check.md'), markdown(report), 'utf8');
  for (const [theme, bytes] of Object.entries(report.pageBytes)) {
    console.log(`page    ${theme}  ${String(bytes)} bytes`);
  }
  console.log(`checked ${String(report.combinations.length)} combinations in ${String(report.seconds)}s`);
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(`FAIL    ${failure}`);
    return 1;
  }
  console.log('every rule passed');
  return 0;
}

// `main().then(...)` rather than top-level `await`: the shape every entry
// point in this repository uses, because `bun build --compile --bytecode`
// rejects a top-level await and nobody should have to remember which files are
// exempt.
if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
