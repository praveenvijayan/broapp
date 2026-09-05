/**
 * Copying the template into a new project.
 *
 * Two properties are load-bearing:
 *
 * - **Nothing pre-existing is destroyed.** The generator refuses a non-empty
 *   destination up front, and if it fails part-way it removes only files it
 *   created. A generator that cleans up by deleting the destination is a
 *   generator that will one day delete somebody's work.
 *
 * - **No shell.** Substitution is string replacement over a fixed set of
 *   markers, and installation spawns `bun` as an argv array. There is nowhere
 *   for a name or a path to be interpreted as a command.
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Values substituted into the template. */
export interface TemplateValues {
  /** Package name and executable name. */
  readonly appName: string;
  /** Human-readable title shown in the UI and the browser tab. */
  readonly appTitle: string;
  readonly appDescription: string;
  /** The version range written for the `broapp` dependency. */
  readonly broappVersion: string;
}

/** Markers the template uses. Kept in one place so a new one cannot be missed. */
const MARKERS: readonly (keyof TemplateValues | string)[] = [
  '__APP_NAME__',
  '__APP_TITLE__',
  '__APP_DESCRIPTION__',
  '__BROAPP_VERSION__',
];

/** Files whose contents get marker substitution. Everything else is copied byte for byte. */
const SUBSTITUTED = /\.(?:ts|tsx|json|md|html|css)$/;

/** Files renamed on the way out, because npm will not ship some names verbatim. */
const RENAMES: ReadonlyMap<string, string> = new Map([
  // npm rewrites a packaged `.gitignore` to `.npmignore`, so the template
  // carries it under a neutral name and it is restored here.
  ['_gitignore', '.gitignore'],
]);

function substitute(text: string, values: TemplateValues): string {
  return text
    .replaceAll('__APP_NAME__', values.appName)
    .replaceAll('__APP_TITLE__', values.appTitle)
    .replaceAll('__APP_DESCRIPTION__', values.appDescription)
    .replaceAll('__BROAPP_VERSION__', values.broappVersion);
}

/** Any marker left after substitution is a bug in the template or in this list. */
function assertNoMarkersRemain(text: string, where: string): void {
  for (const marker of MARKERS) {
    if (text.includes(marker as string)) {
      throw new Error(`template marker ${marker as string} was not substituted in ${where}`);
    }
  }
}

/** Is `directory` absent, or present and empty? */
export async function isUsableDestination(directory: string): Promise<
  { readonly ok: true; readonly existed: boolean } | { readonly ok: false; readonly entries: string[] }
> {
  if (!existsSync(directory)) return { ok: true, existed: false };
  const info = await stat(directory);
  if (!info.isDirectory()) return { ok: false, entries: ['(not a directory)'] };
  const entries = await readdir(directory);
  // A destination holding only editor and VCS metadata is in practice empty.
  const meaningful = entries.filter((entry) => entry !== '.git' && entry !== '.DS_Store');
  return meaningful.length === 0 ? { ok: true, existed: true } : { ok: false, entries: meaningful };
}

/** What {@link scaffold} produced. */
export interface ScaffoldResult {
  readonly directory: string;
  readonly files: readonly string[];
}

/**
 * Copy the template to `destination`, substituting values.
 *
 * On failure, removes what it created and rethrows. Files that were already
 * there — the `.git` directory of a repository initialised beforehand, say —
 * are left untouched.
 */
export async function scaffold(
  templateDir: string,
  destination: string,
  values: TemplateValues,
): Promise<ScaffoldResult> {
  const target = resolve(destination);
  const created: string[] = [];
  const destinationExisted = existsSync(target);

  try {
    await mkdir(target, { recursive: true });
    await copyTree(templateDir, target, values, created);
    return { directory: target, files: created.map((file) => relative(target, file)) };
  } catch (cause) {
    // Remove only what this run wrote. `rm` on each file, then the directory
    // itself only if this run created it and it is now empty.
    for (const file of [...created].reverse()) {
      await rm(file, { force: true, recursive: true }).catch(() => undefined);
    }
    if (!destinationExisted) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    throw cause;
  }
}

async function copyTree(
  from: string,
  to: string,
  values: TemplateValues,
  created: string[],
): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') continue;

    const source = join(from, entry.name);
    const destinationName = RENAMES.get(entry.name) ?? entry.name;
    const destination = join(to, destinationName);

    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      created.push(destination);
      await copyTree(source, destination, values, created);
      continue;
    }

    if (SUBSTITUTED.test(entry.name)) {
      const text = await readFile(source, 'utf8');
      const written = substitute(text, values);
      assertNoMarkersRemain(written, relative(from, source));
      await writeFile(destination, written, 'utf8');
    } else {
      await cp(source, destination);
    }
    created.push(destination);
  }
}

/** Rename a directory, used when the generator needs to move a staged tree. */
export async function move(from: string, to: string): Promise<void> {
  await rename(from, to);
}
