#!/usr/bin/env bun
/**
 * Build the launcher's own page.
 *
 * One document with its CSS and JavaScript inline, CSP pinned to their hashes —
 * exactly what `broapp build` produces for an application. The launcher is a
 * Broapp application, so its page is built the same way; it just is not a
 * project with a `broapp.config.ts`.
 */
import { buildPage } from 'broapp/build';

const root = new URL('..', import.meta.url).pathname;

const result = await buildPage({
  root,
  entry: 'src/launcher/ui/main.tsx',
  template: 'src/launcher/ui/index.html',
  outFile: 'dist/launcher-page.html',
});

console.log(`ui  dist/launcher-page.html  ${(result.bytes / 1024).toFixed(1)} KiB`);
