/**
 * Which applications were serving, so a restarted launcher serves them again.
 *
 * `<root>/launcher/serving.json`: `{ v: 1, apps: [...] }`. A person who opened
 * an application and then stopped the launcher — to update it, or because a
 * closed panel left them no other way back — finds it serving when the
 * launcher starts again, on a new port.
 *
 * Opening an application adds it; stopping it, removing it, or `serve` exiting
 * cleanly takes it out. Stopping the launcher does not: that is the point.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { HostLogger } from 'broapp/host';

import type { Layout } from '../spec/index.ts';

/** What the file holds. */
interface ServingFile {
  readonly v: 1;
  readonly apps: readonly string[];
}

/** Where the file is. */
export function servingPath(root: Layout): string {
  return join(root.root, 'launcher', 'serving.json');
}

/** The applications listed, oldest first. A missing or unreadable file lists none. */
export function readServing(root: Layout, logger?: HostLogger): readonly string[] {
  let raw: string;
  try {
    raw = readFileSync(servingPath(root), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServingFile>;
    if (parsed.v !== 1 || !Array.isArray(parsed.apps)) throw new Error('not a version 1 file');
    return parsed.apps.filter((appId): appId is string => typeof appId === 'string' && appId !== '');
  } catch (cause) {
    // A file nobody can read restores nothing, which is what a launcher did
    // before this file existed.
    logger?.warn(`[autoapp] ${servingPath(root)} could not be read; nothing will be restored: ${String(cause)}`);
    return [];
  }
}

/** Replace the list, without ever leaving a half-written file behind. */
function write(root: Layout, apps: readonly string[]): void {
  const path = servingPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const contents: ServingFile = { v: 1, apps };
  writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** List an application as serving. Idempotent. */
export function addServing(root: Layout, appId: string): void {
  const apps = readServing(root);
  if (apps.includes(appId)) return;
  write(root, [...apps, appId]);
}

/** Take an application off the list. Idempotent, and writes nothing when it was not listed. */
export function removeServing(root: Layout, appId: string): void {
  const apps = readServing(root);
  if (!apps.includes(appId)) return;
  write(root, apps.filter((listed) => listed !== appId));
}
