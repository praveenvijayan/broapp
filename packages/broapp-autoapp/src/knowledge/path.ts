/**
 * What a turn is told before it asks: where the application stands, and what
 * the request's words point at.
 *
 * Two documents. The **orientation** is the candidate panel in words: the
 * release that is running, the candidate, what has changed since it was built,
 * what the checks say and whether they still hold, and the next verification
 * step. Nothing is in it that the state does not say. The **task evidence** is
 * an index lookup: the routes, views, migrations, acceptance examples and
 * source symbols the request's words match, each with a `file:line` to read.
 *
 * Every evidence entry is marked with how it is known. `declared` comes from the
 * release specification, which the build validated. `pattern` comes from a
 * regular expression over the source, which is a pointer, not a claim. And a
 * route whose handler the expressions cannot find says `unknown` and names
 * `source.search`, rather than guessing. The index does not follow imports,
 * aliases or computed names: a TypeScript parser is not a dependency this
 * package has, and a wrong claim costs the engineer more than a missing one —
 * it reads the wrong file with confidence.
 */
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_REPAIR_ATTEMPTS, type CandidateStates } from '../engineer/state.ts';
import { within } from '../engineer/workspace.ts';
import type { AppRow } from '../launcher/apps.ts';
import { SOURCE } from '../launcher/candidate.ts';
import { readCurrent, readRelease, type AppSpec, type Layout } from '../spec/index.ts';
import type { Component, Page } from '../views/types.ts';

import { sha256 } from './store.ts';

/** Where an application stands, in words. */
export interface Orientation {
  readonly appId: string;
  readonly text: string;
  readonly hash: string;
}

/** One thing the request's words matched, and how it is known. */
export interface EvidenceEntry {
  readonly kind: 'route' | 'view' | 'migration' | 'example' | 'symbol' | 'constraint';
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  readonly confidence: 'declared' | 'pattern' | 'unknown';
  readonly note?: string;
}

/** The evidence for one request, rendered and as entries. */
export interface TaskEvidence {
  readonly appId: string;
  readonly text: string;
  readonly entries: readonly EvidenceEntry[];
}

/** One line of source a pattern matched. */
export interface IndexedSymbol {
  readonly file: string;
  readonly line: number;
  readonly kind: 'export' | 'function' | 'operation' | 'component' | 'migration';
  readonly name: string;
}

/** A workspace's symbols, at one source revision. */
export interface SymbolIndex {
  readonly rev: string;
  readonly symbols: readonly IndexedSymbol[];
}

/** The longest each document may be. Together they stay far inside the AI layer's budget. */
export const ORIENTATION_MAX_CHARS = 2_000;
export const EVIDENCE_MAX_CHARS = 4_000;

/** How many of each kind the evidence lists, so a common word cannot fill it. */
const MAX_ROUTES = 8;
const MAX_VIEWS = 8;
const MAX_EXAMPLES = 6;
const MAX_SYMBOLS = 12;
/** The longest problem message quoted in an orientation. */
const PROBLEM_CHARS = 160;
/** The largest source file the index reads. */
const MAX_INDEXED_BYTES = 200_000;

/** At most `max` characters, marked when cut. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "3 minutes ago", from a timestamp. */
function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1_000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

/** The files `git` says changed between a revision and `HEAD`, or nothing when it cannot say. */
function changedSince(sourceDir: string, rev: string): readonly string[] {
  if (!/^[0-9a-f]{40,64}$/.test(rev)) return [];
  try {
    const diff = Bun.spawnSync({
      cmd: ['git', 'diff', '--name-only', rev, 'HEAD'],
      cwd: sourceDir,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (diff.exitCode !== 0) return [];
    return new TextDecoder().decode(diff.stdout).split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

/**
 * Where one application stands, in eight lines.
 *
 * Read from the candidate state and the release store, the same sources the
 * candidate panel reads, so the engineer and the person are told the same
 * thing.
 */
export function orientation(input: {
  readonly layout: Layout;
  readonly appId: string;
  readonly states: CandidateStates;
  readonly apps: readonly AppRow[];
  readonly now?: number;
}): Orientation {
  const { layout, appId, states } = input;
  const now = input.now ?? Date.now();
  const row = input.apps.find((app) => app.appId === appId);
  const current = row?.currentRelease ?? readCurrent(layout, appId);
  let schema: number | null = null;
  if (current !== null) {
    try {
      schema = readRelease(layout, appId, current).manifest.schemaVersion;
    } catch {
      // A release that will not read has no schema to report; the line says so.
    }
  }
  const state = states.get(appId);
  const status = states.status(appId);

  const lines = [`## ${row?.name ?? appId} (${appId})`];
  lines.push(
    current === null
      ? `Current release none · serving: ${row?.serving === true ? 'yes' : 'no'}`
      : `Current release ${current.slice(0, 8)} · schema v${schema === null ? '?' : String(schema)} · serving: ${row?.serving === true ? 'yes' : 'no'}`,
  );

  const built = state.releaseId;
  const rev = state.builtFromRev;
  lines.push(
    built === null
      ? 'Candidate: none'
      : `Candidate: ${built.slice(0, 8)} built ${state.builtAt === null ? 'at an unknown time' : ago(state.builtAt, now)} from ${rev === null ? 'an unknown revision' : rev === 'no-git' ? 'no-git' : rev.slice(0, 7)}`,
  );

  const edited = state.editsSinceBuild && rev !== null ? changedSince(layout.app(appId).source, rev) : [];
  lines.push(
    !state.editsSinceBuild
      ? 'Edits since build: none'
      : edited.length === 0
        ? 'Edits since build: yes (the files could not be listed)'
        : `Edits since build: ${String(edited.length)} file${edited.length === 1 ? '' : 's'} (${edited.slice(0, 5).join(', ')}${edited.length > 5 ? ', …' : ''})`,
  );

  const problem = state.problems[0];
  lines.push(
    state.builtAt === null
      ? 'Last build: none'
      : problem === undefined
        ? 'Last build: ok'
        : `Last build: failed at ${problem.stage}: ${cut(problem.message.replace(/\s+/g, ' '), PROBLEM_CHARS)}`,
  );

  const checks = state.checks;
  const passed = checks?.results.filter((result) => result.passed).length ?? 0;
  const total = checks?.results.length ?? 0;
  lines.push(
    checks === null
      ? 'Checks: none'
      : status.checksVerified
        ? `Checks: ${String(passed)}/${String(total)} verified for the running preview`
        : `Checks: passed ${String(passed)}/${String(total)} for an earlier preview — run again`,
  );

  lines.push(
    status.previewRunning
      ? 'Preview: running'
      : status.previewLost
        ? 'Preview: stopped when the launcher restarted — launcher.previewStart'
        : 'Preview: none',
  );

  // The last change cycle, when there was one: where it stopped, and what it
  // left. Absent before any cycle, so an application nobody has cycled reads
  // as it always did.
  const cycle = state.cycle;
  const unfinished = cycle !== null && (cycle.step === 'patched' || cycle.step === 'built' || cycle.step === 'previewed');
  const failing = cycle !== null && cycle.failures.length > 0 && (cycle.step === 'build-failed' || cycle.step === 'checked');
  const stalled = failing && cycle.attempts >= MAX_REPAIR_ATTEMPTS;
  if (cycle !== null) {
    const attempt = failing ? ` (attempt ${String(cycle.attempts)} of ${String(MAX_REPAIR_ATTEMPTS)})` : '';
    const what =
      cycle.step === 'build-failed'
        ? `build failed at ${cut(cycle.failures[0]?.summary ?? 'an unknown stage', PROBLEM_CHARS)}${attempt}`
        : cycle.step === 'checked'
          ? failing
            ? `${String(cycle.failures.length)} check${cycle.failures.length === 1 ? '' : 's'} failed: ${cut(cycle.failures[0]?.summary ?? '', PROBLEM_CHARS)}${attempt}`
            : 'every check passed'
          : cycle.step === 'patched'
            ? 'patched and not built — it stopped there'
            : cycle.step === 'built' || cycle.step === 'previewed'
              ? `built ${cycle.releaseId?.slice(0, 8) ?? ''} and not checked — it stopped there`
              : cycle.step === 'build-declined'
                ? 'the person declined the build'
                : 'the person declined the preview';
    lines.push(`Last cycle: ${what}, ${ago(cycle.at, now)}`);
  }

  let next: string;
  if (stalled) next = 'the last cycles ended with the same failure: read the lines it points at and change approach, or ask the person';
  else if (unfinished) next = 'candidate.cycle with no hunks, to finish verifying the last change';
  else if (failing) next = 'fix what the last cycle reported, with another candidate.cycle';
  else if (built === null || state.editsSinceBuild) next = 'candidate.build';
  else if (built === current) next = 'nothing to verify: the candidate is the current release';
  else if (status.previewLost) next = 'launcher.previewStart (the person’s Start preview), or candidate.preview';
  else if (!status.previewRunning) next = 'candidate.preview';
  else if (!status.checksVerified) next = 'candidate.check';
  else if (passed < total) next = 'fix what the failing checks report, then candidate.build';
  else next = 'ask the person to look at the preview, then release.activate';
  lines.push(`Next: ${next}`);

  const text = cut(lines.join('\n'), ORIENTATION_MAX_CHARS);
  return { appId, text, hash: sha256(text).slice(0, 32) };
}

/** The three patterns that apply to every source file. */
const FUNCTION = /^export (?:async )?function (\w+)/;
const CONST = /^export const (\w+)/;
const OPERATION = /app\.operation\(['"]([\w.]+)['"]/g;
/** In `views.ts` only. It also matches column, field and action ids: a pointer, not a claim. */
const VIEW_ID = /id: ['"]([\w-]+)['"]/g;

/**
 * Index a workspace's source with five patterns and nothing else.
 *
 * `export function`, `export const`, `app.operation('…')` anywhere in `src/`,
 * `id: '…'` inside `views.ts`, and the migration ids in `autoapp.json`. An
 * operation registered through an alias (`const op = app.operation`) or a
 * computed name is not found, and the evidence says `unknown` for it.
 *
 * Only what is really inside the workspace is read: the scan does not follow
 * a symbolic link, a file that is one is skipped, and every path passes the
 * same `within` check `source.search` uses. A link in `src/` pointing at a
 * file elsewhere on the machine would otherwise put that file's names — and a
 * `file:line` into it — in front of the model.
 */
export function indexWorkspace(sourceDir: string, rev: string): SymbolIndex {
  const symbols: IndexedSymbol[] = [];
  /** The file's text, or `null` when it is a link, too large, outside, or unreadable. */
  const readInside = (file: string): string | null => {
    try {
      const full = within(sourceDir, file);
      const entry = lstatSync(full);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_INDEXED_BYTES) return null;
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };
  if (existsSync(join(sourceDir, 'src'))) {
    const files = [
      ...new Bun.Glob('src/**/*.{ts,tsx}').scanSync({ cwd: sourceDir, onlyFiles: true, followSymlinks: false }),
    ]
      .map((path) => path.split('\\').join('/'))
      .filter((path) => !path.includes('/node_modules/'))
      .sort();
    for (const file of files) {
      const text = readInside(file);
      if (text === null) continue;
      const views = file === SOURCE.views;
      text.split(/\r?\n/).forEach((content, index) => {
        const line = index + 1;
        const fn = FUNCTION.exec(content);
        if (fn?.[1] !== undefined) symbols.push({ file, line, kind: 'function', name: fn[1] });
        const constant = CONST.exec(content);
        if (constant?.[1] !== undefined) symbols.push({ file, line, kind: 'export', name: constant[1] });
        for (const match of content.matchAll(OPERATION)) {
          if (match[1] !== undefined) symbols.push({ file, line, kind: 'operation', name: match[1] });
        }
        if (views) {
          for (const match of content.matchAll(VIEW_ID)) {
            if (match[1] !== undefined) symbols.push({ file, line, kind: 'component', name: match[1] });
          }
        }
      });
    }
  }

  const manifestText = readInside(SOURCE.manifest);
  if (manifestText !== null) {
    try {
      const text = manifestText;
      const lines = text.split(/\r?\n/);
      const manifest = JSON.parse(text) as { migrations?: { id?: unknown }[] };
      for (const step of manifest.migrations ?? []) {
        if (typeof step.id !== 'string') continue;
        const quoted = JSON.stringify(step.id);
        const at = lines.findIndex((line) => line.includes(quoted));
        symbols.push({ file: SOURCE.manifest, line: at + 1, kind: 'migration', name: step.id });
      }
    } catch {
      // A manifest that does not parse has no migrations to point at; the
      // build will say what is wrong with it.
    }
  }
  return { rev, symbols };
}

/** The words of an identifier or a sentence: camelCase, kebab-case and dotted names split apart. */
function wordsOf(text: string): readonly string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** How many of the tokens appear among a text's words. */
function score(tokens: ReadonlySet<string>, ...texts: readonly string[]): number {
  let found = 0;
  const words = new Set(texts.flatMap((text) => wordsOf(text)));
  for (const token of tokens) if (words.has(token)) found += 1;
  return found;
}

/**
 * The specification the evidence is read from: the candidate's, when one was
 * built and is on disk, else the current release's.
 *
 * The candidate first, because it is the newest thing the engineer made: a
 * route it added an hour ago is in the candidate and not yet in what is
 * running.
 */
function specOf(layout: Layout, appId: string): AppSpec | null {
  const app = layout.app(appId);
  const ids: string[] = [];
  try {
    const stored = JSON.parse(readFileSync(app.candidate, 'utf8')) as { releaseId?: unknown };
    if (typeof stored.releaseId === 'string') ids.push(stored.releaseId);
  } catch {
    // No candidate on record.
  }
  const current = readCurrent(layout, appId);
  if (current !== null) ids.push(current);
  for (const id of ids) {
    try {
      return readRelease(layout, appId, id);
    } catch {
      // Gone, stale or unreadable: try the next one.
    }
  }
  return null;
}

/** Every component on every page, with the page it is on. */
function componentsOf(pages: readonly Page[]): { component: Component; page: Page }[] {
  const out: { component: Component; page: Page }[] = [];
  const walk = (components: readonly Component[], page: Page): void => {
    for (const component of components) {
      out.push({ component, page });
      if (component.children !== undefined) walk(component.children, page);
    }
  };
  for (const page of pages) walk(page.children, page);
  return out;
}

/** The routes a component calls or reads. */
function routesOf(component: Component, page: Page): readonly string[] {
  const out: string[] = [];
  if (component.submit !== undefined) out.push(component.submit.operation);
  if (component.action !== undefined) out.push(component.action.operation);
  for (const action of component.rowActions ?? []) out.push(action.operation);
  if (component.source !== undefined) {
    const source = page.sources?.find((entry) => entry.id === component.source);
    if (source !== undefined) out.push(source.operation);
  }
  return out;
}

/** The migration id after `last`, keeping its number's width. */
function nextMigrationId(last: string | undefined): string {
  const match = last === undefined ? null : /^(\d+)-/.exec(last);
  if (match?.[1] === undefined) return '001-<slug>';
  const next = String(Number(match[1]) + 1).padStart(match[1].length, '0');
  return `${next}-<slug>`;
}

/** `path:line`, or nothing. */
function where(symbol: IndexedSymbol | undefined): string {
  return symbol === undefined ? '' : ` ${symbol.file}:${String(symbol.line)}`;
}

/** The fixed rules every change meets, said once. */
const CONSTRAINTS =
  'Constraints: every route needs effect and summary · a component keeps its id · autoapp.json and src/ only · spec.reference has the rules of each file';

/** The two context files a person may leave at the root of a workspace. */
const CONTEXT_FILES: readonly string[] = ['PRODUCT.md', 'DESIGN.md'];

/**
 * The context line: which brief files exist, and the first thing each says.
 *
 * A file nobody wrote is not mentioned at all. The snippet is the first line
 * that is not a heading, cut short, which is enough for the engineer to know
 * whether reading the whole thing is worth a turn — and the topic that depends
 * on it (`design` for `PRODUCT.md`, `theme` for `DESIGN.md`) says what to do
 * with it once read.
 */
/** How much of a context file the evidence reads: enough for its first line. */
const CONTEXT_HEAD_BYTES = 4_096;

function contextLine(sourceDir: string): string | undefined {
  const parts: string[] = [];
  for (const name of CONTEXT_FILES) {
    let text: string;
    try {
      const file = within(sourceDir, name);
      const stat = lstatSync(file);
      if (!stat.isFile()) continue;
      // A person's file, of any size; only its first prose line is wanted, so
      // read only the head rather than the whole of whatever they wrote.
      const head = new Uint8Array(Math.min(stat.size, CONTEXT_HEAD_BYTES));
      const fd = openSync(file, 'r');
      try {
        readSync(fd, head, 0, head.length, 0);
      } finally {
        closeSync(fd);
      }
      text = new TextDecoder().decode(head);
    } catch {
      continue;
    }
    const first = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#'));
    parts.push(first === undefined ? name : `${name} (${cut(first, 80)})`);
  }
  return parts.length === 0 ? undefined : `Context: ${parts.join(' · ')}`;
}

/**
 * The evidence for one request's words in one application.
 *
 * Grouped by kind and bounded per kind. When nothing matches, it says so in
 * one line and lists the workspace's main files with their sizes — what
 * `source.list` would have said — so the engineer loses nothing by having it
 * before it asks.
 */
export function taskEvidence(input: {
  readonly layout: Layout;
  readonly appId: string;
  readonly tokens: readonly string[];
  readonly index: SymbolIndex;
}): TaskEvidence {
  const { layout, appId, index } = input;
  const wanted = new Set(input.tokens.map((token) => token.toLowerCase()));
  const spec = specOf(layout, appId);
  const entries: EvidenceEntry[] = [];
  const lines = [`## Evidence for "${input.tokens.join(' ')}" in ${appId}`];

  const components = spec === null ? [] : componentsOf(spec.views.pages);
  const shownBy = new Map<string, string[]>();
  for (const { component, page } of components) {
    for (const route of routesOf(component, page)) {
      const list = shownBy.get(route) ?? [];
      if (!list.includes(component.id)) list.push(component.id);
      shownBy.set(route, list);
    }
  }

  // Routes, best match first.
  const routes = Object.entries(spec?.contract.operations ?? {})
    .map(([name, route]) => ({ name, route, score: score(wanted, name, route.summary) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .slice(0, MAX_ROUTES);
  const matchedRoutes = new Set(routes.map((entry) => entry.name));
  const routeLines = routes.map(({ name, route }) => {
    entries.push({ kind: 'route', name, confidence: 'declared', note: `${route.effect} — ${route.summary}` });
    const handler = index.symbols.find((symbol) => symbol.kind === 'operation' && symbol.name === name);
    let text = `${name} (${route.effect}) — ${cut(route.summary, 80)}`;
    if (handler === undefined) {
      entries.push({ kind: 'symbol', name, confidence: 'unknown', note: 'handler: use source.search' });
      text += ' · handler: unknown — use source.search';
    } else {
      entries.push({ kind: 'symbol', name, file: handler.file, line: handler.line, confidence: 'pattern', note: 'handler' });
      text += ` · handler ${handler.file}:${String(handler.line)} [pattern]`;
    }
    const shown = shownBy.get(name) ?? [];
    if (shown.length > 0) text += ` · shown by ${shown.slice(0, 3).join(', ')} [declared]`;
    return text;
  });
  if (routeLines.length > 0) lines.push(`Routes: ${routeLines.join('\n        ')}`);

  const views = components
    .map((entry) => ({ ...entry, score: score(wanted, entry.component.id, entry.component.label ?? '') }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_VIEWS);
  const viewLines = views.map(({ component, page }) => {
    const symbol = index.symbols.find((entry) => entry.kind === 'component' && entry.name === component.id);
    entries.push({
      kind: 'view',
      name: component.id,
      confidence: 'declared',
      note: `page ${page.id}`,
      ...(symbol === undefined ? {} : { file: symbol.file, line: symbol.line }),
    });
    return `${component.id} (page ${page.id})${where(symbol)} [declared]`;
  });
  if (viewLines.length > 0) lines.push(`Views: ${viewLines.join('\n       ')}`);

  const examples = (spec?.acceptance ?? [])
    .map((example) => {
      // Route steps name routes; view steps name pages and components, which the view lines above already cover.
      const touches = example.steps.flatMap((step) => ('route' in step && step.route !== undefined ? [step.route] : []));
      const hit = score(wanted, example.id, example.title) + touches.filter((route) => matchedRoutes.has(route)).length;
      return { example, touches, hit };
    })
    .filter((entry) => entry.hit > 0)
    .sort((a, b) => b.hit - a.hit)
    .slice(0, MAX_EXAMPLES);
  if (examples.length > 0) {
    lines.push(
      `Acceptance: ${examples
        .map(({ example, touches }) => {
          entries.push({ kind: 'example', name: example.id, file: SOURCE.manifest, confidence: 'declared', note: touches.join(', ') });
          return `${example.id} (touches ${[...new Set(touches)].join(', ')}) [declared]`;
        })
        .join(' · ')}`,
    );
  }

  const symbols = index.symbols
    .filter((symbol) => symbol.kind === 'export' || symbol.kind === 'function')
    .map((symbol) => ({ symbol, score: score(wanted, symbol.name) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SYMBOLS);
  if (symbols.length > 0) {
    lines.push(
      `Symbols: ${symbols
        .map(({ symbol }) => {
          entries.push({ kind: 'symbol', name: symbol.name, file: symbol.file, line: symbol.line, confidence: 'pattern' });
          return `${symbol.name} ${symbol.file}:${String(symbol.line)} [pattern]`;
        })
        .join(' · ')}`,
    );
  }

  if (entries.length === 0) {
    const sizes = Object.values(SOURCE).map((path) => {
      try {
        return `${path} ${String(statSync(join(layout.app(appId).source, path)).size)} bytes`;
      } catch {
        return `${path} missing`;
      }
    });
    lines.push(`Nothing in ${appId} matched these words. Its main files: ${sizes.join(' · ')}`);
    return { appId, text: cut(lines.join('\n'), EVIDENCE_MAX_CHARS), entries };
  }

  const migrations = spec?.migrations ?? [];
  const last = migrations[migrations.length - 1]?.id;
  lines.push(
    `Migrations: ${String(migrations.length)}${last === undefined ? '' : `, last ${last}`}; next id ${nextMigrationId(last)}; append only [constraint]`,
  );
  entries.push({ kind: 'constraint', name: 'migrations', confidence: 'declared', note: `next ${nextMigrationId(last)}` });
  lines.push(CONSTRAINTS);
  entries.push({ kind: 'constraint', name: 'rules', confidence: 'declared' });
  const context = contextLine(layout.app(appId).source);
  if (context !== undefined) {
    lines.push(context);
    entries.push({ kind: 'constraint', name: 'context', confidence: 'declared', note: context });
  }
  return { appId, text: cut(lines.join('\n'), EVIDENCE_MAX_CHARS), entries };
}
