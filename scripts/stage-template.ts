#!/usr/bin/env bun
/**
 * Copy `templates/react-ts` into `packages/create-broapp/template`.
 *
 * The template lives at the repository root because the examples and the tests
 * read it from there, and because a template buried inside the generator
 * package is harder to find and to review. It has to *ship* inside the
 * generator, though, so this runs from `prepack` and before the release dry
 * run.
 *
 * The staged copy is a build artefact and is git-ignored.
 */
import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'templates', 'react-ts');
const to = resolve(root, 'packages', 'create-broapp', 'template');

await rm(to, { recursive: true, force: true });
await cp(from, to, {
  recursive: true,
  filter: (source) =>
    !/[/\\](?:node_modules|dist|release|\.git)(?:[/\\]|$)/.test(source),
});
console.log(`staged template: ${to}`);
