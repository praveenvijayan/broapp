#!/usr/bin/env bun
/**
 * One page to look at the presets on.
 *
 *   bun run --cwd packages/broapp-autoapp theme-gallery
 *
 * Renders the starter's `views.ts` through the real renderer components with
 * `react-dom/server`, once per preset, light and dark side by side, and writes
 * `.broapp-tmp/theme-gallery.html`. Nothing drives a browser: a person opens the
 * file, reads it, and presses Tab to see the focus rings.
 *
 * `Page` loads its sources over a bridge in an effect, and an effect never runs
 * on the server, so the page's components are drawn here inside a stub page
 * context carrying fixed data instead. The components, their markup and every
 * rule they are styled by are the renderer's own; only the data is invented.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { views } from '../../../templates/autoapp-starter/src/shared/views.ts';
import { ConflictList } from '../src/react/AutoappView.tsx';
import { PageProvider, type PageContextValue, type SourceState } from '../src/react/context.tsx';
import { renderComponent } from '../src/react/Page.tsx';
import type { Component } from '../src/views/types.ts';

// `import.meta.dir` rather than a URL's `pathname`: on Windows the latter is
// `/D:/a/...`, which resolves against the drive again and fails to open.
const packageDir = resolve(import.meta.dir, '..');
const repo = resolve(packageDir, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');

const PRESETS: readonly { readonly id: string; readonly title: string; readonly css: string }[] = [
  { id: 'default', title: 'Default — the starter’s own styles.css', css: '' },
  { id: 'quiet', title: 'Quiet — presets/quiet.css', css: read(packageDir, 'presets', 'quiet.css') },
  { id: 'dense', title: 'Dense — presets/dense.css', css: read(packageDir, 'presets', 'dense.css') },
];

const DARK_MEDIA = '@media (prefers-color-scheme: dark)';

/**
 * Scope a stylesheet that speaks about `:root` to one panel of the gallery.
 *
 * Gallery-only. A real page has one `:root` and asks the machine which scheme
 * it is in; this page shows six panels at once, so each panel stands in for
 * `:root` and the dark blocks apply under `.is-dark` instead of the media
 * query. Specificity is kept: `:where(:root)` stays zero, `:root` becomes one
 * class, so the renderer's defaults still lose to the application's tokens.
 */
function scoped(css: string, scope: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rewrite = (part: string, panel: string): string =>
    part
      .replaceAll(':where(:root)', `:where(${panel})`)
      .replaceAll(':root', panel)
      .replace(/(^|[}\s])body(\s*\{)/g, `$1${panel}$2`)
      .replace(/#root\s*\{[^}]*\}/g, '');
  let out = '';
  let at = 0;
  for (;;) {
    const start = text.indexOf(DARK_MEDIA, at);
    if (start === -1) break;
    const open = text.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      if (text[end] === '}' && --depth === 0) break;
    }
    out += rewrite(text.slice(at, start), scope);
    out += rewrite(text.slice(open + 1, end), `${scope}.is-dark`);
    at = end + 1;
  }
  return out + rewrite(text.slice(at), scope);
}

const NOW = Date.UTC(2026, 8, 12, 9, 30);

const ITEMS = [
  { id: 1, label: 'Renew the parking permit', note: 'The form wants last year’s number.', done: false, nextDone: true, createdAt: NOW - 86_400_000 * 3 },
  { id: 2, label: 'Book the boiler service', note: 'Before the first cold week.', done: true, nextDone: false, createdAt: NOW - 86_400_000 },
  { id: 3, label: 'Return the library books', note: '', done: false, nextDone: true, createdAt: NOW },
];

const loaded = (data: unknown): SourceState => ({ data, error: null, loading: false });

function context(sources: Record<string, SourceState>): PageContextValue {
  return {
    views,
    params: {},
    sources,
    routes: {},
    reload: () => undefined,
    navigate: () => undefined,
    confirm: () => true,
    run: () => Promise.resolve(null),
  };
}

const page = views.pages[0];
if (page === undefined) throw new Error('the starter has no page');
const table = page.children.find((component) => component.kind === 'table');
if (table === undefined) throw new Error('the starter has no table');

/** Components the starter does not use, so every rule is seen. Gallery-only. */
const extras: Component = {
  id: 'gallery-more',
  kind: 'section',
  label: 'The other kinds',
  children: [
    { id: 'gallery-status', kind: 'status', label: 'Done so far', source: 'status', path: 'done' },
    {
      id: 'gallery-links',
      kind: 'table',
      label: 'A table whose cells are links',
      source: 'all',
      rows: 'items',
      columns: [{ id: 'label', header: 'Opens', path: 'label', link: { page: 'items', params: ['id'] } }],
    },
    { id: 'gallery-button', kind: 'button', action: { id: 'refresh', label: 'A button on its own', operation: 'items.status' } },
  ],
};

function panel(preset: string, dark: boolean): string {
  const full = context({ all: loaded({ items: ITEMS }), status: loaded({ count: 3, done: 1 }) });
  const empty = context({ all: loaded({ items: [] }), status: loaded({ count: 0, done: 0 }) });
  const failed = context({
    all: { data: null, error: 'The items could not be loaded: the database is locked.', loading: false },
  });
  const h = React.createElement;
  const markup = renderToStaticMarkup(
    h(
      'div',
      { className: 'autoapp' },
      h(ConflictList, {
        conflicts: [{ componentId: 'items-table', reason: 'the column it hid is no longer there' }],
      }),
      h(
        PageProvider,
        { value: full },
        h(
          'div',
          { className: 'autoapp-page', 'data-autoapp-page': page.id },
          h('h1', { className: 'autoapp-page__title' }, page.title),
          ...page.children.map((component) => renderComponent(component)),
          renderComponent(extras),
        ),
      ),
      h(PageProvider, { value: empty }, renderComponent({ ...table, id: 'gallery-empty', label: 'A table with no rows' })),
      h(PageProvider, { value: failed }, renderComponent({ ...table, id: 'gallery-failed', label: 'A table whose source failed' })),
    ),
  );
  return `<div class="g-${preset}${dark ? ' is-dark' : ''} g-panel" style="color-scheme: ${dark ? 'dark' : 'light'}"><p class="g-scheme">${dark ? 'dark' : 'light'}</p>${markup}</div>`;
}

function main(): number {
  const tokens = read(packageDir, 'src', 'react', 'tokens.css');
  const view = read(packageDir, 'src', 'react', 'view.css');
  const starter = read(repo, 'templates', 'autoapp-starter', 'src', 'ui', 'styles.css');

  const sheets = PRESETS.map(({ id, css }) =>
    [scoped(tokens, `.g-${id}`), scoped(starter, `.g-${id}`), scoped(css, `.g-${id}`)].join('\n'),
  ).join('\n');

  const sections = PRESETS.map(
    ({ id, title }) => `<section class="g-row"><h2 class="g-title">${title}</h2><div class="g-pair">${panel(id, false)}${panel(id, true)}</div></section>`,
  ).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Autoapp theme gallery</title>
<style>
/* The gallery's own frame. */
body { margin: 0; padding: 1.5rem; background: #8a8d93; font: 14px system-ui, sans-serif; }
.g-intro { max-width: 60rem; color: #fff; }
.g-title { margin: 2rem 0 0.75rem; color: #fff; font-size: 1.1rem; }
.g-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.g-panel { border-radius: 6px; }
.g-scheme { margin: 0 0 1rem; font: 600 11px system-ui; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.6; }
</style>
<style>
${view}
${sheets}
</style>
</head>
<body>
<p class="g-intro">Generated by <code>bun run theme-gallery</code>. Each panel is the starter’s page drawn by the renderer, with fixed data, under one preset and one scheme. Press Tab to walk the fields and see the focus rings.</p>
${sections}
</body>
</html>
`;
  const out = join(packageDir, '.broapp-tmp', 'theme-gallery.html');
  mkdirSync(join(packageDir, '.broapp-tmp'), { recursive: true });
  writeFileSync(out, html, 'utf8');
  console.log(`gallery  ${out}  ${String(html.length)} bytes`);
  return 0;
}

if (import.meta.main) process.exit(main());
