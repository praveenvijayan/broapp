/**
 * Bundling the browser UI into one self-contained HTML document.
 *
 * Brobridge's route table is exactly `/`, `/ws` and `/rpc` — there is no
 * static file route, by design, so nothing about the bridge ever touches the
 * filesystem in response to a request. That constraint decides the whole
 * packaging story: the UI must be *one document*, with its CSS and JavaScript
 * inline, because a `<script src="/assets/app.js">` would 404.
 *
 * That turns out to suit a compiled single-file application well. One document
 * is one `import … with { type: "text" }`, which Bun embeds in the executable,
 * and there is no asset manifest to keep in step.
 *
 * Two properties are enforced here rather than trusted:
 *
 * 1. No off-origin references. A local application that pulls a font or a
 *    script from a CDN stops working offline and hands a third party a view of
 *    when the user runs it. The check is a scan of the built document.
 * 2. A restrictive `Content-Security-Policy`, with the inline script pinned by
 *    SHA-256 hash rather than allowed by `'unsafe-inline'`. The hash is
 *    computed from the actual bundle, so it cannot drift. Brobridge sets no
 *    CSP of its own (it sets `Referrer-Policy`, `Cache-Control: no-store` and
 *    `X-Content-Type-Options`), and it only lets a host application supply a
 *    body, so the policy travels in a `<meta http-equiv>`.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

/** Options for {@link buildPage}. */
export interface BuildPageOptions {
  /** Browser entry point, e.g. `src/ui/main.tsx`. */
  readonly entry: string;
  /** HTML shell containing `<!--BROAPP_HEAD-->` and `<!--BROAPP_BODY-->`. */
  readonly template: string;
  /** Where to write the document. */
  readonly outFile: string;
  /** Default `true`. Off makes a development bundle readable in devtools. */
  readonly minify?: boolean;
  /** Project root the entry and template are resolved against. Default `process.cwd()`. */
  readonly root?: string;
  /**
   * Extra CSP sources, merged into the generated policy.
   *
   * `connect-src` already covers the bridge's own origin over `http:` and
   * `ws:`. Adding a remote origin here defeats the offline guarantee, so the
   * off-origin scan still runs.
   */
  readonly csp?: Readonly<Record<string, readonly string[]>>;
}

/** What {@link buildPage} produced. */
export interface BuildPageResult {
  readonly outFile: string;
  readonly bytes: number;
  readonly scriptHash: string;
}

/**
 * The base policy.
 *
 * `default-src 'none'` means every directive not listed below is denied, so a
 * directive nobody thought about fails closed. `connect-src` allows the page's
 * own origin plus `ws:`/`wss:` — the WebSocket URL has a different scheme from
 * the document's, and `'self'` does not cover it in any current browser.
 */
function policy(scriptHash: string, styleHash: string, extra: BuildPageOptions['csp']): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': [`'sha256-${scriptHash}'`],
    'style-src': [`'sha256-${styleHash}'`],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    // The bridge's WebSocket URL has a `ws:` scheme while the document has
    // `http:`. CSP Level 3 says `'self'` covers that upgrade, but not every
    // engine implements it, so the loopback hosts are named explicitly. The
    // port is ephemeral and unknowable at build time, hence `:*` — still far
    // tighter than a bare `ws:`, which would allow any host on the network.
    'connect-src': [
      "'self'",
      'ws://127.0.0.1:*',
      'ws://localhost:*',
      'ws://[::1]:*',
    ],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
  };
  for (const [directive, sources] of Object.entries(extra ?? {})) {
    directives[directive] = [...(directives[directive] ?? []), ...sources];
  }
  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64');
}

/**
 * A `</script` inside string data would end the inline script element early —
 * the HTML tokenizer does not know it is inside a JavaScript string. The same
 * goes for a comment opener.
 */
function escapeForInlineScript(code: string): string {
  return code.replaceAll('</script', String.raw`<\/script`).replaceAll('<!--', String.raw`<\!--`);
}

/**
 * Positions in a document that actually cause a network fetch.
 *
 * A bare `"https://…"` inside JavaScript is a *string*, not a request — React's
 * production build embeds `https://react.dev/errors/…` in its error messages,
 * and rejecting that would reject React. What matters is a URL somewhere the
 * browser will load from: an HTML attribute, a CSS `url()`, or an `@import`.
 *
 * The Content-Security-Policy is the real enforcement — `default-src 'none'`
 * blocks every off-origin fetch at runtime whatever the source says. This scan
 * exists so the failure happens at build time, where a developer can see it,
 * rather than as an empty box in somebody's browser.
 */
const LOAD_POSITIONS: readonly RegExp[] = [
  /\b(?:src|href|srcset|poster|data|action|formaction)\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]+/gi,
  /url\(\s*["']?(?:https?:)?\/\/[^"')]+/gi,
  /@import\s+(?:url\()?\s*["'](?:https?:)?\/\/[^"']+/gi,
];

/** The first off-origin load position in `html`, or `null`. */
function findOffOrigin(html: string): string | null {
  for (const pattern of LOAD_POSITIONS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(html);
    if (match !== null) return match[0].slice(0, 160);
  }
  return null;
}

/** Build the single-document UI. */
export async function buildPage(options: BuildPageOptions): Promise<BuildPageResult> {
  const root = options.root ?? process.cwd();
  const entry = resolve(root, options.entry);
  const templatePath = resolve(root, options.template);
  const outFile = resolve(root, options.outFile);

  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    minify: options.minify !== false,
    // Not `--splitting`: a second chunk would need a second HTTP route, and
    // there is none.
    splitting: false,
    define: { 'process.env.NODE_ENV': JSON.stringify(options.minify === false ? 'development' : 'production') },
  });
  if (!built.success) {
    throw new Error(`UI bundle failed:\n${built.logs.map(String).join('\n')}`);
  }

  const chunks = built.outputs.filter((output) => output.kind === 'entry-point' || output.kind === 'chunk');
  if (chunks.length !== 1) {
    throw new Error(
      `expected exactly one JavaScript chunk, got ${String(chunks.length)}. A dynamic import would need a second HTTP route, and the bridge serves only "/".`,
    );
  }
  const firstChunk = chunks[0];
  if (firstChunk === undefined) throw new Error('UI bundle produced no output');
  const script = await firstChunk.text();

  const cssOutputs = built.outputs.filter((output) => output.path.endsWith('.css'));
  let css = '';
  for (const output of cssOutputs) css += await output.text();

  const template = await Bun.file(templatePath).text();
  if (!template.includes('<!--BROAPP_HEAD-->') || !template.includes('<!--BROAPP_BODY-->')) {
    throw new Error(`${templatePath} must contain <!--BROAPP_HEAD--> and <!--BROAPP_BODY--> markers`);
  }

  const styleTag = css === '' ? '' : `<style>${css}</style>`;
  // Hash the script *as the browser will see it*: the escaping below changes
  // the bytes, so hashing before it would produce a policy that blocks the
  // very script it was computed from.
  const scriptBody = escapeForInlineScript(script);
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${policy(sha256(scriptBody), sha256(css), options.csp)}">` +
    styleTag;
  const finalHtml = template
    .replace('<!--BROAPP_HEAD-->', () => head)
    .replace('<!--BROAPP_BODY-->', () => `<script type="module">${scriptBody}</script>`);

  // The policy element itself names schemes and hosts; exclude it from the scan.
  const withoutPolicy = finalHtml.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, '');
  const offOrigin = findOffOrigin(withoutPolicy);
  if (offOrigin !== null) {
    throw new Error(
      `the built page loads from an off-origin URL, which would break offline operation and leak when the application runs:\n  ${offOrigin}\nInline or embed the asset instead.`,
    );
  }

  await mkdir(dirname(outFile), { recursive: true });
  await Bun.write(outFile, finalHtml);

  return {
    outFile,
    bytes: new TextEncoder().encode(finalHtml).byteLength,
    scriptHash: sha256(scriptBody),
  };
}
