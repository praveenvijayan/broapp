/**
 * Compilation targets.
 *
 * These are Bun's `--target=bun-<platform>-<arch>` names. Cross-compilation
 * works for pure-JavaScript dependency trees; it does not make a native addon
 * portable, and `bun:sqlite` in particular links a platform SQLite into the
 * produced executable — so a cross-compiled binary is a build artifact that
 * has not been *run*. Broapp's release workflow therefore separates "compiled"
 * from "smoke-tested", and only claims the second where a matching runner
 * exists.
 */

/** A supported compilation target. */
export interface Target {
  /** Bun's target name, without the `bun-` prefix. */
  readonly id: string;
  /** Executable suffix. */
  readonly ext: '' | '.exe';
  /** Human-readable label for release notes. */
  readonly label: string;
}

/** Every target Broapp builds by default. */
export const TARGETS: readonly Target[] = [
  { id: 'darwin-arm64', ext: '', label: 'macOS (Apple silicon)' },
  { id: 'darwin-x64', ext: '', label: 'macOS (Intel)' },
  { id: 'linux-x64', ext: '', label: 'Linux x86-64 (glibc)' },
  { id: 'linux-arm64', ext: '', label: 'Linux arm64 (glibc)' },
  { id: 'linux-x64-musl', ext: '', label: 'Linux x86-64 (musl / Alpine)' },
  { id: 'windows-x64', ext: '.exe', label: 'Windows x64' },
];

/** Look a target up by id. */
export function findTarget(id: string): Target | undefined {
  return TARGETS.find((target) => target.id === id);
}

/** The target matching the machine running the build. */
export function currentTarget(): Target {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  const id = platform === 'windows' ? 'windows-x64' : `${platform}-${arch}`;
  const found = findTarget(id);
  if (found === undefined) {
    throw new Error(
      `no Broapp target for ${process.platform}/${process.arch}. Supported: ${TARGETS.map((t) => t.id).join(', ')}`,
    );
  }
  return found;
}
