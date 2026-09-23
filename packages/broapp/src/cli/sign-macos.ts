/**
 * An ad-hoc signature for a macOS executable.
 *
 * Apple silicon refuses to start an executable whose code signature does not
 * verify: the kernel kills it before it prints anything, and a terminal shows
 * only `killed`. Bun 1.4.0's `--compile` leaves a signature that does not
 * verify on every macOS target, cross-compiled or native — `codesign --verify`
 * says "code or signature have been modified". macOS 27 enforces that; earlier
 * versions let the same binary run, which is how a release shipped with it.
 *
 * An ad-hoc signature (`--sign -`) carries no identity, so it does nothing for
 * Gatekeeper or the quarantine attribute (docs/packaging.md). It only makes the
 * signature the binary already claims to have a valid one. `codesign` exists
 * only on macOS, so a macOS binary built anywhere else stays unsigned, and the
 * caller says so.
 */
import type { Target } from './targets.ts';

/**
 * What {@link signForMacos} did: `signed` and verified, `unsigned` because this
 * machine has no `codesign`, or `not-needed` for a target that is not macOS.
 */
export type MacosSignature = 'signed' | 'unsigned' | 'not-needed';

async function codesign(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(['codesign', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  if (code !== 0) throw new Error(`codesign ${args.join(' ')} failed: ${stderr.trim()}`);
}

/** Sign a macOS executable ad hoc, then verify the signature strictly. */
export async function signForMacos(path: string, target: Target): Promise<MacosSignature> {
  if (!target.id.startsWith('darwin-')) return 'not-needed';
  if (process.platform !== 'darwin') return 'unsigned';
  await codesign(['--force', '--sign', '-', path]);
  await codesign(['--verify', '--strict', path]);
  return 'signed';
}
