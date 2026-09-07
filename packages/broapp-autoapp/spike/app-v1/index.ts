/**
 * A fake application artifact, version 1.
 *
 * It stands in for a built release. Nothing imports it: the child loads it by
 * absolute path at runtime, which is the thing the spike exists to prove. If
 * this file ever appears in an `import` statement anywhere in the launcher's
 * module graph, the bundler will inline it and the spike will pass while
 * proving nothing — so it is deliberately self-contained and depends only on
 * `node:` builtins.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the child calls once the artifact is loaded. */
export function start(): { schemaVersion: number; stop(): Promise<void> } {
  // Written from inside the child process, so a test can tell the artifact ran
  // there rather than in the launcher.
  appendFileSync(join(process.env['BROAPP_DATA_DIR'] ?? '.', 'spike.log'), 'started\n');
  return {
    schemaVersion: 1,
    stop: () => Promise.resolve(),
  };
}
