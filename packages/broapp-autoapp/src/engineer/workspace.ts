/**
 * The source workspace, as something an agent may read and change.
 *
 * Every path here is resolved and then checked against the workspace root
 * before anything is opened or written. That check is the whole security story
 * of this file: the paths come from a model, which means they come from text,
 * which means `../../.ssh/id_rsa` is a thing that will eventually be asked for.
 * `resolve` collapses the `..` segments, and what is left either starts with
 * the root or is refused.
 *
 * Changes are undoable. With git the workspace is committed after every applied
 * change; without it the previous contents are written to a timestamped
 * directory first. Neither is a version-control system — they exist so that a
 * change an agent made can be looked at and reversed by a person.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { publicError } from 'broapp/host';

/** One file in the workspace. */
export interface TreeEntry {
  /** Relative to the workspace root, with forward slashes. */
  readonly path: string;
  readonly bytes: number;
}

/** One change to apply. */
export type FileChange =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly delete: true };

/** What the workspace looked like before a change, for the diff. */
export type Snapshot = ReadonlyMap<string, string>;

/** The most one file may be, read or written. */
const MAX_FILE_BYTES = 200_000;
/** The most a diff summary may be before it is cut short. */
const MAX_DIFF_BYTES = 20_000;

/** Directories that are never part of the workspace an agent sees. */
const EXCLUDED = new Set(['node_modules', 'dist', 'release', '.git', 'source-history']);

/** What may be read, and what may be written. */
const READABLE = /^(src\/|autoapp\.json$|package\.json$|broapp\.config\.ts$|tsconfig\.json$)/;
const WRITABLE = /^(src\/|autoapp\.json$)/;

/**
 * Resolve one workspace-relative path, or refuse it.
 *
 * `realpathSync` on the *root* rather than on the target: the target may not
 * exist yet, and a symlink in the root's own path (a temporary directory on
 * macOS, for one) would otherwise make every comparison fail.
 */
function within(sourceDir: string, path: string): string {
  const root = existsSync(sourceDir) ? realpathSync(sourceDir) : resolve(sourceDir);
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith('..') || resolve(root, inside) !== target) {
    throw publicError.invalidInput(`${path} is outside this application's workspace`);
  }
  // A symlink that already exists and points elsewhere is refused too: the
  // containment check above is about the name, and this is about the target.
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (real !== target && relative(root, real).startsWith('..')) {
      throw publicError.invalidInput(`${path} leads outside this application's workspace`);
    }
  }
  return target;
}

/** The workspace-relative form of a path, with forward slashes. */
function asPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Every file an agent may see, with its size. */
export function readTree(sourceDir: string): readonly TreeEntry[] {
  const root = existsSync(sourceDir) ? realpathSync(sourceDir) : resolve(sourceDir);
  const found: TreeEntry[] = [];

  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      if (EXCLUDED.has(name)) continue;
      const full = join(directory, name);
      const path = prefix === '' ? name : `${prefix}/${name}`;
      let stats;
      try {
        stats = statSync(full);
      } catch {
        // A broken symlink is not a file an agent can read; skipping it is more
        // useful than failing the whole listing.
        continue;
      }
      if (stats.isDirectory()) {
        walk(full, path);
        continue;
      }
      if (!stats.isFile()) continue;
      if (!READABLE.test(path)) continue;
      found.push({ path, bytes: stats.size });
    }
  };

  walk(root, '');
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** One file's text. */
export function readWorkspaceFile(sourceDir: string, path: string): string {
  const normalised = asPosix(path);
  if (!READABLE.test(normalised)) {
    throw publicError.invalidInput(`${path} is not part of this application's source`);
  }
  const target = within(sourceDir, normalised);
  const stats = statSync(target);
  if (!stats.isFile()) throw publicError.notFound(`${path} is not a file`);
  if (stats.size > MAX_FILE_BYTES) {
    throw publicError.invalidInput(
      `${path} is ${String(stats.size)} bytes, larger than the ${String(MAX_FILE_BYTES)}-byte limit`,
    );
  }
  return readFileSync(target, 'utf8');
}

/** Everything readable, as it is now. For a diff after a change. */
export function snapshot(sourceDir: string): Snapshot {
  const out = new Map<string, string>();
  for (const entry of readTree(sourceDir)) {
    if (entry.bytes > MAX_FILE_BYTES) continue;
    try {
      out.set(entry.path, readFileSync(within(sourceDir, entry.path), 'utf8'));
    } catch {
      // Binary or unreadable: it is not something a diff would help with.
    }
  }
  return out;
}

/**
 * True when the workspace is a git repository *of its own*.
 *
 * Not "is inside a work tree", which is what the obvious check answers — and
 * which is true for a workspace that happens to sit inside somebody else's
 * checkout. Committing there would put an agent's changes into their project's
 * history, which is a considerably worse outcome than having no undo.
 */
function hasGit(sourceDir: string): boolean {
  const probe = Bun.spawnSync({
    cmd: ['git', 'rev-parse', '--show-toplevel'],
    cwd: sourceDir,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (probe.exitCode !== 0) return false;
  const top = new TextDecoder().decode(probe.stdout).trim();
  if (top === '') return false;
  const here = existsSync(sourceDir) ? realpathSync(sourceDir) : resolve(sourceDir);
  return realpathSync(top) === here;
}

/**
 * Apply a set of changes, keeping a way back.
 *
 * With git, the workspace is committed afterwards, so `git log` and `git
 * revert` are the way back. Without it, the previous contents of everything
 * about to change are written to `source-history/<timestamp>/` first. The
 * point of both is the same: no change an agent makes is the only copy.
 */
export function applyChange(
  sourceDir: string,
  changes: readonly FileChange[],
  message: string,
): { changed: readonly string[]; undo: 'git' | 'source-history' } {
  const targets = changes.map((change) => {
    const path = asPosix(change.path);
    if (!WRITABLE.test(path)) {
      throw publicError.invalidInput(
        `${change.path} is not somewhere this application's source may be changed; only src/ and autoapp.json are`,
      );
    }
    if ('content' in change && Buffer.byteLength(change.content, 'utf8') > MAX_FILE_BYTES) {
      throw publicError.invalidInput(`${change.path} is larger than the ${String(MAX_FILE_BYTES)}-byte limit`);
    }
    return { change, path, target: within(sourceDir, path) };
  });

  const git = hasGit(sourceDir);
  if (!git) {
    // Written before anything is touched, so a failure partway leaves the
    // history complete rather than covering only what happened to go first.
    const history = join(dirname(sourceDir), 'source-history', String(Date.now()));
    for (const { path, target } of targets) {
      if (!existsSync(target)) continue;
      const kept = join(history, path);
      mkdirSync(dirname(kept), { recursive: true, mode: 0o700 });
      writeFileSync(kept, readFileSync(target));
    }
  }

  const changed: string[] = [];
  for (const { change, path, target } of targets) {
    if ('delete' in change) {
      rmSync(target, { force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, change.content);
    }
    changed.push(path);
  }

  if (git) {
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: sourceDir, stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync({
      cmd: ['git', 'commit', '--quiet', '--no-gpg-sign', '-m', message.slice(0, 500)],
      cwd: sourceDir,
      stdout: 'ignore',
      stderr: 'ignore',
      // A workspace with no configured identity would otherwise refuse to
      // commit, and the undo path is not worth failing a change over.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Autoapp engineer',
        GIT_AUTHOR_EMAIL: 'engineer@localhost',
        GIT_COMMITTER_NAME: 'Autoapp engineer',
        GIT_COMMITTER_EMAIL: 'engineer@localhost',
      },
    });
  }

  return { changed, undo: git ? 'git' : 'source-history' };
}

/**
 * A unified-ish diff of what changed.
 *
 * Deliberately small and dependency-free: line-by-line, with a few lines of
 * context, capped. It exists so a person can see what an agent did, not to be
 * fed back into `patch`.
 */
export function diffSummary(before: Snapshot, after: Snapshot): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: string[] = [];

  for (const path of paths) {
    const from = before.get(path);
    const to = after.get(path);
    if (from === to) continue;
    if (from === undefined) {
      out.push(`+++ ${path} (new, ${String((to ?? '').split('\n').length)} lines)`);
      continue;
    }
    if (to === undefined) {
      out.push(`--- ${path} (deleted)`);
      continue;
    }
    out.push(`--- ${path}`);
    for (const line of lineDiff(from.split('\n'), to.split('\n'))) out.push(line);
  }

  if (out.length === 0) return 'Nothing changed.';
  const text = out.join('\n');
  return text.length <= MAX_DIFF_BYTES
    ? text
    : `${text.slice(0, MAX_DIFF_BYTES)}\n… truncated at ${String(MAX_DIFF_BYTES)} characters.`;
}

/**
 * The changed lines of one file.
 *
 * A longest-common-subsequence diff would be nicer and is not worth the code:
 * this walks from both ends, which collapses the common prefix and suffix and
 * reports the middle. For the edits an engineer actually makes — a few lines in
 * a known place — the result reads the same.
 */
function lineDiff(from: readonly string[], to: readonly string[]): readonly string[] {
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head += 1;
  let tail = 0;
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = from.slice(head, from.length - tail);
  const added = to.slice(head, to.length - tail);
  return [
    `@@ line ${String(head + 1)} @@`,
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
  ];
}
