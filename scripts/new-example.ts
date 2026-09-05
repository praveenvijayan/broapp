#!/usr/bin/env bun
/**
 * Scaffold an example from the same template a user gets.
 *
 * The examples must not be hand-built, or they stop testing the thing they
 * exist to test: that the published tooling is enough to build a real
 * application. This runs the actual generator, then rewires the `broapp`
 * dependency to the workspace so the examples track local changes.
 */
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const [name, title, description] = process.argv.slice(2);
if (name === undefined || title === undefined) {
  console.error('usage: bun run scripts/new-example.ts <name> <title> [description]');
  process.exit(2);
}

const target = join(root, 'examples', name);
await rm(target, { recursive: true, force: true });

const child = Bun.spawn(
  [
    'bun',
    join(root, 'packages', 'create-broapp', 'src', 'main.ts'),
    target,
    '--name',
    name,
    '--title',
    title,
    '--description',
    description ?? title,
    '--yes',
    '--no-install',
  ],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
);
if ((await child.exited) !== 0) process.exit(1);

// Examples live in the workspace, so they take `broapp` from it. A generated
// project a user makes takes it from npm; the release dry run covers that path.
const manifestPath = join(target, 'package.json');
const manifest = (await Bun.file(manifestPath).json()) as {
  dependencies: Record<string, string>;
  private?: boolean;
};
manifest.dependencies['broapp'] = 'workspace:*';
manifest.private = true;
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`example ready: examples/${name}`);
