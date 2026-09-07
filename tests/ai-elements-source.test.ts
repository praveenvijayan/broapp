/**
 * Rules about the shipped source of `broapp-ai-elements`.
 *
 * The package ships TypeScript that a consumer's `Bun.build` resolves, and
 * most of it was written by a code generator rather than by hand. Both facts
 * need guarding: a generator's path alias does not exist in a consumer's
 * project, and a vendored file with no provenance cannot be upgraded later
 * without reading every line of it again.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'packages', 'broapp-ai-elements', 'src');

/** Every `.ts`/`.tsx` file under `src`, as repository-relative paths. */
async function sources(directory: string = root, prefix = 'src'): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const shown = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await sources(path, shown)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(shown);
  }
  return out.sort();
}

const files = await sources();

/** The file's text, by the path `sources` reports. */
function read(path: string): Promise<string> {
  return readFile(join(root, '..', path), 'utf8');
}

/** The same text with comments removed, for rules about what the code does. */
async function code(path: string): Promise<string> {
  return (await read(path)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('the shipped source', () => {
  test('has files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test('carries no path aliases', async () => {
    // `@/` is the shadcn CLI's alias. It resolves through the generating
    // project's tsconfig, which a consumer of this package does not have.
    for (const path of files) {
      expect(`${path}: ${(await read(path)).includes("from '@/") ? 'alias' : 'ok'}`).toBe(
        `${path}: ok`,
      );
      expect(`${path}: ${(await read(path)).includes('from "@/') ? 'alias' : 'ok'}`).toBe(
        `${path}: ok`,
      );
    }
  });

  test('never writes markup from a string', async () => {
    for (const path of files) {
      const text = await read(path);
      expect(`${path}: ${text.includes('dangerouslySetInnerHTML') ? 'raw html' : 'ok'}`).toBe(
        `${path}: ok`,
      );
    }
  });

  test('never answers an approval on the client', async () => {
    // Both of these mark a tool call answered in client state before the host
    // has decided, and the SDK's follow-up would start a second `ai.chat` run.
    // The host is the only source of truth for an approval.
    for (const path of files) {
      // Comments are stripped: naming a forbidden call in the comment that
      // explains why it is forbidden is the point.
      const text = await code(path);
      for (const forbidden of ['addToolApprovalResponse', 'sendAutomaticallyWhen']) {
        expect(`${path}: ${text.includes(forbidden) ? forbidden : 'ok'}`).toBe(`${path}: ok`);
      }
    }
  });

  test('every vendored file says where it came from', async () => {
    const vendored = files.filter((path) => path.startsWith('src/ui/components/'));
    expect(vendored.length).toBeGreaterThan(15);
    for (const path of vendored) {
      const first = (await read(path)).split('\n')[0] ?? '';
      expect(`${path}: ${first}`).toMatch(
        /: \/\/ Vendored from ai-elements@[\d.]+ \(.+\)\. Local changes are marked LOCAL\.$/,
      );
    }
  });

  test('every LOCAL edit is closed', async () => {
    for (const path of files) {
      const text = await read(path);
      const opened = text.split('// LOCAL:').length - 1;
      const closed = text.split('// END LOCAL').length - 1;
      expect(`${path}: ${String(opened)} opened, ${String(closed)} closed`).toBe(
        `${path}: ${String(opened)} opened, ${String(opened)} closed`,
      );
    }
  });
});
