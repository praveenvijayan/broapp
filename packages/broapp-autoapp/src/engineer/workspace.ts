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
import type { PublicError } from 'broapp/shared';

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

/** One exact find-and-replace in one file. */
export interface Hunk {
  readonly path: string;
  /** Exact text to find. Must occur exactly once in the file. */
  readonly find: string;
  readonly replace: string;
}

/** Which pass of {@link applyEdits} found a hunk. */
export type MatchedBy = 'exact' | 'indent';

/** What {@link applyEdits} did. */
export interface EditResult {
  readonly changed: readonly string[];
  readonly undo: 'git' | 'source-history';
  /** How each hunk matched, in the order the hunks were given. */
  readonly matchedBy?: readonly MatchedBy[];
}

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

/** One line `searchWorkspace` found. */
export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** The most lines one search returns, and the longest line it quotes. */
const MAX_SEARCH_HITS = 50;
const MAX_HIT_CHARS = 200;

/**
 * Find a pattern in the workspace's readable files.
 *
 * Over the same list `readTree` gives, so nothing outside the workspace, nothing
 * excluded and nothing unreadable is ever searched, and every path returned is
 * workspace-relative. `files` is a glob over those paths, not a path of its
 * own: a glob that tries to climb out matches nothing, because nothing listed
 * starts with `..`.
 */
export function searchWorkspace(
  sourceDir: string,
  pattern: string,
  options: { readonly literal?: boolean; readonly files?: string } = {},
): { hits: SearchHit[]; truncated: boolean } {
  let matcher: RegExp;
  try {
    matcher = new RegExp(options.literal === true ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern);
  } catch (cause) {
    throw publicError.invalidInput(
      `the pattern is not a regular expression: ${String(cause instanceof Error ? cause.message : cause)}`,
    );
  }
  const glob = new Bun.Glob(options.files ?? 'src/**');
  const hits: SearchHit[] = [];
  for (const entry of readTree(sourceDir)) {
    if (!glob.match(entry.path) || entry.bytes > MAX_FILE_BYTES) continue;
    let text: string;
    try {
      text = readFileSync(within(sourceDir, entry.path), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!matcher.test(line)) continue;
      // One past the limit is how "there were more" is known without counting them all.
      if (hits.length === MAX_SEARCH_HITS) return { hits, truncated: true };
      hits.push({ path: entry.path, line: index + 1, text: line.slice(0, MAX_HIT_CHARS) });
    }
  }
  return { hits, truncated: false };
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
): EditResult {
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

  const git = keepHistory(sourceDir, targets);

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

  return finish(sourceDir, changed, message, git);
}

/**
 * Apply find-and-replace hunks.
 *
 * The reason this exists rather than `applyChange` alone: `source.change`
 * takes the whole new contents of a file, and report 07 measured a local model
 * spending twenty-two minutes composing one such call for a five-file change
 * without emitting it. The cost was linear in the size of the files rather
 * than in the size of the change. A hunk is proportional to the edit.
 *
 * Every hunk is checked against the file before any file is written, and the
 * new contents are computed in memory first, so a set of hunks either all land
 * or none do. A half-applied edit is worse than a refused one: the model would
 * have to work out which half.
 *
 * A hunk matches exactly, or line for line with leading whitespace ignored;
 * see {@link locate} for why there is no third, looser pass.
 */
export function applyEdits(
  sourceDir: string,
  hunks: readonly Hunk[],
  message: string,
): EditResult {
  if (hunks.length === 0) throw publicError.invalidInput('no hunks were given');

  /** The new contents of each file, in hunk order, before anything is written. */
  const buffers = new Map<string, { target: string; content: string }>();
  /** Which pass matched each hunk, so a caller can see when the file's own indentation was used. */
  const matchedBy: MatchedBy[] = [];

  for (const hunk of hunks) {
    const path = asPosix(hunk.path);
    if (!WRITABLE.test(path)) {
      throw publicError.invalidInput(
        `${hunk.path} is not somewhere this application's source may be changed; only src/ and autoapp.json are`,
      );
    }
    const target = within(sourceDir, path);
    let current = buffers.get(path)?.content;
    if (current === undefined) {
      if (!existsSync(target)) {
        throw publicError.notFound(`${hunk.path} is not there; use source.change to create a file`);
      }
      current = readFileSync(target, 'utf8');
    }

    if (hunk.find === '') {
      throw publicError.invalidInput(`the hunk for ${hunk.path} has nothing to find`);
    }

    // Two hunks on one file apply in order to the same buffer, so the second
    // sees what the first left. Anything else would make the order of a list
    // silently matter in a way nobody could see.
    const found = locate(current, hunk, hunk.path);
    if (Buffer.byteLength(found.content, 'utf8') > MAX_FILE_BYTES) {
      throw publicError.invalidInput(`${hunk.path} is larger than the ${String(MAX_FILE_BYTES)}-byte limit`);
    }
    matchedBy.push(found.matchedBy);
    buffers.set(path, { target, content: found.content });
  }

  const targets = [...buffers.entries()].map(([path, one]) => ({ path, target: one.target }));
  const git = keepHistory(sourceDir, targets);

  const changed: string[] = [];
  for (const [path, one] of buffers) {
    writeFileSync(one.target, one.content);
    changed.push(path);
  }

  return { ...finish(sourceDir, changed, message, git), matchedBy };
}

/**
 * Find one hunk in one file, and return the file with it replaced.
 *
 * Two passes, and only two. Exact first, so a hunk that reproduces the file
 * byte for byte can never be pulled onto something else. Then line-wise with
 * leading whitespace ignored, because report 08b measured three of four
 * approved edits failing on indentation in text `source.read` had just handed
 * the model verbatim — it reads a file correctly and then cannot type the
 * spaces back.
 *
 * There is no third, fuzzier pass, and there should not be. A hunk that
 * matches something the model did not mean is worse than one that fails: the
 * failure costs a turn, and the wrong match costs somebody's file, silently,
 * inside a change they already approved. Whitespace is safe to ignore because
 * it does not change what the code means; nothing else is.
 */
function locate(
  current: string,
  hunk: Hunk,
  path: string,
): { readonly content: string; readonly matchedBy: MatchedBy } {
  const exact = occurrences(current, hunk.find);
  if (exact.length > 1) {
    throw ambiguous(path, exact.map((at) => lineOf(current, at)));
  }
  const first = exact[0];
  if (first !== undefined) {
    return {
      content: current.slice(0, first) + hunk.replace + current.slice(first + hunk.find.length),
      matchedBy: 'exact',
    };
  }

  const fileLines = current.split('\n');
  const wanted = toLines(hunk.find);
  const starts = lineWise(fileLines, wanted);
  if (starts.length > 1) {
    throw ambiguous(path, starts.map((start) => start + 1));
  }
  const start = starts[0];
  if (start === undefined) throw notFound(path, hunk.find, fileLines);

  const matched = fileLines.slice(start, start + wanted.length);
  const replaced = reindent(matched, toLines(hunk.replace));
  return {
    content: [
      ...fileLines.slice(0, start),
      ...replaced,
      ...fileLines.slice(start + wanted.length),
    ].join('\n'),
    matchedBy: 'indent',
  };
}

/** Every character offset at which `needle` occurs, without overlapping. */
function occurrences(haystack: string, needle: string): readonly number[] {
  const out: number[] = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    out.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return out;
}

/** The one-based line a character offset falls on. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * The lines of a hunk's text, with a trailing newline read as a separator.
 *
 * `"a\n"` is one line, not two: the empty string after the last newline is how
 * `split` says the text ended, not a line the file has to contain.
 */
function toLines(text: string): readonly string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line with its leading and trailing whitespace gone. */
function bare(line: string): string {
  return line.trim();
}

/** The leading whitespace of a line, tabs and spaces alike. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** Every line at which `wanted` matches, comparing lines without their indentation. */
function lineWise(fileLines: readonly string[], wanted: readonly string[]): readonly number[] {
  const out: number[] = [];
  if (wanted.length === 0) return out;
  const stripped = wanted.map(bare);
  for (let start = 0; start + stripped.length <= fileLines.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < stripped.length; offset += 1) {
      if (bare(fileLines[start + offset] ?? '') !== stripped[offset]) {
        same = false;
        break;
      }
    }
    if (same) out.push(start);
  }
  return out;
}

/**
 * The replacement, wearing the file's indentation rather than the model's.
 *
 * Line for line when the counts are equal, which is the ordinary case: each
 * replacement line takes the indentation of the line it stands in for, so a
 * file indented with tabs stays indented with tabs however the hunk was typed.
 *
 * When the counts differ the anchor is the first matched line's indentation.
 * A replacement line the model left flush against the margin is written flush,
 * and one it indented is written at the anchor — plus whatever it indented
 * *beyond* its own shallowest line, so a nested block keeps its nesting. With
 * one level throughout, that extra is empty and the rule is exactly the anchor.
 */
function reindent(matched: readonly string[], replace: readonly string[]): readonly string[] {
  if (replace.length === matched.length) {
    return replace.map((line, index) => {
      const body = line.trimStart();
      return body === '' ? '' : indentOf(matched[index] ?? '') + body;
    });
  }
  const anchor = indentOf(matched[0] ?? '');
  const indents = replace
    .filter((line) => line.trim() !== '' && /^[ \t]/.test(line))
    .map(indentOf);
  const shallowest = sharedPrefix(indents);
  return replace.map((line) => {
    const body = line.trimStart();
    if (body === '') return '';
    if (!/^[ \t]/.test(line)) return body;
    return anchor + indentOf(line).slice(shallowest.length) + body;
  });
}

/** The longest string every one of `values` starts with. */
function sharedPrefix(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) return '';
  let length = first.length;
  for (const value of values) {
    let index = 0;
    while (index < length && index < value.length && value[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length);
}

/** A hunk that matched in more than one place, with every line it matched on. */
function ambiguous(path: string, lines: readonly number[]): PublicError {
  return publicError.invalidInput(
    `ambiguous in ${path}: ${String(lines.length)} matches, include more context (lines ${lines.join(', ')})`,
  );
}

/**
 * A hunk that matched nowhere, with the nearest real line quoted.
 *
 * The nearest line is what makes this useful rather than merely true. A model
 * that has just been told "not found" will retype the same hunk; one that has
 * been shown the line it nearly matched can see what it got wrong.
 */
function notFound(path: string, find: string, fileLines: readonly string[]): PublicError {
  const first = toLines(find)[0] ?? '';
  const target = bare(first);
  let bestLine = -1;
  let bestScore = -1;
  for (let index = 0; index < fileLines.length; index += 1) {
    const candidate = bare(fileLines[index] ?? '');
    if (candidate === '') continue;
    let score = 0;
    while (score < target.length && score < candidate.length && target[score] === candidate[score]) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  }
  const said = `not found in ${path}: ${excerpt(first)}`;
  if (bestLine < 0 || bestScore <= 0) return publicError.invalidInput(`${said}.`);
  return publicError.invalidInput(
    `${said}. Closest line ${String(bestLine + 1)}: "${fileLines[bestLine] ?? ''}"`,
  );
}

/** The first line and a bit of a `find`, for a message that says which hunk. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 40 ? flat : `${flat.slice(0, 40)}…`;
}

/**
 * Keep a copy of everything about to change, and say whether git will.
 *
 * Written before anything is touched, so a failure partway leaves the history
 * complete rather than covering only what happened to go first.
 */
function keepHistory(
  sourceDir: string,
  targets: readonly { path: string; target: string }[],
): boolean {
  const git = hasGit(sourceDir);
  if (git) return true;
  const history = join(dirname(sourceDir), 'source-history', String(Date.now()));
  for (const { path, target } of targets) {
    if (!existsSync(target)) continue;
    const kept = join(history, path);
    mkdirSync(dirname(kept), { recursive: true, mode: 0o700 });
    writeFileSync(kept, readFileSync(target));
  }
  return false;
}

/** Commit, when there is a repository to commit to, and report the way back. */
function finish(
  sourceDir: string,
  changed: readonly string[],
  message: string,
  git: boolean,
): EditResult {
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
