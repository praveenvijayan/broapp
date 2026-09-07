/**
 * The compiled launcher, built at most once for a whole `bun test` run.
 *
 * Four test files drive the real binary, and each used to compile it at module
 * load. That is wasteful everywhere and broken on Windows: an executable cannot
 * be replaced while a process started from it is still exiting, so the second
 * file's build fails with `EPERM` and its cases skip — silently, because a skip
 * looks like a platform that was never meant to run them.
 *
 * So: build only when the binary is missing or older than the sources it is
 * built from. In CI the workflow compiles it first and nothing here rebuilds
 * it; locally an edit to `src/` is picked up the next time tests run.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const packageDir = join(import.meta.dir, '..', 'packages', 'broapp-autoapp');

/**
 * Where the compiled launcher is.
 *
 * `.exe` on Windows: `bun build --compile` adds the suffix the platform needs
 * whether or not `--outfile` asks for it, and a path without it does not exist.
 */
export const LAUNCHER = join(
  packageDir,
  'dist',
  `broapp-autoapp${process.platform === 'win32' ? '.exe' : ''}`,
);

/** The newest modification time under a directory. */
function newestUnder(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestUnder(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** Whether the binary on disk is younger than every source it is built from. */
function isCurrent(): boolean {
  if (!existsSync(LAUNCHER)) return false;
  const built = statSync(LAUNCHER).mtimeMs;
  const page = join(packageDir, 'dist', 'launcher-page.html');
  const sources = Math.max(
    newestUnder(join(packageDir, 'src')),
    existsSync(page) ? statSync(page).mtimeMs : 0,
  );
  return built >= sources;
}

/**
 * Make sure the launcher is built. Returns `null` on success, or the reason it
 * could not be built — which the caller turns into a skip with a printed cause,
 * never into a silent one.
 */
export async function ensureLauncher(): Promise<string | null> {
  if (isCurrent()) return null;
  const built = Bun.spawn({
    cmd: ['bun', 'run', 'build:launcher'],
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, , stderr] = await Promise.all([
    built.exited,
    new Response(built.stdout as ReadableStream<Uint8Array>).text(),
    new Response(built.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  if (code === 0) return null;
  // A build that failed against a binary already on disk is the Windows case
  // above: the existing one is what the workflow just compiled, so use it.
  return existsSync(LAUNCHER) ? null : stderr.trim();
}
