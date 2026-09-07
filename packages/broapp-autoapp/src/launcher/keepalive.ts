/**
 * Keeping one application serving for as long as `serve` runs.
 *
 * A child that dies takes the person's tab with it — and, once there is an MCP
 * adapter, takes away the only thing an agent on the other end of the control
 * connection can talk to. So `serve` starts it again from whatever release is
 * current, rather than exiting and leaving a control socket answering
 * `unavailable` forever.
 *
 * It gives up after a few tries in quick succession. A crash loop is a broken
 * release, not a transient fault, and restarting it forever would hide that
 * behind a tab that keeps reappearing.
 */
import type { HostLogger } from 'broapp/host';

import { readCurrent, readRelease } from '../spec/store.ts';
import type { Layout } from '../spec/layout.ts';

import type { ChildHandle, Supervisor } from './supervisor.ts';

/** How many restarts are allowed before a crash is treated as permanent. */
const MAX_RESTARTS = 3;
/** The window those restarts are counted in. */
const RESTART_WINDOW_MS = 60_000;

/** Options for {@link keepServing}. */
export interface KeepServingOptions {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly appId: string;
  readonly logger?: HostLogger;
  /**
   * Called with every child this starts, the first one included.
   *
   * A restarted child serves on a new address with a new launch token, so the
   * caller has to say so — the tab that was open is talking to a process that
   * no longer exists.
   */
  readonly onStart?: (child: ChildHandle, restart: number) => void;
  readonly maxRestarts?: number;
  readonly windowMs?: number;
}

/**
 * Start the application and keep it started until it stops cleanly.
 *
 * Returns the exit code of the last child. A clean exit — code 0, which is what
 * a `shutdown` message produces — is the application being asked to stop, and
 * is not restarted.
 */
export async function keepServing(options: KeepServingOptions): Promise<number> {
  const { layout, supervisor, appId } = options;
  const logger: HostLogger = options.logger ?? console;
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS;
  const windowMs = options.windowMs ?? RESTART_WINDOW_MS;
  const app = layout.app(appId);
  /** When each restart in the current window happened. */
  const recent: number[] = [];

  for (;;) {
    // Re-read every time: an activation may have moved `current` while this was
    // running, and the release that crashed is not necessarily the one to start.
    const current = readCurrent(layout, appId);
    if (current === null) {
      logger.error(`[autoapp] ${appId} has no current release`);
      return 1;
    }
    // A release whose name is not the hash of its contents is not started.
    // `readRelease` refuses it, but only somebody who reads a specification
    // would ever find out; the child is handed a directory path and would run
    // whatever is in it. Checked here, where starting is decided.
    try {
      readRelease(layout, appId, current);
    } catch (cause) {
      // `conflict` is what a release that is not what its name says reads as,
      // whether it went stale under the new identity rule or was moved.
      if ((cause as { code?: string }).code !== 'conflict') throw cause;
      logger.error(
        `[autoapp] ${appId} cannot start release ${current}: ${String((cause as Error).message)}`,
      );
      return 1;
    }

    let child: ChildHandle;
    try {
      child = await supervisor.start({
        appId,
        releaseDir: app.release(current),
        releaseId: current,
        dataDir: app.data,
        mode: 'live',
      });
    } catch (cause) {
      // The first start failing is the caller's problem to report: nothing is
      // running yet and there is nothing to keep alive.
      if (recent.length === 0) throw cause;
      logger.error(`[autoapp] ${appId} would not start again: ${String(cause)}`);
      return 1;
    }

    options.onStart?.(child, recent.length);
    const code = (await child.exited) ?? 0;
    if (code === 0) return 0;

    const now = Date.now();
    while (recent.length > 0 && now - (recent[0] ?? 0) > windowMs) recent.shift();
    if (recent.length >= maxRestarts) {
      logger.error(
        `[autoapp] ${appId} stopped with code ${String(code)} after ${String(maxRestarts)} restarts within ${String(Math.round(windowMs / 1_000))}s; leaving it stopped`,
      );
      return code;
    }
    recent.push(now);
    logger.warn(`[autoapp] ${appId} stopped with code ${String(code)}; starting it again`);
  }
}
