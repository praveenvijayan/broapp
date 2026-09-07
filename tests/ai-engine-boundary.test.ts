/**
 * Big dependencies stay on the host.
 *
 * `ai` and `@ai-sdk/*` are the AI layer's implementation, not its interface,
 * and `@modelcontextprotocol/sdk` is the MCP adapter's. Only `src/ai/host/**`,
 * the provider packages and `broapp-autoapp/src/mcp/**` may import them; the
 * shared and React layers are followed by the browser bundle, and an import
 * there would either break the build or, worse, quietly ship a provider client
 * into the page. This test reads the files rather than trusting the layout.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', 'packages', 'broapp', 'src', 'ai');
const BROWSER_SAFE = ['shared', 'react'];
const FORBIDDEN = ["from 'ai'", 'from "ai"', "from 'ai/", 'from "ai/', '@ai-sdk/'];

const AUTOAPP = join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src');
const MCP_SDK = '@modelcontextprotocol/sdk';

async function filesUnder(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // `react` does not exist until a later prompt adds it.
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

describe('the AI engine boundary', () => {
  test('no shared or React file imports the AI SDK', async () => {
    let checked = 0;
    for (const directory of BROWSER_SAFE) {
      for (const file of await filesUnder(join(ROOT, directory))) {
        const source = await readFile(file, 'utf8');
        for (const needle of FORBIDDEN) {
          expect(`${file}: ${String(source.includes(needle))}`).toBe(`${file}: false`);
        }
        checked += 1;
      }
    }
    // A test that checks nothing passes for the wrong reason.
    expect(checked).toBeGreaterThan(0);
  });

  test('the host layer does import it, so the check is meaningful', async () => {
    const files = await filesUnder(join(ROOT, 'host'));
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    expect(sources.some((source) => FORBIDDEN.some((needle) => source.includes(needle)))).toBe(true);
  });
});

describe('the MCP adapter boundary', () => {
  test('no autoapp shared or React file imports the MCP SDK', async () => {
    let checked = 0;
    for (const directory of BROWSER_SAFE) {
      for (const file of await filesUnder(join(AUTOAPP, directory))) {
        const source = await readFile(file, 'utf8');
        expect(`${file}: ${String(source.includes(MCP_SDK))}`).toBe(`${file}: false`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('src/mcp does import it, so the check is meaningful', async () => {
    const files = await filesUnder(join(AUTOAPP, 'mcp'));
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    expect(sources.some((source) => source.includes(MCP_SDK))).toBe(true);
  });

  test('the launcher reaches it only through a lazy import', async () => {
    // `serve` is the common case and has no use for the SDK. A static import
    // anywhere under `launcher/` would pull it into the compiled binary's
    // startup path for every command.
    for (const file of await filesUnder(join(AUTOAPP, 'launcher'))) {
      const source = await readFile(file, 'utf8');
      expect(`${file}: ${String(source.includes(MCP_SDK))}`).toBe(`${file}: false`);
    }
    const main = await readFile(join(AUTOAPP, 'launcher', 'main.ts'), 'utf8');
    expect(main.includes("await import('../mcp/server.ts')")).toBe(true);
  });
});
