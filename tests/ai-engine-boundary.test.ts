/**
 * The engine stays on the host.
 *
 * `ai` and `@ai-sdk/*` are the AI layer's implementation, not its interface.
 * Only `src/ai/host/**` and the provider packages may import them; the shared
 * and React layers are followed by the browser bundle, and an import there
 * would either break the build or, worse, quietly ship a provider client into
 * the page. This test reads the files rather than trusting the layout.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', 'packages', 'broapp', 'src', 'ai');
const BROWSER_SAFE = ['shared', 'react'];
const FORBIDDEN = ["from 'ai'", 'from "ai"', "from 'ai/", 'from "ai/', '@ai-sdk/'];

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
