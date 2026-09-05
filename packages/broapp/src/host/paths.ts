/**
 * Where a compiled Broapp application keeps its data.
 *
 * A single-file executable may sit in `/usr/local/bin`, in a read-only
 * `/Applications` bundle, or on a share. Writing next to it is therefore not
 * an option, and neither is writing to the working directory — the same
 * executable run from two directories would find two different databases.
 * Broapp resolves one per-user location per application, up front, and hands
 * it to the application.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** The environment variable that overrides the resolved directory. */
export const DATA_DIR_ENV = 'BROAPP_DATA_DIR';

/**
 * The per-user data directory for `appName`.
 *
 * Resolution order:
 *
 * 1. `BROAPP_DATA_DIR`, used verbatim — for tests, for portable installs, and
 *    for a user who keeps application data on another volume.
 * 2. The platform convention: `%APPDATA%` on Windows,
 *    `~/Library/Application Support` on macOS, and `$XDG_DATA_HOME` or
 *    `~/.local/share` elsewhere.
 *
 * The directory is not created here. {@link ensureDataDir} does that, so a
 * `--data-dir`-style diagnostic can print the path without a side effect.
 */
export function dataDir(appName: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_DIR_ENV];
  if (override !== undefined && override !== '') return override;

  const platform = process.platform;
  if (platform === 'win32') {
    const base = env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, appName);
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName);
  }
  const base = env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(base, appName);
}

/** Resolve the data directory and create it, including parents. */
export function ensureDataDir(appName: string, env: NodeJS.ProcessEnv = process.env): string {
  const directory = dataDir(appName, env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
