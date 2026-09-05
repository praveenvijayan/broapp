/**
 * Compiling the host into a single-file executable.
 *
 * `bun build --compile` bundles the host entry point together with the Bun
 * runtime. The UI arrives through an ordinary import of the built HTML
 * document with `{ type: "text" }`, which Bun inlines into the bundle — so
 * there is no asset directory to ship, nothing to resolve at runtime relative
 * to the executable, and nothing to break when the binary is moved.
 */
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Target } from './targets.ts';
import { currentTarget, findTarget, TARGETS } from './targets.ts';

/** Options for {@link buildBinary}. */
export interface BuildBinaryOptions {
  /** Host entry point, e.g. `src/host/main.ts`. */
  readonly entry: string;
  /** Executable base name; the target suffix and `.exe` are added. */
  readonly name: string;
  /** Output directory. Default `release`. */
  readonly outDir?: string;
  /** Target ids. Default: the current platform only. */
  readonly targets?: readonly string[];
  /** Project root. Default `process.cwd()`. */
  readonly root?: string;
  /** Default `true`. */
  readonly minify?: boolean;
  /**
   * Compile to bytecode. Default `true`.
   *
   * It cuts startup time noticeably and costs binary size. Turn it off if a
   * dependency misbehaves under it.
   */
  readonly bytecode?: boolean;
  /** Append the target id to the filename. Default `true` for multi-target builds. */
  readonly suffixTarget?: boolean;
}

/** One produced executable. */
export interface BuiltBinary {
  readonly target: Target;
  readonly path: string;
  readonly bytes: number;
  /** True when this binary can run on the machine that built it. */
  readonly native: boolean;
}

/** Compile one executable per requested target. */
export async function buildBinary(options: BuildBinaryOptions): Promise<BuiltBinary[]> {
  const root = options.root ?? process.cwd();
  const outDir = resolve(root, options.outDir ?? 'release');
  const entry = resolve(root, options.entry);
  const native = currentTarget();

  const requested = options.targets ?? [native.id];
  const targets = requested.map((id) => {
    const target = findTarget(id);
    if (target === undefined) {
      throw new Error(`unknown target ${JSON.stringify(id)}. Supported: ${TARGETS.map((t) => t.id).join(', ')}`);
    }
    return target;
  });

  const suffix = options.suffixTarget ?? targets.length > 1;
  await mkdir(outDir, { recursive: true });

  const built: BuiltBinary[] = [];
  for (const target of targets) {
    const filename = `${options.name}${suffix ? `-${target.id}` : ''}${target.ext}`;
    const outFile = join(outDir, filename);
    await mkdir(dirname(outFile), { recursive: true });

    const argv = [
      'bun',
      'build',
      '--compile',
      `--target=bun-${target.id}`,
      ...(options.minify === false ? [] : ['--minify']),
      ...(options.bytecode === false ? [] : ['--bytecode']),
      entry,
      '--outfile',
      outFile,
    ];
    const child = Bun.spawn(argv, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
    if ((await child.exited) !== 0) {
      throw new Error(`compilation failed for ${target.id}`);
    }
    built.push({
      target,
      path: outFile,
      bytes: (await stat(outFile)).size,
      native: target.id === native.id,
    });
  }
  return built;
}
