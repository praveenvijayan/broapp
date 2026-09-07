#!/usr/bin/env bun
/**
 * Compile the launcher, for this machine or for a named target.
 *
 * `bun run build:launcher` produces `dist/broapp-autoapp` for the machine it
 * runs on — that is what every test and every manual run uses. The release
 * workflow asks for one binary per target instead, and names them
 * `broapp-autoapp-<target>` so a download says what it is.
 *
 *   bun run scripts/build-launcher.ts                     # this machine
 *   bun run scripts/build-launcher.ts --target linux-x64  # one target
 *   bun run scripts/build-launcher.ts --all-targets       # every target
 *
 * A cross-compiled binary is compiled, not run. `bun:sqlite` links a platform
 * SQLite into the executable, so the only evidence a target works is a run on
 * that platform — which is why the release workflow smoke-tests only where a
 * runner exists, and labels the rest. `packages/broapp/src/cli/targets.ts` says
 * the same thing for an application's own binaries.
 */
import { findTarget, TARGETS, type Target } from 'broapp/build';

const packageDir = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);

/** Read `--flag value` or `--flag=value`. */
function option(name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index !== -1) return argv[index + 1] ?? null;
  const inline = argv.find((one) => one.startsWith(`--${name}=`));
  return inline === undefined ? null : inline.slice(name.length + 3);
}

/** Compile one binary. Returns its size in bytes. */
async function compile(target: Target | null): Promise<number> {
  const suffix = target === null ? '' : `-${target.id}`;
  const extension = target === null ? '' : target.ext;
  const outfile = `dist/broapp-autoapp${suffix}${extension}`;
  const built = Bun.spawn({
    cmd: [
      'bun',
      'build',
      '--compile',
      '--bytecode',
      '--minify',
      ...(target === null ? [] : [`--target=bun-${target.id}`]),
      'src/launcher/main.ts',
      '--outfile',
      outfile,
    ],
    cwd: packageDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await built.exited) !== 0) throw new Error(`compiling ${outfile} failed`);
  const size = (await Bun.file(`${packageDir}${outfile}`).stat()).size;
  console.log(`${outfile}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  return size;
}

async function main(): Promise<number> {
  // The page is part of the binary: `src/launcher/main.ts` imports it as text.
  const page = Bun.spawn({
    cmd: ['bun', 'run', 'scripts/build-page.ts'],
    cwd: packageDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await page.exited) !== 0) return 1;

  if (argv.includes('--all-targets')) {
    for (const target of TARGETS) await compile(target);
    return 0;
  }

  const named = option('target');
  if (named === null) {
    await compile(null);
    return 0;
  }
  const target = findTarget(named);
  if (target === undefined) {
    console.error(`no target named ${named}. One of: ${TARGETS.map((one) => one.id).join(', ')}`);
    return 1;
  }
  await compile(target);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(String(cause instanceof Error ? cause.message : cause));
    process.exit(1);
  },
);
