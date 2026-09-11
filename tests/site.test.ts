import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import manifest from '../package.json' with { type: 'json' };
import { rewriteLink } from '../scripts/build-site.ts';

const root = resolve(import.meta.dir, '..');

// One build serves every test: the site is a pure function of the repository,
// and it goes to a temporary directory so a `site/dist` in use is left alone.
let out = '';

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'broapp-site-'));
  const result = Bun.spawnSync(['bun', 'run', 'scripts/build-site.ts', '--out', out], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(`site build failed: ${result.stderr.toString()}`);
});

afterAll(() => {
  if (out !== '') rmSync(out, { recursive: true, force: true });
});

function page(name: string): string {
  return readFileSync(join(out, name), 'utf8');
}

function pages(): string[] {
  return readdirSync(out).filter((name) => name.endsWith('.html'));
}

/** The header's primary menu, as `[label, href, current]` triples. */
function headerMenu(html: string): { label: string; href: string; current: boolean }[] {
  const nav = /<nav class="topbar__menu"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
  return [...nav.matchAll(/<a href="([^"]+)"( aria-current="true")?>([^<]+)<\/a>/g)].map((match) => ({
    href: match[1] ?? '',
    current: match[2] !== undefined,
    label: match[3] ?? '',
  }));
}

describe('the header menu', () => {
  test('is Guides, Reference and Autoapp, in that order, and no title repeats the group', () => {
    expect(headerMenu(page('index.html')).map((link) => [link.label, link.href])).toEqual([
      ['Guides', 'host-operations.html'],
      ['Reference', 'comparison.html'],
      ['Autoapp', 'autoapp.html'],
    ]);

    for (const name of pages()) {
      const html = page(name);
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
      expect(title).not.toContain('Autoapp:');
      // Sidebar and footer labels are the page titles too.
      const labels = [...html.matchAll(/<li><a href="[^"]+"(?: aria-current="page")?>([^<]*)<\/a><\/li>/g)];
      for (const label of labels) expect(label[1] ?? '').not.toMatch(/^Autoapp:/);
    }
  });

  test('marks the current page’s group, and only that group', () => {
    for (const name of pages()) {
      const html = page(name);
      const sidebar = /<nav class="sidebar"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
      const group = [...sidebar.matchAll(/<div class="nav__group"><h2 class="nav__heading">([^<]+)<\/h2>(.*?)<\/div>/g)]
        .find((match) => (match[2] ?? '').includes('aria-current="page"'))?.[1];
      expect(group).toBeDefined();

      const current = headerMenu(html).filter((link) => link.current).map((link) => link.label);
      // Start has no tab; the brand link is its home.
      expect(current).toEqual(group === 'Start' ? [] : [group ?? '']);
    }
  });
});

describe('the Autoapp landing page', () => {
  test('carries the architecture diagram, with the diagram’s own description as its alt text', () => {
    const svg = readFileSync(join(root, 'diagrams', 'autoapp-architecture.svg'), 'utf8');
    const desc = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(svg)?.[1] ?? '';
    expect(desc.length).toBeGreaterThan(0);

    const image = /<img src="([^"]+)" alt="([^"]*)"/.exec(page('autoapp.html'));
    expect(image?.[1]).toBe('diagrams/autoapp-architecture.svg');
    expect(image?.[2]).toBe(desc);
    expect(existsSync(join(out, 'diagrams', 'autoapp-architecture.svg'))).toBe(true);
  });

  test('copies its commands from the README, so the two cannot drift', () => {
    const landing = readFileSync(join(root, 'docs', 'autoapp', 'README.md'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const blocks = [...landing.matchAll(/^```\w*\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? '');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(readme).toContain(block);
  });

  test('lists the section’s five pages in reading order', () => {
    // The renderer has no continuation lines in list items, so a wrapped item
    // would come out as five one-item lists and loose paragraphs.
    const list = /<h2 id="read-next">Read next<\/h2>\n<ol>([\s\S]*?)<\/ol>/.exec(page('autoapp.html'))?.[1] ?? '';
    expect([...list.matchAll(/<li><a href="([^"]+)">/g)].map((match) => match[1])).toEqual([
      'autoapp-design.html',
      'autoapp-learning.html',
      'autoapp-security.html',
      'autoapp-packaging.html',
      'autoapp-backlog.html',
    ]);
  });

  test('is under 60 lines', () => {
    const landing = readFileSync(join(root, 'docs', 'autoapp', 'README.md'), 'utf8');
    expect(landing.trimEnd().split('\n').length).toBeLessThan(60);
  });
});

describe('links', () => {
  test('into the Autoapp design resolve to its new page, not to GitHub', () => {
    expect(existsSync(join(out, 'autoapp-design.html'))).toBe(true);
    for (const name of ['architecture.html', 'limitations.html']) {
      const html = page(name);
      expect(html).toContain('href="autoapp-design.html"');
      expect(html).not.toContain('blob/main/docs/autoapp/design.md"');
    }
    // The README's launcher card now opens the landing page.
    expect(page('index.html')).toContain('<a href="autoapp.html">Autoapp</a>');
  });

  test('resolve from the document that wrote them before any flatter form', () => {
    // `README.md` from `docs/autoapp/` is the landing page, not the home page.
    expect(page('autoapp-design.html')).toContain('<a href="autoapp.html">Autoapp overview</a>');
    // `packaging.md` from `docs/autoapp/` is the Autoapp page, not the core guide.
    expect(rewriteLink('packaging.md', 'docs/autoapp')).toBe('autoapp-packaging.html');
    expect(rewriteLink('packaging.md', 'docs')).toBe('packaging.html');
    expect(rewriteLink('docs/packaging.md', '.')).toBe('packaging.html');
  });

  test('from a nested document reach the diagrams directory', () => {
    expect(rewriteLink('../../diagrams/x.svg', 'docs/autoapp')).toBe('diagrams/x.svg');
    expect(rewriteLink('../diagrams/x.svg', 'docs')).toBe('diagrams/x.svg');
    expect(rewriteLink('diagrams/x.svg', '.')).toBe('diagrams/x.svg');
  });
});

test('the banner reads the version from the manifest', () => {
  for (const name of pages()) {
    expect(page(name)).toContain(`Version ${manifest.version} · Published to npm.`);
  }
});
