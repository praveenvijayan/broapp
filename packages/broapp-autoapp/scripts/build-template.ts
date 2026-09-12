#!/usr/bin/env bun
/**
 * Pack the starter workspaces into the launcher's binary.
 *
 * `templates/autoapp-starter/` and `templates/autoapp-blank/` are reviewed in
 * git as ordinary source workspaces. This turns them into one JSON file that
 * `src/launcher/main.ts` imports the way it imports its own page, so a
 * downloaded launcher carries two whole applications inside it and the **New
 * application** button has something to write whichever a person chooses.
 *
 * One file rather than two, because a launcher carrying one template and not
 * the other is a choice it cannot honour — and a `files` list is easier to get
 * right with one name in it than with two.
 *
 *   bun run --cwd packages/broapp-autoapp build:template
 *
 * The template is text and nothing else. A file that is not valid UTF-8 is
 * refused rather than mangled into the JSON, and a tree carrying a
 * `node_modules`, a `dist` or a `release` is refused outright: that is somebody
 * else's build, and shipping it inside the binary would be shipping whatever
 * their machine happened to have installed.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** What one packed template is, on disk and in the binary. */
export interface StarterTemplate {
  readonly files: Readonly<Record<string, string>>;
}

/** Both of them, under the names the route, the command and the tool use. */
export interface Templates {
  readonly starter: StarterTemplate;
  readonly blank: StarterTemplate;
}

/** The directory each one is packed from, relative to `templates/`. */
export const TEMPLATE_DIRS = {
  starter: 'autoapp-starter',
  blank: 'autoapp-blank',
} as const;

/** Directories that must not appear anywhere in a template tree. */
const FORBIDDEN = new Set(['node_modules', 'dist', 'release', '.git']);

/**
 * Names npm will not ship verbatim, restored when the template is written out.
 *
 * npm rewrites a packaged `.gitignore` to `.npmignore`, so the template carries
 * it under a neutral name — the same trick `templates/react-ts` uses — and the
 * real name is restored here, before it ever reaches a person's disk.
 */
const RENAMES: ReadonlyMap<string, string> = new Map([['_gitignore', '.gitignore']]);

/** Every file under `directory`, as forward-slashed paths relative to it. */
function walk(directory: string, prefix = ''): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (FORBIDDEN.has(entry.name)) {
      throw new Error(
        `${prefix}${entry.name} is in the template tree; a starter is source, not somebody's build`,
      );
    }
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(directory, entry.name), `${relative}/`));
    else out.push(relative);
  }
  return out;
}

/**
 * Read a template directory into the shape the binary carries.
 *
 * Exported so the test packs the same bytes the build does. Two implementations
 * of "what is in the starter" would drift, and the one that drifted would be
 * the one nobody was looking at.
 */
export function packTemplate(directory: string): StarterTemplate {
  const files: Record<string, string> = {};
  for (const relative of walk(directory)) {
    const bytes = readFileSync(join(directory, relative));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const segments = relative.split('/');
    const name = segments[segments.length - 1] ?? relative;
    const renamed = RENAMES.get(name);
    files[renamed === undefined ? relative : [...segments.slice(0, -1), renamed].join('/')] = text;
  }
  return { files };
}

function main(): number {
  const packageDir = resolve(import.meta.dir, '..');
  // `import.meta.dir` rather than a URL's `pathname`: on Windows the latter is
  // `/D:/a/...`, which resolves against the drive again and fails to open.
  const templatesDir = resolve(packageDir, '..', '..', 'templates');
  const to = join(packageDir, 'dist', 'templates.json');

  const templates: Templates = {
    starter: packTemplate(join(templatesDir, TEMPLATE_DIRS.starter)),
    blank: packTemplate(join(templatesDir, TEMPLATE_DIRS.blank)),
  };
  const json = `${JSON.stringify(templates, null, 2)}\n`;
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, json, 'utf8');

  const counts = Object.entries(templates)
    .map(([name, template]) => `${name} ${String(Object.keys(template.files).length)} files`)
    .join(', ');
  console.log(`templates  dist/templates.json  ${counts}  ${(json.length / 1024).toFixed(1)} KiB`);
  return 0;
}

// Only when run as a command. The test imports `packTemplate` from here.
if (import.meta.main) process.exit(main());
