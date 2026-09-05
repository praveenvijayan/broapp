/**
 * What the build produces, and what it refuses to produce.
 *
 * The two properties worth defending here are that the browser bundle contains
 * no host code, and that the page loads nothing from off-origin. Both are easy
 * to break by accident with a single import, and neither shows up until
 * somebody is offline or somebody reads the bundle.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildPage } from 'broapp/build';
import { currentTarget, findTarget, TARGETS } from 'broapp/build';

let root = '';

const TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><!--BROAPP_HEAD--></head><body><div id="root"></div><!--BROAPP_BODY--></body></html>`;

beforeAll(async () => {
  // Inside the repository rather than in a temporary directory: the fixtures
  // import `broapp/shared`, and module resolution has to be able to walk up to
  // a node_modules that has it — exactly as a generated project's would.
  root = join(import.meta.dir, '.build-fixture');
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.html'), TEMPLATE, 'utf8');
});

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

async function write(name: string, contents: string): Promise<void> {
  await writeFile(join(root, 'src', name), contents, 'utf8');
}

async function build(entry: string, outFile = 'dist/out.html'): Promise<string> {
  await buildPage({ root, entry: `src/${entry}`, template: 'src/index.html', outFile });
  return readFile(join(root, outFile), 'utf8');
}

describe('buildPage', () => {
  test('inlines script and style into one document', async () => {
    await write('style.css', 'body{color:#123456}');
    await write('ok.ts', `import './style.css';\ndocument.title = 'built';`);
    const html = await build('ok.ts');

    expect(html).toContain('<script type="module">');
    expect(html).toContain('#123456');
    // A second HTTP route does not exist, so a src or href would 404.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  test('pins the inline script with a CSP hash that matches it', async () => {
    await write('hashed.ts', `console.log('hash me');`);
    const html = await build('hashed.ts', 'dist/hashed.html');

    const policy = /content="(default-src[^"]*)"/.exec(html)?.[1];
    expect(policy).toBeDefined();
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');

    const declared = /'sha256-([^']+)'/.exec(policy ?? '')?.[1];
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(declared).toBeDefined();
    expect(script).toBeDefined();

    // Recompute the hash the way a browser would: over the script text as it
    // appears in the document.
    const actual = new Bun.CryptoHasher('sha256').update(script ?? '', 'utf8').digest('base64');
    expect(actual).toBe(declared ?? '');
  });

  test('the policy allows the bridge WebSocket and nothing wider', async () => {
    await write('csp.ts', `console.log(1);`);
    const html = await build('csp.ts', 'dist/csp.html');
    const policy = /content="(default-src[^"]*)"/.exec(html)?.[1] ?? '';

    expect(policy).toContain('ws://127.0.0.1:*');
    // A bare `ws:` would allow any host on the network.
    expect(policy).not.toMatch(/connect-src[^;]*\bws:(?!\/)/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  test('refuses a stylesheet that imports from a CDN', async () => {
    await write('cdn.css', "@import url('https://fonts.googleapis.com/css?family=Inter');\nbody{margin:0}");
    await write('cdn.ts', `import './cdn.css';`);
    await expect(build('cdn.ts', 'dist/cdn.html')).rejects.toThrow(/off-origin/);
  });

  test('allows a URL that is only a string, because a string fetches nothing', async () => {
    // React's production build embeds https://react.dev/errors/… in its error
    // messages. Rejecting that would mean rejecting React.
    await write('doc-url.ts', `export const help = 'https://example.com/errors/42';\nconsole.log(help);`);
    const html = await build('doc-url.ts', 'dist/doc-url.html');
    expect(html).toContain('example.com/errors/42');
  });

  test('escapes a closing script tag inside string data', async () => {
    await write('escape.ts', `document.title = ${JSON.stringify('</script><img src=x onerror=alert(1)>')};`);
    const html = await build('escape.ts', 'dist/escape.html');
    // One script element, not two — otherwise the string broke out of it.
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(html).toContain(String.raw`<\/script`);
  });

  test('rejects a template missing its markers', async () => {
    await writeFile(join(root, 'src', 'bare.html'), '<!doctype html><title>x</title>', 'utf8');
    await write('bare.ts', 'console.log(1);');
    await expect(
      buildPage({ root, entry: 'src/bare.ts', template: 'src/bare.html', outFile: 'dist/bare.html' }),
    ).rejects.toThrow(/BROAPP_HEAD/);
  });

  test('reports a compile error rather than writing a broken page', async () => {
    await write('broken.ts', `import { nothing } from './does-not-exist.ts';\nconsole.log(nothing);`);
    await expect(build('broken.ts', 'dist/broken.html')).rejects.toThrow(/bundle failed/i);
  });
});

describe('the host/browser boundary', () => {
  test('a browser bundle that imports host code fails the build', async () => {
    // This is the mistake the layout is designed to prevent: `broapp/host`
    // pulls in node:fs and Bun.spawn, which cannot be bundled for a browser.
    // The build must fail loudly rather than emit something broken.
    await write('leak.ts', `import { dataDir } from 'broapp/host';\nconsole.log(dataDir('x'));`);
    await expect(build('leak.ts', 'dist/leak.html')).rejects.toThrow();
  });

  test('a browser bundle built from the shared layer carries no host symbols', async () => {
    await write(
      'shared-only.ts',
      `import { s, defineContract } from 'broapp/shared';
       const c = defineContract({ operations: { 'a.b': { input: s.void(), output: s.void() } }, streams: {} });
       document.title = c.routes.operations.join(',');`,
    );
    const html = await build('shared-only.ts', 'dist/shared-only.html');
    for (const symbol of ['node:fs', 'node:os', 'Bun.spawn', 'ensureDataDir', 'createBridge', 'xdg-open']) {
      expect(html).not.toContain(symbol);
    }
  });
});

describe('targets', () => {
  test('the current machine has a target', () => {
    expect(TARGETS.map((target) => target.id)).toContain(currentTarget().id);
  });

  test('an unknown target is not silently accepted', () => {
    expect(findTarget('plan9-vax')).toBeUndefined();
  });
});
