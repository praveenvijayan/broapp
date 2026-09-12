#!/usr/bin/env bun
/**
 * The Autoapp release dry run.
 *
 * `scripts/release-dry-run.ts` proves that a *generated application* works from
 * the packed tarballs rather than from the workspace. This proves the same
 * thing for the launcher: it packs every publishable package, installs them in
 * a project outside the workspace, imports the Notes workspace through those
 * installed packages, and builds a candidate release from it.
 *
 * Two faults would otherwise reach npm unnoticed. A `files` list that leaves
 * out the launcher's own page, which `src/launcher/main.ts` imports and which
 * is not in git; and a `workspace:*` dependency that resolves in the monorepo
 * and nowhere else. Both are only visible from outside.
 *
 *   bun run scripts/autoapp-dry-run.ts [--keep]
 *
 * Nothing here publishes anything. Publishing to npm to test installation is
 * not a test, it is a release.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packLocal } from './pack-local.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

const failures: string[] = [];

function fail(step: string, detail: string): void {
  failures.push(`${step}: ${detail}`);
  console.log(`  FAIL  ${step}\n        ${detail.split('\n').slice(-12).join('\n        ')}`);
}

function ok(step: string, detail = ''): void {
  console.log(`  ok    ${step}${detail === '' ? '' : ` — ${detail}`}`);
}

/** Run one command and return everything about it. */
function run(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const done = Bun.spawnSync({
    cmd: [...argv],
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const decoder = new TextDecoder();
  return {
    code: done.exitCode ?? -1,
    stdout: decoder.decode(done.stdout),
    stderr: decoder.decode(done.stderr),
  };
}

// Outside the workspace entirely: inside it, Bun would resolve `broapp` and
// `broapp-autoapp` through the workspace and the tarballs would never be
// exercised.
const workspace = await mkdtemp(join(tmpdir(), 'autoapp-dryrun-'));
const project = join(workspace, 'project');

console.log(`Autoapp dry run\n  workspace: ${workspace}\n`);

try {
  console.log('1. Pack the publishable packages');
  const packed = await packLocal(join(workspace, 'packs'));
  const tarball = (name: string): string => {
    const found = packed.find((entry) => entry.name === name)?.tarball;
    if (found === undefined) throw new Error(`${name} was not packed`);
    return found;
  };
  for (const entry of packed) console.log(`  ok    ${entry.name}`);

  // Every Broapp package the project needs comes from a tarball, including the
  // ones `broapp-autoapp` depends on. Without the overrides those would be
  // fetched from the registry, and a dry run that tests the published version
  // of a package is testing the wrong artefact.
  const fromPack = {
    broapp: `file:${tarball('broapp')}`,
    'broapp-ai-anthropic': `file:${tarball('broapp-ai-anthropic')}`,
    'broapp-ai-compatible': `file:${tarball('broapp-ai-compatible')}`,
    'broapp-ai-elements': `file:${tarball('broapp-ai-elements')}`,
    'broapp-autoapp': `file:${tarball('broapp-autoapp')}`,
  };

  console.log('\n2. A project outside the workspace, installing the tarballs');
  await mkdir(project, { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'autoapp-dry-run',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: { ...fromPack, react: '^19.0.0', 'react-dom': '^19.0.0' },
        overrides: fromPack,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const installed = run(['bun', 'install'], project);
  if (installed.code !== 0) fail('bun install', installed.stderr.trim() || installed.stdout.trim());
  else ok('bun install');

  const launcher = join(project, 'node_modules', 'broapp-autoapp', 'src', 'launcher', 'main.ts');
  const page = join(project, 'node_modules', 'broapp-autoapp', 'dist', 'launcher-page.html');
  const template = join(project, 'node_modules', 'broapp-autoapp', 'dist', 'templates.json');
  if (!existsSync(launcher)) fail('the installed package', `no launcher entry at ${launcher}`);
  else if (!existsSync(page)) {
    // The one fault this script exists for: `main.ts` imports the page, so a
    // `files` list without it produces a package that cannot start.
    fail('the installed package', 'the launcher page is missing from the tarball');
  } else if (!existsSync(template)) {
    // The same fault, one artefact along: a tarball without the templates is a
    // launcher whose New application button has nothing to write.
    fail('the installed package', 'dist/templates.json is missing from the tarball');
  } else ok('the installed package', 'launcher entry, page and templates all present');

  console.log('\n3. The Notes workspace, depending on the tarballs rather than the monorepo');
  const source = join(project, 'notes');
  cpSync(join(root, 'examples', 'notes'), source, {
    recursive: true,
    filter: (from) => !/(^|[\\/])(node_modules|dist|release|\.git)([\\/]|$)/.test(from),
  });
  const manifestPath = join(source, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const [name, specifier] of Object.entries(fromPack)) {
    if (manifest.dependencies[name] !== undefined) manifest.dependencies[name] = specifier;
  }
  // Nothing here typechecks the workspace, and the dev dependencies are what
  // would drag the registry into it.
  delete manifest.devDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  ok('notes workspace', 'copied and repointed at the packed packages');

  console.log('\n4. Import it through the installed launcher');
  const data = join(project, 'run');
  const imported = run(['bun', launcher, 'import', source, '--as', 'notes', '--grant'], project, {
    BROAPP_DATA_DIR: data,
  });
  const first = imported.stdout.trim().split(/\s+/).pop() ?? '';
  if (imported.code !== 0 || !/^[0-9a-f]{32}$/.test(first)) {
    fail('import', imported.stderr.trim() || imported.stdout.trim());
  } else ok('import', `release ${first}`);

  console.log('\n5. Build a candidate from a changed workspace');
  const app = join(data, 'autoapp', 'apps', 'notes');
  const views = join(app, 'source', 'src', 'shared', 'views.ts');
  if (!existsSync(views)) fail('build', `no view specification at ${views}`);
  else {
    writeFileSync(views, readFileSync(views, 'utf8').replace("header: 'Title'", "header: 'Name'"));
    const built = run(['bun', launcher, 'build', 'notes'], project, { BROAPP_DATA_DIR: data });
    const second = built.stdout.trim().split(/\s+/)[0] ?? '';
    if (built.code !== 0 || !/^[0-9a-f]{32}$/.test(second)) {
      fail('build', built.stderr.trim() || built.stdout.trim());
    } else if (second === first) {
      fail('build', 'the changed workspace produced the release it started from');
    } else ok('build', `candidate ${second}`);
  }
} catch (cause) {
  fail('dry run', String(cause instanceof Error ? (cause.stack ?? cause.message) : cause));
} finally {
  if (keep) console.log(`\nKept: ${workspace}`);
  else await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}

console.log('\n--- summary ---');
if (failures.length === 0) console.log('Autoapp dry run passed.');
else for (const line of failures) console.log(`FAIL  ${line}`);
process.exit(failures.length === 0 ? 0 : 1);
