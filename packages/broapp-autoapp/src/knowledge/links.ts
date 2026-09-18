/**
 * The relationship index: which recorded things touched which.
 *
 * Five kinds of node — a task (by its slug), a run, a file, a case and a
 * lesson — and nine relations, each row read from one row somewhere else and
 * naming it in `source`. A link is a fact that two recorded things touched: a
 * run edited a file, a lesson was distilled from a case. It carries no weight
 * and no score, and nothing here ranks by one. Two changes to one file can be
 * about different things, which is why the one reader of these rows (the
 * second tier of a task's lessons) is capped, and measured before anyone
 * relies on it.
 *
 * Derived data. {@link rebuildLinks} deletes and rewrites every row in one
 * transaction on `knowledge.sqlite`; dropping the table loses nothing. The
 * backlog is read through its own store, never attached: two WAL files have no
 * atomic commit between them and no foreign key across them.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';

import type { IntentStore, Label } from '../intent/index.ts';
import type { Layout } from '../spec/index.ts';

import { editedPaths } from './attempts.ts';
import { caseEdits } from './distil.ts';
import { LINKS_TABLE, type Knowledge } from './store.ts';

/** The kinds of node a link joins. */
export type LinkKind = 'task' | 'run' | 'file' | 'case' | 'lesson';

/** The relations, as `src_kind rel dst_kind`. */
export const LINK_RELATIONS = [
  'task ran_as run',
  'run edited file',
  'task edited file',
  'task planned file',
  'case opened_in run',
  'case resolved_in run',
  'case edited file',
  'lesson distilled_from case',
  'lesson served_to run',
] as const;

/**
 * The build stages work of each kind usually fails at, read from the build's
 * own stage names (`BUILD_STAGES`) and the check. Used for one thing only:
 * among the lessons a task's words match, one about a stage in this list sorts
 * before one that is not. A label with no sure mapping maps to nothing: a
 * migration fails at the manifest or at the host's SQL, and copy almost never
 * fails a build at all.
 */
export const STAGES_FOR_LABEL: Readonly<Record<Label, readonly string[]>> = {
  contract: ['contract'],
  host: ['host'],
  migration: [],
  views: ['views'],
  theme: ['page'],
  acceptance: ['check'],
  copy: [],
};

/** The stages a task's labels point at. */
export function stagesFor(labels: readonly Label[]): ReadonlySet<string> {
  return new Set(labels.flatMap((label) => STAGES_FOR_LABEL[label] ?? []));
}

/**
 * The key of a file node: a path relative to the application's source
 * workspace, forward slashes, no leading `./`; or `null`.
 *
 * An absolute path inside the workspace is made relative; any other absolute
 * path, and any path that leaves the workspace once `..` is resolved, is
 * `null` and never becomes a node. The application is not in the key: every
 * lookup names `app_id` beside it, so two applications' `src/host/routes.ts`
 * are two nodes that never join.
 */
export function fileKey(layout: Layout, appId: string, raw: string): string | null {
  let text = raw.trim();
  if (text === '') return null;
  if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
    const inside = relative(layout.app(appId).source, text);
    if (inside === '' || isAbsolute(inside) || inside.startsWith('..')) return null;
    text = inside.split(sep).join('/');
  }
  text = text.replaceAll('\\', '/');
  if (text.startsWith('/')) return null;
  const normal = posix.normalize(text).replace(/^(\.\/)+/, '');
  if (normal === '.' || normal === '..' || normal.startsWith('../') || normal.split('/').includes('..')) return null;
  return normal.replace(/\/+$/, '');
}

/** One row, before it is written. */
interface Link {
  readonly appId: string;
  readonly srcKind: LinkKind;
  readonly srcId: string;
  readonly rel: string;
  readonly dstKind: LinkKind;
  readonly dstId: string;
  readonly source: string;
}

/** A `locks` entry that is not a file of the workspace, and so was not linked. */
export interface SkippedLock {
  readonly appId: string;
  readonly slug: string;
  readonly lock: string;
}

/** What {@link rebuildLinks} needs. */
export interface RebuildLinksInput {
  readonly knowledge: Knowledge;
  readonly intents: IntentStore;
  readonly layout: Layout;
  /** The applications to index. A removed application's history is not linked. */
  readonly apps: readonly string[];
  /** The clock the rows are stamped with. */
  readonly now?: number;
}

/** What a rebuild wrote. */
export interface RebuildLinksResult {
  /** Rows written, by `src_kind rel dst_kind`. */
  readonly rows: Readonly<Record<string, number>>;
  readonly skippedLocks: readonly SkippedLock[];
  readonly ms: number;
}

function dataOf(text: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether a key names a file that exists in the workspace. */
function isWorkspaceFile(layout: Layout, appId: string, key: string): boolean {
  const path = join(layout.app(appId).source, key);
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The files a task's `locks` name, and the entries that name none.
 *
 * A planner writes `locks` as free text; an entry is a file only when it
 * normalises to a path that exists in the workspace. Anything else is skipped
 * and reported, never guessed at: "the routes file" might be one of three.
 */
export function plannedFiles(
  layout: Layout,
  appId: string,
  task: { readonly slug: string; readonly locks: readonly string[] },
): { files: string[]; skipped: SkippedLock[] } {
  const files: string[] = [];
  const skipped: SkippedLock[] = [];
  for (const lock of task.locks) {
    const key = fileKey(layout, appId, lock);
    if (key === null || !isWorkspaceFile(layout, appId, key)) skipped.push({ appId, slug: task.slug, lock });
    else if (!files.includes(key)) files.push(key);
  }
  return { files, skipped };
}

/** Every task's skipped locks, without writing anything. */
export function skippedLocks(intents: IntentStore, layout: Layout, apps: readonly string[]): SkippedLock[] {
  const out: SkippedLock[] = [];
  for (const appId of apps) {
    for (const intent of intents.list({ appId, limit: Number.MAX_SAFE_INTEGER })) {
      for (const task of intents.runOrder(intent.id)) out.push(...plannedFiles(layout, appId, task).skipped);
    }
  }
  return out;
}

/**
 * Delete every link and write them again from the rows they are read from.
 *
 * One transaction: a reader sees the old table or the new one, never half.
 */
export function rebuildLinks(input: RebuildLinksInput): RebuildLinksResult {
  const started = performance.now();
  const { knowledge, intents, layout } = input;
  const { db } = knowledge;
  const apps = new Set(input.apps);
  const links: Link[] = [];
  const skipped: SkippedLock[] = [];
  const add = (link: Link): void => {
    links.push(link);
  };

  /** A run's `edit` events, each with its id. */
  const editsOf = db.query<{ id: number; data: string | null }, [string]>(
    "SELECT id, data FROM events WHERE kind = 'edit' AND run_id = ? ORDER BY id",
  );

  // Tasks, their runs, and what those runs and the plan named.
  for (const appId of apps) {
    for (const intent of intents.list({ appId, limit: Number.MAX_SAFE_INTEGER })) {
      for (const task of intents.runOrder(intent.id)) {
        for (const run of intents.runsOf(task.id)) {
          add({ appId, srcKind: 'task', srcId: task.slug, rel: 'ran_as', dstKind: 'run', dstId: run.runId, source: `task_runs:${run.runId}` });
          for (const event of editsOf.all(run.runId)) {
            for (const raw of editedPaths(dataOf(event.data))) {
              const key = fileKey(layout, appId, raw);
              if (key === null) continue;
              add({ appId, srcKind: 'run', srcId: run.runId, rel: 'edited', dstKind: 'file', dstId: key, source: `events:${String(event.id)}` });
              add({ appId, srcKind: 'task', srcId: task.slug, rel: 'edited', dstKind: 'file', dstId: key, source: `events:${String(event.id)}` });
            }
          }
        }
        const planned = plannedFiles(layout, appId, task);
        for (const key of planned.files) {
          add({ appId, srcKind: 'task', srcId: task.slug, rel: 'planned', dstKind: 'file', dstId: key, source: `tasks:${String(task.id)}` });
        }
        skipped.push(...planned.skipped);
      }
    }
  }

  // Runs outside the backlog edit files too: a chat turn, or a builder whose
  // task is gone.
  const loose = db
    .query<{ id: number; app_id: string; run_id: string; data: string | null }, []>(
      "SELECT id, app_id, run_id, data FROM events WHERE kind = 'edit' AND app_id IS NOT NULL AND run_id IS NOT NULL ORDER BY id",
    )
    .all();
  for (const event of loose) {
    if (!apps.has(event.app_id)) continue;
    for (const raw of editedPaths(dataOf(event.data))) {
      const key = fileKey(layout, event.app_id, raw);
      if (key === null) continue;
      add({ appId: event.app_id, srcKind: 'run', srcId: event.run_id, rel: 'edited', dstKind: 'file', dstId: key, source: `events:${String(event.id)}` });
    }
  }

  // Cases: where they were opened and resolved, and what their window edited.
  const now = input.now ?? Date.now();
  const episodes = db
    .query<{ id: number; app_id: string; run_id: string; resolved_run_id: string | null; opened_at: number; resolved_at: number | null }, []>(
      'SELECT id, app_id, run_id, resolved_run_id, opened_at, resolved_at FROM episodes ORDER BY id',
    )
    .all();
  const caseApp = new Map<number, string>();
  for (const episode of episodes) {
    if (!apps.has(episode.app_id)) continue;
    const appId = episode.app_id;
    const id = String(episode.id);
    caseApp.set(episode.id, appId);
    if (episode.run_id !== '') {
      add({ appId, srcKind: 'case', srcId: id, rel: 'opened_in', dstKind: 'run', dstId: episode.run_id, source: `episodes:${id}` });
    }
    if (episode.resolved_run_id !== null && episode.resolved_run_id !== '') {
      add({ appId, srcKind: 'case', srcId: id, rel: 'resolved_in', dstKind: 'run', dstId: episode.resolved_run_id, source: `episodes:${id}` });
    }
    for (const event of caseEdits(knowledge, appId, episode.opened_at, episode.resolved_at ?? now)) {
      for (const raw of editedPaths(dataOf(event.data))) {
        const key = fileKey(layout, appId, raw);
        if (key === null) continue;
        add({ appId, srcKind: 'case', srcId: id, rel: 'edited', dstKind: 'file', dstId: key, source: `events:${String(event.id)}` });
      }
    }
  }

  // Lessons: the case each was distilled from, and the runs it reached.
  for (const lesson of db.query<{ id: number; episode_id: number | null }, []>('SELECT id, episode_id FROM lessons ORDER BY id').all()) {
    if (lesson.episode_id === null) continue;
    const appId = caseApp.get(lesson.episode_id);
    if (appId === undefined) continue;
    add({
      appId,
      srcKind: 'lesson',
      srcId: String(lesson.id),
      rel: 'distilled_from',
      dstKind: 'case',
      dstId: String(lesson.episode_id),
      source: `lessons:${String(lesson.id)}`,
    });
  }
  for (const serving of db
    .query<{ id: number; lesson_id: number; run_id: string; app_id: string }, []>(
      'SELECT id, lesson_id, run_id, app_id FROM servings WHERE included = 1 ORDER BY id',
    )
    .all()) {
    if (!apps.has(serving.app_id)) continue;
    add({
      appId: serving.app_id,
      srcKind: 'lesson',
      srcId: String(serving.lesson_id),
      rel: 'served_to',
      dstKind: 'run',
      dstId: serving.run_id,
      source: `servings:${String(serving.id)}`,
    });
  }

  const rows: Record<string, number> = Object.fromEntries(LINK_RELATIONS.map((relation) => [relation, 0]));
  const insert = db.query<null, [string, string, string, string, string, string, string, number]>(
    `INSERT OR IGNORE INTO links (app_id, src_kind, src_id, rel, dst_kind, dst_id, source, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.exec(LINKS_TABLE);
    db.exec('DELETE FROM links');
    for (const link of links) {
      // The unique index keeps the first row a fact was read from.
      const written = insert.run(link.appId, link.srcKind, link.srcId, link.rel, link.dstKind, link.dstId, link.source, now);
      if (written.changes > 0) {
        const relation = `${link.srcKind} ${link.rel} ${link.dstKind}`;
        rows[relation] = (rows[relation] ?? 0) + 1;
      }
    }
  })();
  return { rows, skippedLocks: skipped, ms: performance.now() - started };
}

/** What `knowledge links` prints: rows per relation, then the skipped locks verbatim. */
export function linksReport(
  knowledge: Knowledge,
  skipped: readonly SkippedLock[],
  appId?: string,
): string[] {
  const counts = new Map(
    knowledge.db
      .query<{ relation: string; n: number }, [string | null, string | null]>(
        `SELECT src_kind || ' ' || rel || ' ' || dst_kind AS relation, COUNT(*) AS n FROM links
          WHERE (? IS NULL OR app_id = ?) GROUP BY relation`,
      )
      .all(appId ?? null, appId ?? null)
      .map((row) => [row.relation, row.n]),
  );
  const lines = LINK_RELATIONS.map((relation) => `${relation.padEnd(28)} ${String(counts.get(relation) ?? 0)}`);
  const mine = skipped.filter((lock) => appId === undefined || lock.appId === appId);
  lines.push('', `locks that are not a file of the workspace: ${String(mine.length)}`);
  for (const lock of mine) lines.push(`  ${lock.appId} ${lock.slug}: ${JSON.stringify(lock.lock)}`);
  return lines;
}

/** What {@link runLinksCommand} needs. */
export interface LinksCommandOptions {
  readonly argv: readonly string[];
  readonly knowledge: Knowledge;
  readonly intents: IntentStore;
  readonly layout: Layout;
  readonly apps: readonly string[];
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/**
 * `knowledge links [--app <id>] [--rebuild]`: the rows per relation and the
 * locks that are not a file. With `--rebuild`, the table is rewritten first
 * and the time it took is printed. Derived data, so it is allowed while a
 * launcher serves: the launcher rebuilds it again after the next task ends.
 */
export function runLinksCommand(options: LinksCommandOptions): number {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const at = options.argv.indexOf('--app');
  const appId = at < 0 ? undefined : options.argv[at + 1];
  if (at >= 0 && (appId === undefined || appId.startsWith('-'))) {
    err('usage: broapp-autoapp knowledge links [--app <id>] [--rebuild]');
    return 1;
  }
  if (appId !== undefined && !options.apps.includes(appId)) {
    err(`There is no application called ${appId}.`);
    return 1;
  }
  let skipped: readonly SkippedLock[];
  if (options.argv.includes('--rebuild')) {
    const result = rebuildLinks({ knowledge: options.knowledge, intents: options.intents, layout: options.layout, apps: options.apps });
    out(`rebuilt in ${result.ms.toFixed(1)} ms`);
    skipped = result.skippedLocks;
  } else {
    skipped = skippedLocks(options.intents, options.layout, options.apps);
  }
  for (const line of linksReport(options.knowledge, skipped, appId)) out(line);
  return 0;
}
