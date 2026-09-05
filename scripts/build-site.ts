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
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

  { slug: 'comparison.html', title: 'How this compares', source: 'docs/comparison.md', group: 'Reference' },
  { slug: 'troubleshooting.html', title: 'Troubleshooting', source: 'docs/troubleshooting.md', group: 'Reference' },
  { slug: 'limitations.html', title: 'Scope and limitations', source: 'docs/limitations.md', group: 'Reference' },
  { slug: 'upstream-blockers.html', title: 'Upstream blockers', source: 'docs/upstream-blockers.md', group: 'Reference' },
  { slug: 'publishing.html', title: 'Publishing', source: 'docs/publishing.md', group: 'Reference' },
  { slug: 'contributing.html', title: 'Contributing', source: 'CONTRIBUTING.md', group: 'Reference' },
];

const REPO = 'https://github.com/praveenvijayan/broapp';

/** Rewrite a repository-relative link to its place in the site. */
function rewriteLink(href: string): string {
  if (/^(?:https?:|mailto:|#)/.test(href)) return href;

  const clean = href.replace(/^\.\//, '').replace(/^\.\.\//, '');
  const page = PAGES.find(
    (candidate) => candidate.source === clean || candidate.source === `docs/${clean}`,
  );
  if (page !== undefined) return page.slug;

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
const CODE_MARK = '';

/** Inline formatting: code spans, links, bold, italic — in that order. */
function inline(text: string): string {
  const codes: string[] = [];

  // Code spans come out first and go back last, so formatting characters
  // inside them are never interpreted.
  let work = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_MARK}${String(codes.length - 1)}${CODE_MARK}`;
  });

  work = escapeHtml(work);

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

function nav(current: Page): string {
  const groups = [...new Set(PAGES.map((page) => page.group))];
  return groups
    .map((group) => {
      const items = PAGES.filter((page) => page.group === group)
        .map((page) => {
          const here = page.slug === current.slug ? ' aria-current="page"' : '';
          return `<li><a href="${page.slug}"${here}>${escapeHtml(page.title)}</a></li>`;
        })
        .join('');
      return `<div class="nav__group"><h2 class="nav__heading">${escapeHtml(group)}</h2><ul class="nav__list">${items}</ul></div>`;
    })
    .join('');
}

function shell(page: Page, body: string, headings: Rendered['headings']): string {
  const onThisPage = headings
    .filter((heading) => heading.level === 2)
    .map((heading) => `<li><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
    .join('');

  const title = page.title === 'Broapp' ? 'Broapp' : `${page.title} · Broapp`;
  const toc =
    onThisPage === ''
      ? ''
      : `<nav class="toc" aria-label="On this page"><h2 class="toc__heading">On this page</h2><ul class="toc__list">${onThisPage}</ul></nav>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Scaffold a local application: a Bun process that serves a browser UI over an authenticated loopback connection, and compiles to one executable.">
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="topbar">
  <a class="topbar__brand" href="index.html">Broapp</a>
  <nav class="topbar__links"><a href="${REPO}" rel="noopener">GitHub</a></nav>
  <button class="topbar__toggle" type="button" aria-expanded="false" aria-controls="sidebar">Menu</button>
</header>

<div class="layout">
  <nav class="sidebar" id="sidebar" aria-label="Documentation">${nav(page)}</nav>

  <main class="main" id="main">
    <article class="prose">${body}</article>
    <footer class="footer">
      <p>Broapp is MIT licensed. Transport, authentication and streaming are
      <a href="https://github.com/praveenvijayan/brobridge" rel="noopener">Brobridge</a>, used unchanged.</p>
      <p><a href="${REPO}/blob/main/${page.source}" rel="noopener">Edit this page on GitHub</a></p>
    </footer>
  </main>

  ${toc}
</div>

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

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa;
  --surface: #ffffff;
  --border: #e4e3e0;
  --text: #1b1a18;
  --muted: #6b6862;
  --accent: #1f5f4f;
  --accent-soft: #eaf3f0;
  --code-bg: #f4f4f2;
  --max: 44rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a;
    --surface: #1c1e22;
    --border: #33363c;
    --text: #eceef1;
    --muted: #a3a8b1;
    --accent: #6fd3b4;
    --accent-soft: #1d2b28;
    --code-bg: #202329;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.62;
  -webkit-text-size-adjust: 100%;
}
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

.skip { position: absolute; left: -9999px; padding: 0.6rem 1rem; background: var(--accent); color: var(--bg); z-index: 10; }
.skip:focus { left: 0.5rem; top: 0.5rem; }

.topbar {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 1rem;
  padding: 0.7rem 1.25rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.topbar__brand { font-weight: 680; font-size: 1.05rem; color: var(--text); text-decoration: none; letter-spacing: -0.01em; }
.topbar__links { margin-left: auto; font-size: 0.92rem; }
.topbar__toggle {
  display: none;
  padding: 0.35rem 0.7rem; font: inherit; font-size: 0.88rem; font-weight: 600;
  background: transparent; color: var(--text);
  border: 1px solid var(--border); border-radius: 7px; cursor: pointer;
}

.layout {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr) 13rem;
  gap: 2.5rem;
  max-width: 78rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 5rem;
  align-items: start;
}

.sidebar { position: sticky; top: 4.2rem; font-size: 0.92rem; }
.nav__group + .nav__group { margin-top: 1.4rem; }
.nav__heading { margin: 0 0 0.45rem; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
.nav__list { list-style: none; margin: 0; padding: 0; }
.nav__list li { margin: 0; }
.nav__list a { display: block; padding: 0.24rem 0.55rem; margin-left: -0.55rem; border-radius: 6px; color: var(--muted); text-decoration: none; }
.nav__list a:hover { color: var(--text); background: var(--code-bg); }
.nav__list a[aria-current="page"] { color: var(--accent); background: var(--accent-soft); font-weight: 620; }

.toc { position: sticky; top: 4.2rem; font-size: 0.86rem; }
.toc__heading { margin: 0 0 0.45rem; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
.toc__list { list-style: none; margin: 0; padding: 0; }
.toc__list a { display: block; padding: 0.16rem 0; color: var(--muted); text-decoration: none; }
.toc__list a:hover { color: var(--accent); }

.main { min-width: 0; }
.prose { max-width: var(--max); }
.prose h1 { margin: 0 0 1.1rem; font-size: 2rem; font-weight: 680; line-height: 1.2; letter-spacing: -0.022em; }
.prose h2 { margin: 2.4rem 0 0.8rem; padding-top: 0.6rem; border-top: 1px solid var(--border); font-size: 1.3rem; font-weight: 660; letter-spacing: -0.012em; }
.prose h3 { margin: 1.8rem 0 0.6rem; font-size: 1.05rem; font-weight: 650; }
.prose h4 { margin: 1.4rem 0 0.5rem; font-size: 0.95rem; font-weight: 650; color: var(--muted); }
.prose p { margin: 0 0 1rem; }
.prose ul, .prose ol { margin: 0 0 1rem; padding-left: 1.35rem; }
.prose li { margin: 0.3rem 0; }
.prose hr { margin: 2.5rem 0; border: 0; border-top: 1px solid var(--border); }
.prose blockquote { margin: 0 0 1rem; padding: 0.15rem 1rem; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 8px 8px 0; }
.prose blockquote p:last-child { margin-bottom: 0; }

code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.875em; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
.code { margin: 0 0 1.2rem; padding: 0.9rem 1rem; background: var(--code-bg); border: 1px solid var(--border); border-radius: 9px; overflow-x: auto; font-size: 0.86rem; line-height: 1.55; }
.code code { background: none; padding: 0; font-size: inherit; }

.table-scroll { overflow-x: auto; margin: 0 0 1.2rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { padding: 0.5rem 0.7rem; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-weight: 650; color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.04em; }

.footer { max-width: var(--max); margin-top: 3.5rem; padding-top: 1.2rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.86rem; }
.footer p { margin: 0 0 0.4rem; }

@media (max-width: 68rem) {
  .layout { grid-template-columns: 14rem minmax(0, 1fr); }
  .toc { display: none; }
}
@media (max-width: 48rem) {
  .topbar__toggle { display: block; }
  .layout { grid-template-columns: minmax(0, 1fr); gap: 0; padding-top: 1.25rem; }
  .sidebar { display: none; position: static; margin-bottom: 1.75rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border); }
  .sidebar--open { display: block; }
  .prose h1 { font-size: 1.65rem; }
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

// Tells GitHub Pages not to run the output through Jekyll, which would ignore
// files and directories beginning with an underscore.
await writeFile(join(out, '.nojekyll'), '', 'utf8');

const built = await readdir(out);
console.log(`\n${String(built.length)} files in site/dist`);
