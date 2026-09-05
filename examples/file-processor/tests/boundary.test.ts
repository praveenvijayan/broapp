/**
 * The path boundary.
 *
 * These are the cases the example exists to get right. They call the host
 * directly, bypassing the interface, because an attacker would too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInside, type Workspace } from '../src/host/workspace.ts';

let base = '';
let workspace: Workspace;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'fp-boundary-')));
  const root = join(base, 'root');
  const outside = join(base, 'elsewhere');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, 'nested'), { recursive: true });

  await writeFile(join(root, 'inside.txt'), 'ok', 'utf8');
  await writeFile(join(root, 'nested', 'deep.txt'), 'ok', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'not for you', 'utf8');
  // A symlink that lives inside the root and points outside it. This is the
  // case a string check for ".." misses entirely.
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));

  workspace = { root, explicit: true, outputDirName: 'reports' };
});

afterAll(async () => {
  if (base !== '') await rm(base, { recursive: true, force: true });
});

describe('resolveInside', () => {
  test('accepts a file directly inside the root', async () => {
    await expect(resolveInside(workspace, 'inside.txt', { existing: true })).resolves.toContain(
      'inside.txt',
    );
  });

  test('accepts a file in a subdirectory', async () => {
    await expect(
      resolveInside(workspace, 'nested/deep.txt', { existing: true }),
    ).resolves.toContain('deep.txt');
  });

  test('refuses a traversing name', async () => {
    await expect(resolveInside(workspace, '../elsewhere/secret.txt', { existing: true })).rejects.toThrow(
      /outside the folder/,
    );
  });

  test('refuses a deeply traversing name', async () => {
    await expect(
      resolveInside(workspace, 'nested/../../elsewhere/secret.txt', { existing: true }),
    ).rejects.toThrow();
  });

  test('refuses an absolute path', async () => {
    await expect(resolveInside(workspace, '/etc/passwd', { existing: true })).rejects.toThrow(
      /relative to the folder/,
    );
  });

  test('refuses a symlink inside the root that points outside it', async () => {
    // The name has no ".." in it and is not absolute. Only resolving the link
    // before the check catches this.
    await expect(resolveInside(workspace, 'escape.txt', { existing: true })).rejects.toThrow(
      /outside the folder/,
    );
  });

  test('refuses the root itself', async () => {
    await expect(resolveInside(workspace, '.', { existing: true })).rejects.toThrow();
  });

  test('refuses an empty name and a null byte', async () => {
    await expect(resolveInside(workspace, '', { existing: true })).rejects.toThrow();
    await expect(resolveInside(workspace, 'a\0b', { existing: true })).rejects.toThrow();
  });

  test('reports a missing file as missing, not as an internal failure', async () => {
    await expect(resolveInside(workspace, 'nope.txt', { existing: true })).rejects.toThrow(
      /not in the folder/,
    );
  });

  test('a name refused does not reveal what is on the disk', async () => {
    try {
      await resolveInside(workspace, '../elsewhere/secret.txt', { existing: true });
      throw new Error('should have thrown');
    } catch (cause) {
      const message = (cause as Error).message;
      expect(message).not.toContain(base);
      expect(message).not.toContain('elsewhere');
      expect(message).not.toContain('secret');
    }
  });
});
