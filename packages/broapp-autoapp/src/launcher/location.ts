/**
 * Where an application's source workspace lives, when a person chose.
 *
 * Every workspace used to be `<root>/apps/<appId>/source/`, inside the
 * launcher's own data directory, where nobody keeps their projects. A person
 * may now name a folder, and the workspace is made at `<folder>/<appId>/`. A
 * pointer beside the application's releases, `location.json`, says so; only
 * `layout.app()` reads it.
 *
 * Only the source moves. Releases, data, snapshots and the trash stay under
 * the root, because activation and removal are renames and a rename is atomic
 * only on one volume.
 *
 * Three rules run through this file.
 *
 * **A folder is checked before anything is written.** {@link checkLocation}
 * is about the person's folder, not about the id, so it runs before the
 * directory that is the id's lock is made, and a refusal costs nothing. The
 * checks are racy — somebody can make the target a moment after they pass —
 * and creation handles that where the target is really made.
 *
 * **A folder a person chose is never recreated.** A workspace that has gone —
 * renamed, deleted, on a drive that is not plugged in — is said in one
 * sentence by {@link requireSource}, and nothing here or anywhere else makes a
 * directory in its place: on an unplugged drive `/Volumes/X/…` does not exist,
 * and a helpful recursive `mkdir` would write an empty project onto the boot
 * disk under a name about to be shadowed.
 *
 * **State is computed when asked.** Nothing is cached, so a drive plugged back
 * in is `present` on the next call without a restart.
 */
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { publicError } from 'broapp/host';

import {
  APP_ID_PATTERN,
  isWithin,
  LOCATION_VERSION,
  readCurrent,
  readRelease,
  type Layout,
} from '../spec/index.ts';

import { appIds } from './apps.ts';
import { LOCATION_WORDS, workspaceSentence, type WordsPlatform, type WorkspaceState } from './location-words.ts';

/** The longest location a person may give, matching the route's schema. */
export const MAX_LOCATION = 1024;

/** What {@link normaliseLocation} and {@link checkLocation} may be told instead of asking the system. */
export interface LocationOptions {
  /** The home directory `~` stands for. Default `os.homedir()`; a test replaces it. */
  readonly home?: () => string;
  /** Which platform's sentences. Default this process's. */
  readonly platform?: WordsPlatform;
}

/** A refusal: its sentence, and whether it is a conflict rather than bad input. */
export interface LocationProblem {
  readonly problem: string;
  readonly conflict: boolean;
}

/** A checked location: the folder the person meant, and where the workspace would be made. */
export type LocationCheck =
  | { readonly ok: true; readonly location: string; readonly target: string; readonly notes: readonly string[] }
  | ({ readonly ok: false } & LocationProblem);

function platformOf(options: LocationOptions): WordsPlatform {
  return options.platform ?? (process.platform === 'darwin' ? 'darwin' : 'other');
}

/** The error code of something thrown by `node:fs`, if it has one. */
function codeOf(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The real path of something that may not exist, or the resolved path when it does not. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The sentence for an id that is not one. The same rule `createApplication`
 * enforces; here so the live check can say it before Create is pressed.
 */
export function idProblem(appId: string): string {
  return `An application id must be 3 to 40 lowercase letters, digits or hyphens, starting with a letter. ${JSON.stringify(appId)} is not.`;
}

/**
 * Turn what a person typed into the folder they meant, or refuse it.
 *
 * In this order, and in one place: a NUL character is refused; a leading `~`
 * or `~/` is the home directory, and `~name` — somebody else's — is refused
 * because it cannot be worked out portably; a path that is still not absolute
 * is refused; and then `resolve()`, which removes `a/../b` and a trailing
 * separator. The result is what is stored and shown — not its `realpath`,
 * because a person is shown what they chose.
 */
export function normaliseLocation(
  input: string,
  options: LocationOptions = {},
): { readonly ok: true; readonly path: string } | ({ readonly ok: false } & LocationProblem) {
  if (input.includes('\0')) return { ok: false, problem: LOCATION_WORDS.nul(), conflict: false };
  let expanded = input;
  if (input === '~' || input.startsWith('~/') || input.startsWith('~\\')) {
    expanded = join((options.home ?? homedir)(), input.slice(1));
  } else if (input.startsWith('~')) {
    return { ok: false, problem: LOCATION_WORDS.otherHome(input), conflict: false };
  }
  if (!isAbsolute(expanded)) return { ok: false, problem: LOCATION_WORDS.notAbsolute(input), conflict: false };
  return { ok: true, path: resolve(expanded) };
}

/** Where every application but `except` keeps its workspace, as real paths. */
function otherWorkspaces(root: Layout, except: string): readonly { appId: string; dir: string }[] {
  const found: { appId: string; dir: string }[] = [];
  for (const other of appIds(root)) {
    if (other === except) continue;
    const app = root.app(other);
    const where = app.sourceLocation;
    // An unreadable pointer names nothing that can be compared; its default
    // path is inside the root, which is refused on its own.
    if (where.kind === 'unreadable') continue;
    found.push({ appId: other, dir: realOrResolved(app.source) });
  }
  return found;
}

/** Whether a folder's path looks like one a cloud service keeps in step. */
export function looksSynced(path: string): boolean {
  return /(?:^|[\\/])(?:Mobile Documents|OneDrive[^\\/]*|Dropbox|Google Drive)(?:[\\/]|$)/.test(path);
}

/**
 * The checks on a folder that are about the folder, before anything is written.
 *
 * Used by `launcher.appCreate`, `create --at`, `launcher.locationCheck` and —
 * the parts about where a workspace may be — `launcher.appLocate`, so every
 * one of them refuses the same folders with the same sentence.
 */
export function checkLocation(
  root: Layout,
  appId: string,
  input: string,
  options: LocationOptions = {},
): LocationCheck {
  if (!APP_ID_PATTERN.test(appId)) return { ok: false, problem: idProblem(appId), conflict: false };
  const normal = normaliseLocation(input, options);
  if (!normal.ok) return normal;
  const location = normal.path;

  let stats;
  try {
    stats = statSync(location);
  } catch (cause) {
    const code = codeOf(cause);
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, problem: LOCATION_WORDS.notWritable(location, platformOf(options)), conflict: false };
    }
    if (code === 'ENAMETOOLONG') return { ok: false, problem: LOCATION_WORDS.pathTooLong(location), conflict: false };
    return { ok: false, problem: LOCATION_WORDS.doesNotExist(location), conflict: false };
  }
  if (!stats.isDirectory()) return { ok: false, problem: LOCATION_WORDS.notADirectory(location), conflict: false };

  const real = realOrResolved(location);
  // Another application's workspace first: it is the more useful sentence when
  // that workspace is also inside the root, and the rule it names is the one
  // that matters — one engineer must never be confined to a folder holding
  // another application's files.
  for (const other of otherWorkspaces(root, appId)) {
    if (isWithin(other.dir, real)) {
      return { ok: false, problem: LOCATION_WORDS.insideWorkspace(location, other.appId), conflict: false };
    }
  }
  if (isWithin(realOrResolved(root.root), real) || isWithin(resolve(root.root), location)) {
    return { ok: false, problem: LOCATION_WORDS.insideRoot(location), conflict: false };
  }

  try {
    accessSync(location, constants.W_OK);
  } catch (cause) {
    if (codeOf(cause) === 'EROFS') return { ok: false, problem: LOCATION_WORDS.readOnly(location), conflict: false };
    return { ok: false, problem: LOCATION_WORDS.notWritable(location, platformOf(options)), conflict: false };
  }

  const target = join(location, appId);
  // `lstat`, not `exists`: a dangling link at the target is still a name
  // somebody put there, and `mkdir` would refuse it anyway.
  let taken = true;
  try {
    lstatSync(target);
  } catch (cause) {
    taken = codeOf(cause) !== 'ENOENT';
  }
  if (taken) return { ok: false, problem: LOCATION_WORDS.targetExists(target), conflict: true };

  return { ok: true, location, target, notes: looksSynced(location) ? [LOCATION_WORDS.synced(location)] : [] };
}

/** A creation's step-4 failure, as the sentence a person reads. */
export function writeFailure(cause: unknown, location: string, target: string, platform: WordsPlatform): string {
  switch (codeOf(cause)) {
    case 'EEXIST':
      return LOCATION_WORDS.targetExists(target);
    case 'ENOSPC':
      return LOCATION_WORDS.diskFull(target);
    case 'ENAMETOOLONG':
      return LOCATION_WORDS.pathTooLong(target);
    case 'EROFS':
      return LOCATION_WORDS.readOnly(location);
    case 'EACCES':
    case 'EPERM':
      return LOCATION_WORDS.notWritable(location, platform);
    default:
      return String(cause instanceof Error ? cause.message : cause);
  }
}

/** What {@link sourceState} found. */
export interface SourceStateResult {
  readonly state: WorkspaceState;
  /** Where the workspace should be; `null` only when the pointer could not be read. */
  readonly dir: string | null;
  /** Whether a person chose where it lives, including a pointer that cannot be read. */
  readonly chosen: boolean;
  /** Why the pointer could not be read, for `unreadable`. */
  readonly reason?: string;
}

/**
 * Where an application's workspace is, and whether it is there, without throwing.
 *
 * For lists, which must list everything whatever state one entry is in.
 * `denied` is a directory that exists and cannot be read: on macOS a folder in
 * Desktop, Documents or Downloads the launcher has not been given stats fine
 * and refuses its listing, so the listing is what is tried.
 */
export function sourceState(root: Layout, appId: string): SourceStateResult {
  const app = root.app(appId);
  const where = app.sourceLocation;
  if (where.kind === 'unreadable') return { state: 'unreadable', dir: null, chosen: true, reason: where.reason };
  const dir = app.source;
  const chosen = where.kind === 'chosen';
  let stats;
  try {
    stats = statSync(dir);
  } catch (cause) {
    const code = codeOf(cause);
    return { state: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'missing', dir, chosen };
  }
  if (!stats.isDirectory()) return { state: 'not-a-directory', dir, chosen };
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
    readdirSync(dir);
  } catch {
    return { state: 'denied', dir, chosen };
  }
  return { state: 'present', dir, chosen };
}

/** The name a person knows an application by, from its current release, else its id. */
function nameOf(root: Layout, appId: string): string {
  try {
    const current = readCurrent(root, appId);
    if (current !== null) return readRelease(root, appId, current).manifest.name;
  } catch {
    // A release that will not read has no better name than the id.
  }
  return appId;
}

/** The sentence for an application's workspace, or `null` when it is present. */
export function sourceProblem(root: Layout, appId: string): string | null {
  const found = sourceState(root, appId);
  if (found.state === 'present') return null;
  return workspaceSentence({
    state: found.state,
    appId,
    name: nameOf(root, appId),
    dir: found.dir,
    ...(found.reason === undefined ? {} : { reason: found.reason }),
  });
}

/**
 * The workspace directory, or the sentence for why it cannot be used.
 *
 * Everything that reads or writes a workspace comes through here: a build, the
 * engineer's `source.*` tools, a backlog run, `build` and `import` at the
 * command line. What does not — opening, serving, activating a built release,
 * rollback, snapshots, removal — works on releases, which are self-contained,
 * so an application whose workspace has gone still opens.
 */
export function requireSource(root: Layout, appId: string): string {
  const problem = sourceProblem(root, appId);
  if (problem !== null) throw publicError.unavailable(problem);
  return root.app(appId).source;
}

/** What {@link writeLocation} may be given instead of the real `renameSync`. */
export interface WriteLocationOptions {
  readonly rename?: (from: string, to: string) => void;
}

/**
 * Write an application's pointer, whole or not at all.
 *
 * A temporary file, then a rename, as `launcher.json` is written: a pointer
 * that is half there would be `unreadable`, and a rename either happened or
 * did not. Mode 0600, set explicitly because `writeFileSync`'s is subject to
 * the umask.
 */
export function writeLocation(root: Layout, appId: string, source: string, options: WriteLocationOptions = {}): void {
  const file = root.app(appId).location;
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: LOCATION_VERSION, source }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  try {
    (options.rename ?? renameSync)(temporary, file);
  } catch (cause) {
    // The temporary file is ours and nothing else names it; the pointer that
    // was there before is untouched.
    rmSync(temporary, { force: true });
    throw cause;
  }
}

/**
 * Say where an application's workspace went.
 *
 * `sourceDir` is the workspace itself, not its parent: a person pointing at a
 * folder they moved. It has to hold this application's `autoapp.json`, and it
 * must not be inside the launcher's folder or another application's workspace.
 * Only a chosen workspace is relocated: a default one is in the launcher's own
 * folder and is not moved from here.
 */
export function locateApplication(
  root: Layout,
  appId: string,
  input: string,
  options: LocationOptions & WriteLocationOptions = {},
): { readonly dir: string } {
  if (!APP_ID_PATTERN.test(appId)) throw publicError.invalidInput(idProblem(appId));
  const app = root.app(appId);
  try {
    statSync(app.dir);
  } catch {
    throw publicError.notFound(`There is no application called ${appId}.`);
  }
  if (app.sourceLocation.kind === 'default') throw publicError.invalidInput(LOCATION_WORDS.locateDefault(appId));

  const normal = normaliseLocation(input, options);
  if (!normal.ok) throw publicError.invalidInput(normal.problem);
  const sourceDir = normal.path;

  let stats;
  try {
    stats = statSync(sourceDir);
  } catch {
    throw publicError.invalidInput(LOCATION_WORDS.doesNotExist(sourceDir));
  }
  if (!stats.isDirectory()) throw publicError.invalidInput(LOCATION_WORDS.notADirectory(sourceDir));

  const real = realOrResolved(sourceDir);
  for (const other of otherWorkspaces(root, appId)) {
    if (isWithin(other.dir, real)) throw publicError.invalidInput(LOCATION_WORDS.insideWorkspace(sourceDir, other.appId));
  }
  if (isWithin(realOrResolved(root.root), real) || isWithin(resolve(root.root), sourceDir)) {
    throw publicError.invalidInput(LOCATION_WORDS.insideRoot(sourceDir));
  }
  // And the other way round: a folder that holds another application's
  // workspace would confine this one's engineer to a place with that
  // application's files in it. Creation cannot meet this — its target does not
  // exist yet — but a folder a person points at can. After the root, whose
  // sentence is the better one for a folder that holds every default workspace.
  for (const other of otherWorkspaces(root, appId)) {
    if (isWithin(real, other.dir)) throw publicError.invalidInput(LOCATION_WORDS.holdsWorkspace(sourceDir, other.appId));
  }

  let owner: unknown;
  try {
    owner = (JSON.parse(readFileSync(join(sourceDir, 'autoapp.json'), 'utf8')) as { appId?: unknown }).appId;
  } catch {
    throw publicError.invalidInput(LOCATION_WORDS.locateWrong(sourceDir, appId));
  }
  if (owner !== appId) {
    throw publicError.invalidInput(
      typeof owner === 'string' && owner !== ''
        ? LOCATION_WORDS.locateWrongOwner(sourceDir, appId, owner)
        : LOCATION_WORDS.locateWrong(sourceDir, appId),
    );
  }

  writeLocation(root, appId, sourceDir, options);
  return { dir: sourceDir };
}
