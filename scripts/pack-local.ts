#!/usr/bin/env bun
/**
 * Pack the publishable packages into tarballs.
 *
 * Used by the release dry run and by the tests that check a generated project
 * against a *packed* package rather than against workspace source. Those two
 * differ in ways that matter — `files`, `exports`, and the staged template are
 * only exercised by the tarball — and a starter that works from the monorepo
 * and not from npm is a starter that does not work.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** One packed package. */
export interface Packed {
  readonly name: string;
  readonly tarball: string;
}

/** Every package that is published. Order matters only for readable output. */
const PUBLISHED = ['broapp', 'create-broapp', 'broapp-ai-anthropic', 'broapp-ai-compatible'];

/** Pack every publishable package into `outDir`. Returns absolute tarball paths. */
export async function packLocal(outDir: string = join(root, '.broapp-tmp', 'packs')): Promise<Packed[]> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // The generator ships the template; stage it before packing or the tarball
  // is missing the thing it exists to copy.
  const stage = Bun.spawn(['bun', 'run', join(root, 'scripts', 'stage-template.ts')], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await stage.exited) !== 0) throw new Error('staging the template failed');

  const packed: Packed[] = [];
  for (const name of PUBLISHED) {
    const packageDir = join(root, 'packages', name);
    const child = Bun.spawn(['bun', 'pm', 'pack', '--destination', outDir], {
      cwd: packageDir,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await child.exited) !== 0) throw new Error(`packing ${name} failed`);

    const entries = await readdir(outDir);
    const tarball = entries
      .filter((entry) => entry.startsWith(`${name}-`) && entry.endsWith('.tgz'))
      .sort()
      .pop();
    if (tarball === undefined) throw new Error(`no tarball produced for ${name}`);
    packed.push({ name, tarball: join(outDir, tarball) });
  }
  return packed;
}

if (import.meta.main) {
  const packed = await packLocal();
  for (const entry of packed) console.log(`${entry.name}\t${entry.tarball}`);
}
