#!/usr/bin/env bun
/**
 * The starter workspace a release ships next to the launcher.
 *
 * A downloaded launcher can only import a source workspace, and a person who
 * downloaded a binary has no monorepo to take one from. This copies the Notes
 * example, points its `workspace:*` dependencies at the published versions of
 * the packages in this tree, and writes a short note on what to do with it.
 * The release workflow zips the result next to the launcher archives.
 *
 *   bun run scripts/autoapp-starter.ts [outDir]
 *
 * The output is `<outDir>/notes-starter/`. `import` installs its dependencies
 * from the registry — the one moment Autoapp fetches anything — so the ranges
 * written here must name versions that are published, which is why they are
 * read from the packages' own manifests rather than typed in.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(root, 'packages', 'broapp-autoapp', 'dist'));
const target = join(outDir, 'notes-starter');

/** The published version of one package in this tree. */
function versionOf(name: string): string {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

rmSync(target, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(root, 'examples', 'notes'), target, {
  recursive: true,
  // A workspace is text. Builds, installs and the manual run directory are
  // this machine's, not the starter's.
  filter: (from) => !/(^|[\\/])(node_modules|dist|release|\.git|\.autoapp-manual)([\\/]|$)/.test(from),
});

const manifestPath = join(target, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  name: string;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
for (const [name, specifier] of Object.entries(manifest.dependencies)) {
  if (specifier === 'workspace:*') manifest.dependencies[name] = `^${versionOf(name)}`;
}
for (const [name, specifier] of Object.entries(manifest.devDependencies ?? {})) {
  if (specifier === 'workspace:*') manifest.devDependencies![name] = `^${versionOf(name)}`;
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

writeFileSync(
  join(target, 'GETTING-STARTED.md'),
  `# Notes, as an Autoapp starter

This is the Notes example from the Broapp repository, with its dependencies
pointed at the published packages. Import it with the launcher you downloaded:

\`\`\`
broapp-autoapp import ./notes-starter --as notes --grant
broapp-autoapp serve notes
\`\`\`

\`import\` installs the dependencies from npm — the only time the launcher
reaches the registry — builds the first release and makes it current. \`serve\`
starts it as its own process and opens a browser tab.

To change it, run \`broapp-autoapp\` with no arguments for the launcher's own
tab, choose a model provider in its settings, and describe the change. The
engineer proposes an edit, the launcher builds it as a candidate, and you
preview and activate it. Or edit the workspace under the launcher's data
directory yourself and run \`broapp-autoapp build notes\`.

An application runs as trusted local code: crash isolated from the launcher,
not permission isolated from you.
`,
  'utf8',
);

console.log(target);
for (const [name, specifier] of Object.entries(manifest.dependencies)) console.log(`  ${name} ${specifier}`);
