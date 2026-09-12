/**
 * What applications exist, in one place.
 *
 * The launcher's tab and the engineer both need the same answer to "what is on
 * this machine", and report 08b watched a model stop before doing anything
 * because it had no way to ask. Two implementations of that answer would drift,
 * and the one that drifted would be the one nobody was looking at — so the
 * route and the tool share this.
 *
 * Nothing here returns a launch URL. A running child's address is a credential
 * and belongs only to the route a person clicked.
 */
import { readdirSync } from 'node:fs';

import { APP_ID_PATTERN, readCurrent, readRelease, type Layout } from '../spec/index.ts';

import type { Journal } from './journal.ts';
import type { ChildHandle, Supervisor } from './supervisor.ts';

/** One application, as anything listing them sees it. */
export interface AppRow {
  readonly appId: string;
  readonly name: string;
  readonly currentRelease: string | null;
  readonly serving: boolean;
  readonly pid: number | null;
  readonly schemaVersion: number | null;
  readonly activationPending: boolean;
}

/**
 * Every application that has a directory under the root.
 *
 * Only directories whose names are application ids. Finder writes `.DS_Store`
 * into any directory a person opens, and on 2026-09-12 that one file made
 * `apps.list` fail on every call and the engineer's orientation documents
 * fail with it, because the layout refused the name as an id. What is not an
 * application is not listed, and never was one.
 */
export function appIds(root: Layout): readonly string[] {
  try {
    return readdirSync(`${root.root}/apps`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && APP_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The live child serving one application, if any. */
export function serving(supervisor: Supervisor, appId: string): ChildHandle | null {
  return (
    supervisor.children.find((child) => child.appId === appId && child.mode === 'live') ?? null
  );
}

/** Every application, with what is running and what is half-finished. */
export function listApps(
  root: Layout,
  supervisor: Supervisor,
  journal: Journal,
): readonly AppRow[] {
  const unfinished = journal.unfinished();
  return appIds(root).map((appId) => {
    const child = serving(supervisor, appId);
    const currentRelease = readCurrent(root, appId);
    let name = appId;
    if (currentRelease !== null) {
      try {
        name = readRelease(root, appId, currentRelease).manifest.name;
      } catch {
        // A release directory that will not parse is still an application
        // somebody can look at; it just has no better name than its id.
      }
    }
    return {
      appId,
      name,
      currentRelease,
      serving: child !== null,
      pid: child?.pid ?? null,
      schemaVersion: child?.schemaVersion ?? null,
      activationPending: unfinished.some((row) => row.appId === appId),
    };
  });
}
