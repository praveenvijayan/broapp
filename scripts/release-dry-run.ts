#!/usr/bin/env bun
/**
 * The local release dry run.
 *
 * This is the check that catches a package which works from the monorepo and
 * not from npm. It packs the publishable packages, generates a project from the
 * **packed tarball** in a directory outside the workspace, installs from those
 * tarballs, typechecks, builds an executable, and runs it from somewhere
 * unrelated.
 *
 * Nothing here publishes anything. Publishing to npm to test installation is
 * not a test, it is a release.
 *
 *   bun run scripts/release-dry-run.ts [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packLocal } from './pack-local.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

/** One recorded step, so the report says exactly what ran. */
interface Step {
  readonly label: string;
  readonly command: string;
  readonly ok: boolean;
  readonly ms: number;
}

const steps: Step[] = [];

async function run(
  label: string,
  argv: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<boolean> {
  const started = Date.now();
  const child = Bun.spawn([...argv], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  const ok = code === 0;
  steps.push({ label, command: argv.join(' '), ok, ms: Date.now() - started });
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        $ ${argv.join(' ')}`);
    for (const line of `${stdout}\n${stderr}`.trim().split('\n').slice(-25)) {
      console.log(`        ${line}`);
    }
  }
  return ok;
}

// Outside the workspace entirely: inside it, Bun would resolve `broapp` through
// the workspace and the tarball would never be exercised.
const workspace = await mkdtemp(join(tmpdir(), 'broapp-dryrun-'));
const project = join(workspace, 'dry run app');
const elsewhere = await mkdtemp(join(tmpdir(), 'broapp-elsewhere-'));

console.log(`Release dry run\n  workspace: ${workspace}\n`);

let ok = true;
try {
  console.log('1. Pack the publishable packages');
  const packed = await packLocal(join(workspace, 'packs'));
  for (const entry of packed) console.log(`  ok    ${entry.name} → ${entry.tarball}`);
  const generator = packed.find((entry) => entry.name === 'create-broapp')?.tarball;
  const runtime = packed.find((entry) => entry.name === 'broapp')?.tarball;
  if (generator === undefined || runtime === undefined) throw new Error('packing produced no tarball');

  console.log('\n2. Install the packed generator on its own');
  const generatorHome = join(workspace, 'generator');
  await Bun.write(join(generatorHome, 'package.json'), JSON.stringify({ name: 'g', private: true }, null, 2));
  ok = (await run('bun add create-broapp (from the tarball)', ['bun', 'add', generator], generatorHome)) && ok;

  console.log('\n3. Generate a project outside the workspace');
  const generatorBin = join(generatorHome, 'node_modules', 'create-broapp', 'src', 'main.ts');
  ok =
    (await run(
      'create-broapp "dry run app" --yes --no-install',
      ['bun', generatorBin, project, '--name', 'dry-run-app', '--title', 'Dry Run App', '--yes', '--no-install'],
      workspace,
    )) && ok;

  // The generated manifest names `broapp` by version range. Nothing is
  // published, so it is pointed at the packed tarball — the same artefact npm
  // would serve.
  const manifestPath = join(project, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const declared = manifest.dependencies['broapp'];
  if (declared === undefined || declared.includes('workspace:')) {
    console.log(`  FAIL  the generated project declares broapp as ${String(declared)}`);
    ok = false;
  } else {
    console.log(`  ok    the generated project declares broapp as ${declared}`);
  }
  manifest.dependencies['broapp'] = `file:${runtime}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('\n4. Install the generated project');
  ok = (await run('bun install', ['bun', 'install'], project)) && ok;

  console.log('\n5. Run its checks');
  ok = (await run('bunx tsc --noEmit', ['bunx', 'tsc', '--noEmit'], project)) && ok;

  console.log('\n6. Build the executable');
  ok = (await run('bun run build', ['bun', 'run', 'build'], project)) && ok;

  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binary = join(project, 'release', `dry-run-app${suffix}`);
  if (!existsSync(binary)) {
    console.log(`  FAIL  no executable at ${binary}`);
    ok = false;
  } else {
    const size = (await Bun.file(binary).stat()).size;
    console.log(`  ok    ${binary} (${(size / 1024 / 1024).toFixed(1)} MiB)`);

    console.log('\n7. Run it from an unrelated directory, with no source tree');
    ok = (await run('<binary> --version', [binary, '--version'], elsewhere)) && ok;
    ok = (await run('<binary> --data-dir', [binary, '--data-dir'], elsewhere)) && ok;

    console.log('\n8. Smoke test the running application');
    ok =
      (await run(
        'smoke-binary.ts (bootstrap, auth, an operation, shutdown)',
        ['bun', join(root, 'scripts', 'smoke-binary.ts'), binary, '--call', 'demo.hostInfo'],
        elsewhere,
      )) && ok;
  }
} catch (cause) {
  console.log(`  FAIL  ${String(cause instanceof Error ? cause.message : cause)}`);
  ok = false;
} finally {
  if (keep) {
    console.log(`\nKept: ${workspace}`);
  } else {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    await rm(elsewhere, { recursive: true, force: true }).catch(() => undefined);
  }
}

console.log('\n--- summary ---');
for (const step of steps) {
  console.log(`${step.ok ? 'ok  ' : 'FAIL'}  ${String(step.ms).padStart(6)} ms  ${step.label}`);
}
console.log(ok ? '\nDry run passed.' : '\nDry run FAILED.');
process.exit(ok ? 0 : 1);
