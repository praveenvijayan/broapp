#!/usr/bin/env bun
/**
 * Build the GitHub Pages site from the documentation in this repository.
 *
 * The site is generated from `docs/*.md` and `README.md` rather than written
 * separately, so it cannot drift from what the repository says. The Markdown
 * renderer is small and deliberate: a documentation site whose build pulls a
 * toolchain is a documentation site that eventually stops building.
 *
 *   bun run scripts/build-site.ts   →  site/dist/
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site', 'dist');

/** One page in the site. */
interface Page {
  /** Output filename. */
  readonly slug: string;
  readonly title: string;
  /** Repository-relative Markdown source. */
  readonly source: string;
  /** Section in the sidebar. */
  readonly group: string;
}

const PAGES: readonly Page[] = [
  { slug: 'index.html', title: 'Broapp', source: 'README.md', group: 'Start' },
  { slug: 'architecture.html', title: 'Architecture', source: 'docs/architecture.md', group: 'Start' },
  { slug: 'security.html', title: 'Security model', source: 'docs/security.md', group: 'Start' },

  { slug: 'host-operations.html', title: 'Adding an operation', source: 'docs/host-operations.md', group: 'Guides' },
  { slug: 'streaming.html', title: 'Streaming and cancellation', source: 'docs/streaming.md', group: 'Guides' },
  { slug: 'development.html', title: 'Development workflow', source: 'docs/development.md', group: 'Guides' },
  { slug: 'lifecycle.html', title: 'Lifecycle', source: 'docs/lifecycle.md', group: 'Guides' },
  { slug: 'packaging.html', title: 'Packaging and release', source: 'docs/packaging.md', group: 'Guides' },
  { slug: 'ai.html', title: 'AI layer', source: 'docs/ai.md', group: 'Guides' },

  { slug: 'comparison.html', title: 'How this compares', source: 'docs/comparison.md', group: 'Reference' },
  { slug: 'troubleshooting.html', title: 'Troubleshooting', source: 'docs/troubleshooting.md', group: 'Reference' },
  { slug: 'limitations.html', title: 'Scope and limitations', source: 'docs/limitations.md', group: 'Reference' },
  { slug: 'publishing.html', title: 'Publishing', source: 'docs/publishing.md', group: 'Reference' },
  { slug: 'contributing.html', title: 'Contributing', source: 'CONTRIBUTING.md', group: 'Reference' },
];

const REPO = 'https://github.com/praveenvijayan/broapp';

/**
 * Repository directories whose files are copied into the site as-is, so a
 * Markdown image that points at them keeps working after the rewrite.
 */
const ASSET_DIRS = ['diagrams'] as const;

/** Rewrite a repository-relative link to its place in the site. */
function rewriteLink(href: string): string {
  if (/^(?:https?:|mailto:|#)/.test(href)) return href;

  const clean = href.replace(/^\.\//, '').replace(/^\.\.\//, '');
  const page = PAGES.find(
    (candidate) => candidate.source === clean || candidate.source === `docs/${clean}`,
  );
  if (page !== undefined) return page.slug;

  if (ASSET_DIRS.some((dir) => clean.startsWith(`${dir}/`))) return clean;

  // Anything else — an example README, a source file — points at the
  // repository, which is where it actually lives.
  return `${REPO}/blob/main/${clean}`;
}

/* -------------------------------------------------------------------------- */
/*  Markdown                                                                    */
/* -------------------------------------------------------------------------- */

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Slug for a heading, so in-page links can target it. */
function anchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * A placeholder for an extracted code span.
 *
 * Taken from the Unicode private use area, so it cannot occur in real
 * documentation text and cannot collide with anything the escaping produces.
 */
const CODE_MARK = '';

/** Inline formatting: code spans, images, links, bold, italic — in that order. */
function inline(text: string): string {
  const codes: string[] = [];

  // Code spans come out first and go back last, so formatting characters
  // inside them are never interpreted.
  let work = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_MARK}${String(codes.length - 1)}${CODE_MARK}`;
  });

  work = escapeHtml(work);

  work = work.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, src: string) => {
    return `<img src="${escapeHtml(rewriteLink(src))}" alt="${alt}" loading="lazy">`;
  });
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const target = rewriteLink(href);
    const external = /^https?:/.test(target);
    return `<a href="${escapeHtml(target)}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  work = work.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return work.replace(
    new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'),
    (_match, index: string) => codes[Number(index)] ?? '',
  );
}

interface Rendered {
  readonly html: string;
  readonly headings: { readonly level: number; readonly text: string; readonly id: string }[];
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

function renderMarkdown(markdown: string): Rendered {
  const lines = markdown.split('\n');
  const parts: string[] = [];
  const headings: { level: number; text: string; id: string }[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // Fenced code.
    const fence = /^```(\w*)/.exec(line);
    if (fence !== null) {
      const language = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      parts.push(
        `<pre class="code"${language === '' ? '' : ` data-language="${escapeHtml(language)}"`}><code>${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // Heading.
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length;
      const text = heading[2] ?? '';
      headings.push({ level, text, id: anchor(text) });
      parts.push(`<h${String(level)} id="${anchor(text)}">${inline(text)}</h${String(level)}>`);
      index += 1;
      continue;
    }

    // An image on a line of its own is a figure, not a paragraph.
    const image = IMAGE_LINE.exec(line);
    if (image !== null) {
      const alt = escapeHtml(image[1] ?? '');
      const src = escapeHtml(rewriteLink(image[2] ?? ''));
      parts.push(`<figure class="figure"><img src="${src}" alt="${alt}"></figure>`);
      index += 1;
      continue;
    }

    // Blockquote.
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      parts.push(`<blockquote>${renderMarkdown(body.join('\n')).html}</blockquote>`);
      continue;
    }

    // Table: a row followed by a separator row.
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1] ?? '')) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('');
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
        .join('');
      parts.push(
        `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      );
      continue;
    }

    // Lists.
    const isOrdered = /^\s*\d+\.\s/.test(line);
    if (isOrdered || /^\s*[-*]\s/.test(line)) {
      const pattern = isOrdered ? /^(\s*)\d+\.\s+(.*)$/ : /^(\s*)[-*]\s+(.*)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index] ?? '');
        if (match === null) break;
        items.push(match[2] ?? '');
        index += 1;
        // A single blank line between items keeps the list going; two end it.
        if ((lines[index] ?? '').trim() === '' && pattern.test(lines[index + 1] ?? '')) index += 1;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      parts.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // Horizontal rule.
    if (/^---+$/.test(line.trim())) {
      parts.push('<hr>');
      index += 1;
      continue;
    }

    // Paragraph: everything up to the next block-level thing.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        current.startsWith('#') ||
        current.startsWith('```') ||
        current.startsWith('>') ||
        IMAGE_LINE.test(current) ||
        /^\s*([-*]|\d+\.)\s/.test(current) ||
        /^---+$/.test(current.trim())
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    if (paragraph.length > 0) parts.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return { html: parts.join('\n'), headings };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/* -------------------------------------------------------------------------- */
/*  Page shell                                                                  */
/* -------------------------------------------------------------------------- */

const GROUPS = [...new Set(PAGES.map((page) => page.group))];

function nav(current: Page): string {
  return GROUPS.map((group) => {
    const items = PAGES.filter((page) => page.group === group)
      .map((page) => {
        const here = page.slug === current.slug ? ' aria-current="page"' : '';
        return `<li><a href="${page.slug}"${here}>${escapeHtml(page.title)}</a></li>`;
      })
      .join('');
    return `<div class="nav__group"><h2 class="nav__heading">${escapeHtml(group)}</h2><ul class="nav__list">${items}</ul></div>`;
  }).join('');
}

function footerColumns(): string {
  return GROUPS.map((group) => {
    const items = PAGES.filter((page) => page.group === group)
      .map((page) => `<li><a href="${page.slug}">${escapeHtml(page.title)}</a></li>`)
      .join('');
    return `<div class="footer__col"><h2 class="footer__heading">${escapeHtml(group)}</h2><ul>${items}</ul></div>`;
  }).join('');
}

/**
 * The home page opens on a declaration, then the README continues underneath.
 *
 * The lead paragraph, the install snippet and the figure are lifted out of the
 * rendered README so the hero is still generated from the repository's own
 * words rather than copied into this script.
 */
function homeHero(body: string): { hero: string; rest: string } {
  let rest = body;
  const take = (pattern: RegExp): string => {
    const match = pattern.exec(rest);
    if (match === null) return '';
    rest = rest.replace(match[0], '');
    return match[0];
  };

  take(/<h1[^>]*>[\s\S]*?<\/h1>\n?/);
  const lead = take(/<p>[\s\S]*?<\/p>\n?/).replace(/<\/?strong>/g, '');
  const snippet = take(/<pre class="code"[^>]*>[\s\S]*?<\/pre>\n?/);
  const figure = take(/<figure class="figure">[\s\S]*?<\/figure>\n?/);

  const hero = `
<section class="hero">
  <p class="eyebrow">Local applications · Bun + browser + Brobridge</p>
  <h1 class="hero__title">One process.<br>One tab.<br>One file.</h1>
  <div class="hero__lead">${lead}</div>
  <div class="hero__actions">
    <a class="button" href="architecture.html">Read the architecture</a>
    <a class="textlink" href="${REPO}" rel="noopener">View on GitHub</a>
  </div>
</section>
<section class="media" aria-label="Overview">
  <div class="card card--dark">
    <p class="card__label">How a request travels</p>
    ${figure.replace('<figure class="figure">', '<figure class="figure figure--card">')}
  </div>
  <div class="card card--stone">
    <p class="card__label">Start</p>
    ${snippet}
    <p class="card__note">You get a working application: a typed call to the host, a cancellable
    progress stream, honest connection states, and a build that produces one executable.</p>
  </div>
</section>`;

  return { hero, rest: rest.replace(/^\n+/, '') };
}

/**
 * The home page's "What Broapp contributes" section becomes a dark feature
 * band: each list item is a capability card, with its bold lead as the title.
 *
 * Keyed on the heading's id so the README stays the source of the words. If
 * the heading is renamed the section simply renders as ordinary prose.
 */
function contributionBand(body: string): { before: string; band: string; after: string } {
  const pattern =
    /<h2 id="what-broapp-contributes">([\s\S]*?)<\/h2>\n<p>([\s\S]*?)<\/p>\n<ul>([\s\S]*?)<\/ul>\n<p>([\s\S]*?)<\/p>/;
  const match = pattern.exec(body);
  if (match === null) return { before: body, band: '', after: '' };
  const [whole, heading = '', lead = '', list = '', note = ''] = match;

  const cards = list.replace(
    /<li><strong>([^<]*?)\.?<\/strong>\s*([\s\S]*?)<\/li>/g,
    (_item, title: string, text: string) =>
      `<li class="capability"><h3 class="capability__title">${title}</h3><p class="capability__text">${text}</p></li>`,
  );

  const band = `<section class="band-wrap" id="what-broapp-contributes">
  <div class="band" aria-labelledby="band-title">
    <p class="eyebrow eyebrow--coral">${heading}</p>
    <h2 class="band__title" id="band-title">${lead}</h2>
    <ul class="band__grid">${cards}</ul>
    <p class="band__note">${note}</p>
  </div>
</section>`;

  const at = body.indexOf(whole);
  return {
    before: body.slice(0, at).trimEnd(),
    band,
    after: body.slice(at + whole.length).replace(/^\n+/, ''),
  };
}

function shell(page: Page, body: string, headings: Rendered['headings']): string {
  const home = page.slug === 'index.html';
  const onThisPage = headings
    .filter((heading) => heading.level === 2)
    .map((heading) => `<li><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
    .join('');

  const title = home ? 'Broapp' : `${page.title} · Broapp`;
  const toc =
    onThisPage === '' || home
      ? ''
      : `<nav class="toc" aria-label="On this page"><h2 class="toc__heading">On this page</h2><ul class="toc__list">${onThisPage}</ul></nav>`;

  let hero = '';
  let article = body;
  let band = '';
  let after = '';
  if (home) {
    const split = homeHero(body);
    hero = split.hero;
    const sections = contributionBand(split.rest);
    article = sections.before;
    band = sections.band;
    after = sections.after;
  }
  const layoutClass = home ? 'layout layout--home' : 'layout';
  const tail =
    after === ''
      ? ''
      : `<div class="${layoutClass} layout--continued"><main class="main"><article class="prose">${after}</article></main></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Scaffold a local application: a Bun process that serves a browser UI over an authenticated loopback connection, and compiles to one executable.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Space+Grotesk:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head>
<body class="${home ? 'is-home' : 'is-doc'}">
<a class="skip" href="#main">Skip to content</a>

<div class="announce">
  <p>Version 0.1.0 · Published to npm. Scaffold with <code>bun create broapp my-app</code>.
  <a href="https://www.npmjs.com/package/create-broapp" rel="noopener">View on npm</a></p>
</div>

<header class="topbar">
  <a class="topbar__brand" href="index.html">Broapp</a>
  <nav class="topbar__menu" aria-label="Primary">
    <a href="architecture.html">Architecture</a>
    <a href="security.html">Security</a>
    <a href="host-operations.html">Guides</a>
    <a href="comparison.html">Reference</a>
  </nav>
  <div class="topbar__actions">
    <a class="button button--small" href="${REPO}" rel="noopener">GitHub</a>
    <button class="topbar__toggle" type="button" aria-expanded="false" aria-controls="sidebar">Menu</button>
  </div>
</header>

${hero}

<div class="${layoutClass}">
  <nav class="sidebar" id="sidebar" aria-label="Documentation">${nav(page)}</nav>

  <main class="main" id="main">
    <article class="prose">${article}</article>
    ${band === '' ? `<p class="edit"><a href="${REPO}/blob/main/${page.source}" rel="noopener">Edit this page on GitHub</a></p>` : ''}
  </main>

  ${toc}
</div>

${band}
${tail}
${band === '' ? '' : `<div class="${layoutClass} layout--edit"><main class="main"><p class="edit"><a href="${REPO}/blob/main/${page.source}" rel="noopener">Edit this page on GitHub</a></p></main></div>`}

<footer class="footer">
  <div class="footer__inner">
    <div class="footer__brand">
      <p class="eyebrow eyebrow--coral">Broapp</p>
      <p class="footer__claim">A Bun process, a browser tab, one executable.</p>
      <p class="footer__legal">MIT licensed. Transport, authentication and streaming are
      <a href="https://github.com/praveenvijayan/brobridge" rel="noopener">Brobridge</a>, used unchanged.</p>
    </div>
    ${footerColumns()}
  </div>
</footer>

<script>
  // The only script on the site: one button, for narrow screens.
  var toggle = document.querySelector('.topbar__toggle');
  var sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', function () {
      var open = sidebar.classList.toggle('sidebar--open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }
</script>
</body>
</html>
`;
}

/*
 * Design tokens follow a restrained editorial system: a white canvas, one
 * near-black primary, a deep green product band, warm stone surfaces, coral as
 * a small warm accent, and a display / body type split. Surfaces are flat;
 * depth is borders and surface alternation, never shadows.
 */
const STYLES = `
:root {
  color-scheme: light;
  --primary: #17171c;
  --black: #000000;
  --ink: #212121;
  --deep-green: #003c33;
  --canvas: #ffffff;
  --stone: #eeece7;
  --pale-green: #edfce9;
  --pale-blue: #f1f5ff;
  --hairline: #d9d9dd;
  --border-light: #e5e7eb;
  --card-border: #f2f2f2;
  --muted: #93939f;
  --slate: #75758a;
  --body-muted: #616161;
  --blue: #1863dc;
  --focus: #4c6ee6;
  --coral: #ff7759;
  --on-dark: #ffffff;

  --display: "Space Grotesk", "CohereText", Inter, ui-sans-serif, system-ui, sans-serif;
  --body: Inter, "Unica77 Cohere Web", Arial, ui-sans-serif, system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  --r-xs: 4px; --r-sm: 8px; --r-md: 16px; --r-lg: 22px; --r-pill: 32px;
  --measure: 44rem;
  --wide: 84rem;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: var(--body);
  font-size: 16px;
  line-height: 1.5;
  font-feature-settings: "ss01", "cv11";
}
a { color: var(--blue); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--ink); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r-xs); }
img { max-width: 100%; height: auto; display: block; }

.skip { position: absolute; left: -9999px; padding: 0.6rem 1rem; background: var(--primary); color: var(--on-dark); z-index: 20; }
.skip:focus { left: 0.5rem; top: 0.5rem; }

/* ---- eyebrow: uppercase mono label ---------------------------------- */
.eyebrow {
  margin: 0 0 1rem;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.28px;
  text-transform: uppercase;
  color: var(--slate);
}
.eyebrow--coral { color: var(--coral); }

/* ---- buttons --------------------------------------------------------- */
.button {
  display: inline-block;
  padding: 12px 24px;
  background: var(--primary);
  color: var(--on-dark);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.71;
  text-decoration: none;
  border-radius: var(--r-pill);
  border: 1px solid var(--primary);
}
.button:hover { background: var(--black); color: var(--on-dark); }
.button--small { padding: 6px 14px; }
.textlink { color: var(--ink); font-size: 16px; text-decoration-color: var(--hairline); }
.textlink:hover { text-decoration-color: var(--ink); }

/* ---- announcement bar ----------------------------------------------- */
.announce {
  min-height: 36px;
  display: flex; align-items: center; justify-content: center;
  padding: 0 1.25rem;
  background: var(--black);
  color: var(--on-dark);
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
}
.announce p { margin: 0.55rem 0; }
.announce a { color: var(--on-dark); }
.announce code { background: rgba(255,255,255,0.12); color: var(--on-dark); }

/* ---- topbar: brand left, menu centre, action right ------------------ */
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 1rem;
  padding: 0.85rem 2rem;
  background: var(--canvas);
  border-bottom: 1px solid var(--hairline);
}
.topbar__brand { font-family: var(--display); font-size: 20px; font-weight: 500; letter-spacing: -0.4px; color: var(--ink); text-decoration: none; }
.topbar__menu { display: flex; gap: 1.75rem; justify-content: center; }
.topbar__menu a { color: var(--ink); font-size: 14px; text-decoration: none; }
.topbar__menu a:hover { text-decoration: underline; text-underline-offset: 4px; }
.topbar__actions { display: flex; justify-content: flex-end; align-items: center; gap: 0.75rem; }
.topbar__toggle {
  display: none;
  padding: 6px 12px; font: inherit; font-size: 14px; font-weight: 500;
  background: transparent; color: var(--primary);
  border: 1px solid var(--primary); border-radius: 30px; cursor: pointer;
}

/* ---- home hero -------------------------------------------------------- */
.hero {
  max-width: var(--wide);
  margin: 0 auto;
  padding: 80px 2rem 48px;
}
.hero__title {
  margin: 0 0 32px;
  font-family: var(--display);
  font-weight: 400;
  font-size: clamp(48px, 8vw, 96px);
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.hero__lead { max-width: 40rem; font-size: 18px; line-height: 1.4; color: var(--body-muted); }
.hero__lead p { margin: 0; }
.hero__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; margin-top: 32px; }

/* the two-card media composition under the declaration */
.media {
  max-width: var(--wide);
  margin: 0 auto;
  padding: 0 2rem 80px;
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 24px;
  align-items: stretch;
}
.card { border-radius: var(--r-lg); padding: 32px; border: 1px solid var(--card-border); }
.card--dark { background: var(--primary); color: var(--on-dark); border-color: var(--primary); }
.card--stone { background: var(--stone); color: var(--ink); border-color: var(--stone); display: flex; flex-direction: column; }
.card__label {
  margin: 0 0 20px;
  font-family: var(--mono); font-size: 12px; letter-spacing: 0.28px; text-transform: uppercase;
  color: inherit; opacity: 0.7;
}
.card--stone .code { margin: 0; background: var(--canvas); border-color: var(--canvas); }
.card__note { margin: 24px 0 0; font-size: 14px; line-height: 1.5; color: var(--body-muted); }
.figure { margin: 0 0 1.5rem; }
.figure img { width: 100%; border-radius: var(--r-sm); }
.figure--card { margin: 0; }
.figure--card img { border-radius: var(--r-sm); }

/* ---- dark feature band (home) ---------------------------------------- */
.band-wrap { max-width: var(--wide); margin: 0 auto; padding: 16px 2rem; }
.band {
  padding: 80px;
  background: var(--deep-green);
  color: var(--on-dark);
  border-radius: var(--r-lg);
}
.band .eyebrow { margin-bottom: 24px; }
.band__title {
  margin: 0 0 48px !important;
  padding: 0 !important;
  border: 0 !important;
  max-width: 30rem;
  font-family: var(--display);
  font-size: 48px !important;
  font-weight: 400;
  line-height: 1.2;
  letter-spacing: -0.48px;
  color: var(--on-dark);
}
.band__grid {
  list-style: none;
  margin: 0 0 48px !important;
  padding: 0 !important;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.capability {
  margin: 0 !important;
  padding: 24px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: var(--r-sm);
}
.capability__title { margin: 0 0 12px !important; font-family: var(--display); font-size: 24px !important; font-weight: 400; line-height: 1.3; color: var(--on-dark); }
.capability__text { margin: 0 !important; font-size: 15px; line-height: 1.5; color: rgba(255, 255, 255, 0.78); }
.capability__text code, .band__note code { background: rgba(255, 255, 255, 0.12); color: var(--on-dark); }
.band__note { margin: 0 !important; max-width: 40rem; font-size: 16px; line-height: 1.5; color: rgba(255, 255, 255, 0.78); }
.band__note a { color: var(--on-dark); }

/* ---- documentation layout ------------------------------------------ */
.layout {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr) 13rem;
  gap: 3rem;
  max-width: var(--wide);
  margin: 0 auto;
  padding: 48px 2rem 96px;
  align-items: start;
}
.layout--home { grid-template-columns: minmax(0, 1fr); padding-top: 0; border-top: 1px solid var(--hairline); }
.layout--home .sidebar, .layout--home .toc { display: none; }
.layout--home .main { width: 100%; max-width: var(--measure); margin: 0 auto; padding-top: 64px; }
.layout--continued { border-top: 0; padding-bottom: 0; }
.layout--continued .main { padding-top: 0; }
.layout--continued .prose h2:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.layout--edit { border-top: 0; padding-top: 0; }
.layout--edit .main { padding-top: 0; }

.sidebar { position: sticky; top: 4.6rem; font-size: 14px; }
.nav__group + .nav__group { margin-top: 1.75rem; }
.nav__heading { margin: 0 0 0.5rem; font-family: var(--mono); font-size: 12px; font-weight: 400; letter-spacing: 0.28px; text-transform: uppercase; color: var(--slate); }
.nav__list { list-style: none; margin: 0; padding: 0; }
.nav__list li { margin: 0; }
.nav__list a { display: block; padding: 6px 12px; margin-left: -12px; border-radius: 30px; color: var(--body-muted); text-decoration: none; }
.nav__list a:hover { color: var(--ink); background: var(--stone); }
.nav__list a[aria-current="page"] { color: var(--deep-green); background: var(--pale-green); }

.toc { position: sticky; top: 4.6rem; font-size: 14px; }
.toc__heading { margin: 0 0 0.5rem; font-family: var(--mono); font-size: 12px; font-weight: 400; letter-spacing: 0.28px; text-transform: uppercase; color: var(--slate); }
.toc__list { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--hairline); }
.toc__list a { display: block; padding: 4px 0 4px 12px; color: var(--body-muted); text-decoration: none; }
.toc__list a:hover { color: var(--ink); }

.main { min-width: 0; }
.prose { max-width: var(--measure); }
.prose h1 { margin: 0 0 1.5rem; font-family: var(--display); font-size: 48px; font-weight: 400; line-height: 1.2; letter-spacing: -0.48px; }
.prose h2 { margin: 3.5rem 0 1rem; padding-top: 1.5rem; border-top: 1px solid var(--hairline); font-family: var(--display); font-size: 32px; font-weight: 400; line-height: 1.2; letter-spacing: -0.32px; }
.prose h3 { margin: 2.25rem 0 0.75rem; font-family: var(--display); font-size: 24px; font-weight: 400; line-height: 1.3; }
.prose h4 { margin: 1.75rem 0 0.5rem; font-family: var(--mono); font-size: 14px; font-weight: 400; letter-spacing: 0.28px; text-transform: uppercase; color: var(--slate); }
.prose p { margin: 0 0 1.1rem; }
.prose ul, .prose ol { margin: 0 0 1.1rem; padding-left: 1.4rem; }
.prose li { margin: 0.35rem 0; }
.prose li::marker { color: var(--muted); }
.prose hr { margin: 3rem 0; border: 0; border-top: 1px solid var(--hairline); }
.prose blockquote { margin: 0 0 1.1rem; padding: 16px 24px; background: var(--pale-blue); border-radius: var(--r-sm); color: var(--ink); }
.prose blockquote p:last-child { margin-bottom: 0; }
.prose strong { font-weight: 500; }

code { font-family: var(--mono); font-size: 0.875em; background: var(--stone); padding: 0.1em 0.4em; border-radius: var(--r-xs); }
.code { margin: 0 0 1.5rem; padding: 16px 20px; background: var(--stone); border: 1px solid var(--stone); border-radius: var(--r-sm); overflow-x: auto; font-size: 14px; line-height: 1.6; }
.code code { background: none; padding: 0; font-size: inherit; }

.table-scroll { overflow-x: auto; margin: 0 0 1.5rem; }
table { border-collapse: collapse; width: 100%; font-size: 15px; }
th, td { padding: 12px 12px 12px 0; text-align: left; border-bottom: 1px solid var(--hairline); vertical-align: top; }
th { font-family: var(--mono); font-weight: 400; color: var(--slate); font-size: 12px; text-transform: uppercase; letter-spacing: 0.28px; }

.edit { max-width: var(--measure); margin: 3rem 0 0; font-size: 14px; color: var(--muted); }
.edit a { color: var(--slate); }

/* ---- footer: dark band ------------------------------------------------ */
.footer { background: var(--primary); color: var(--on-dark); }
.footer__inner {
  max-width: var(--wide);
  margin: 0 auto;
  padding: 64px 2rem 48px;
  display: grid;
  grid-template-columns: 2fr repeat(3, 1fr);
  gap: 32px;
}
.footer__claim { margin: 0 0 16px; font-family: var(--display); font-size: 24px; line-height: 1.3; letter-spacing: -0.24px; max-width: 22rem; }
.footer__legal { margin: 0; font-size: 12px; line-height: 1.4; color: var(--muted); max-width: 22rem; }
.footer__legal a { color: var(--on-dark); }
.footer__heading { margin: 0 0 12px; font-family: var(--mono); font-size: 12px; font-weight: 400; letter-spacing: 0.28px; text-transform: uppercase; color: var(--on-dark); }
.footer__col ul { list-style: none; margin: 0; padding: 0; }
.footer__col li { margin: 0 0 6px; }
.footer__col a { color: var(--muted); font-size: 14px; text-decoration: none; }
.footer__col a:hover { color: var(--on-dark); text-decoration: underline; }

/* ---- responsive -------------------------------------------------------- */
@media (max-width: 68rem) {
  .layout { grid-template-columns: 14rem minmax(0, 1fr); }
  .toc { display: none; }
  .footer__inner { grid-template-columns: 1fr 1fr; }
  .band { padding: 48px; }
  .band__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 48rem) {
  .topbar { grid-template-columns: 1fr auto; padding: 0.75rem 1.25rem; }
  .topbar__menu { display: none; }
  .topbar__toggle { display: inline-block; }
  .hero { padding: 48px 1.25rem 32px; }
  .hero__title { font-size: clamp(40px, 12vw, 64px); }
  .media { grid-template-columns: minmax(0, 1fr); padding: 0 1.25rem 48px; }
  .card { padding: 24px; }
  .layout { grid-template-columns: minmax(0, 1fr); gap: 0; padding: 24px 1.25rem 64px; }
  .sidebar { display: none; position: static; margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--hairline); }
  .sidebar--open { display: block; }
  .prose h1 { font-size: 32px; }
  .prose h2 { font-size: 24px; }
  .footer__inner { grid-template-columns: 1fr; padding: 48px 1.25rem 32px; }
  .band-wrap { padding: 8px 1.25rem; }
  .band { padding: 32px 24px; }
  .band__title { font-size: 32px !important; }
  .band__grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
`;

/* -------------------------------------------------------------------------- */

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const page of PAGES) {
  const markdown = await readFile(join(root, page.source), 'utf8');
  const rendered = renderMarkdown(markdown);
  await writeFile(join(out, page.slug), shell(page, rendered.html, rendered.headings), 'utf8');
  console.log(`  ${page.slug.padEnd(28)} <- ${page.source}`);
}

for (const dir of ASSET_DIRS) {
  await mkdir(join(out, dir), { recursive: true });
  for (const name of await readdir(join(root, dir))) {
    if (!name.endsWith('.svg')) continue;
    await copyFile(join(root, dir, name), join(out, dir, name));
    console.log(`  ${`${dir}/${name}`.padEnd(28)} <- ${dir}/${name}`);
  }
}

// Tells GitHub Pages not to run the output through Jekyll, which would ignore
// files and directories beginning with an underscore.
await writeFile(join(out, '.nojekyll'), '', 'utf8');

const built = await readdir(out);
console.log(`\n${String(built.length)} files in site/dist`);
