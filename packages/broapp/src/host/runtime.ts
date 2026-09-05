/**
 * Starting, supervising and stopping a Broapp application.
 *
 * This is the lifecycle the spec calls for, made explicit. Two modes:
 *
 * - `interactive` (the default) — the process exists to serve a browser tab.
 *   When the last tab has been gone for `idleGraceMs` and no work is running,
 *   the process exits. A launch that no browser ever reaches gives up after
 *   `launchTimeoutMs` with a nonzero status, so a broken launcher fails
 *   loudly instead of leaving a listener behind forever.
 *
 * - `background` — the process keeps running when the UI closes, and is
 *   stopped by `Ctrl+C`, `SIGTERM`, or whatever supervises it. It is an
 *   ordinary foreground process; Broapp does not daemonise and does not
 *   install a service.
 *
 * "Attached" is not the same as "session exists". Brobridge retains a session
 * after its socket drops so a reconnecting tab can resume, so counting
 * `bridge.sessions` would keep the process alive for a minute after the last
 * tab closed. Attachment is `endpoint.state === "open"`, which is what a live
 * connection actually looks like.
 */
import type { Bridge, BridgeOptions } from 'brobridge';
import { createBridge } from 'brobridge';

import { openBrowser } from './open-browser.ts';

/** Which lifecycle policy the application follows. */
export type LifecycleMode = 'interactive' | 'background';

/** Options for {@link startApp}. */
export interface StartAppOptions {
  /** The complete, self-contained HTML document served at `/`. */
  readonly page: string;
  /** Human-readable application name, used in banner output. */
  readonly appName: string;
  /** Application version, used in banner output. */
  readonly version: string;
  /** Register routes on the bridge. Called once, before the browser is opened. */
  readonly register: (bridge: Bridge) => void | Promise<void>;
  /** Default `"interactive"`. */
  readonly mode?: LifecycleMode;
  /** Open the browser at startup. Default `true`. */
  readonly openBrowser?: boolean;
  /** Interactive mode: how long with no attached tab before exiting. Default 20 000 ms. */
  readonly idleGraceMs?: number;
  /** Interactive mode: how long to wait for the first tab. Default 120 000 ms. */
  readonly launchTimeoutMs?: number;
  /** True while work is running that must not be discarded by an idle exit. */
  readonly isBusy?: () => boolean;
  /** Run before the bridge closes: flush, checkpoint, close a database. */
  readonly onShutdown?: (reason: ShutdownReason) => void | Promise<void>;
  /** Passed through to Brobridge. Loopback binding and auth are not overridable here. */
  readonly bridge?: Omit<BridgeOptions, 'index' | 'allowNonLoopback' | 'host'>;
  /** Where banner output goes. Default `console`. */
  readonly stdout?: { log(message: string): void };
}

/** Why the application is stopping. */
export type ShutdownReason = 'signal' | 'idle' | 'never-connected' | 'requested';

/** A running application. */
export interface RunningApp {
  readonly bridge: Bridge;
  /** Resolves with the intended process exit code when the application stops. */
  readonly done: Promise<number>;
  /** Stop it. Safe to call more than once. */
  stop(reason?: ShutdownReason): Promise<void>;
}

const POLL_INTERVAL_MS = 1_000;

/**
 * Start an application.
 *
 * Binds loopback on an ephemeral port — `allowNonLoopback` is deliberately not
 * forwarded, so a starter cannot grow LAN exposure through a config typo.
 */
export async function startApp(options: StartAppOptions): Promise<RunningApp> {
  const out = options.stdout ?? console;
  const mode: LifecycleMode = options.mode ?? 'interactive';
  const idleGraceMs = options.idleGraceMs ?? 20_000;
  const launchTimeoutMs = options.launchTimeoutMs ?? 120_000;

  // Attachment is recorded from Brobridge's own session hook rather than by
  // polling. A tab that connects and closes inside one poll interval — a
  // reload, a quick script, a test — would otherwise never be *seen* to have
  // attached, and interactive mode would then treat the run as "no browser
  // ever connected" and exit with a failure status.
  let everAttached = false;
  const bridge = await createBridge({
    ...options.bridge,
    index: { body: options.page, contentType: 'text/html; charset=utf-8' },
    onSession: (session) => {
      everAttached = true;
      options.bridge?.onSession?.(session);
    },
  });

  try {
    await options.register(bridge);
  } catch (cause) {
    await bridge.close();
    throw cause;
  }

  let settle: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    settle = resolve;
  });

  let stopping: Promise<void> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const stop = (reason: ShutdownReason = 'requested'): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      if (poll !== null) clearInterval(poll);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      try {
        await options.onShutdown?.(reason);
      } catch (cause) {
        out.log(`shutdown hook failed: ${String(cause instanceof Error ? cause.message : cause)}`);
      }
      // `close()` sends GOAWAY, ends open streams, then releases the listener.
      // Handlers observe that as their stream aborting, which is the same path
      // a browser-side cancel takes.
      await bridge.close();
      settle(reason === 'never-connected' ? 1 : 0);
    })();
    return stopping;
  };

  const onSigint = (): void => {
    out.log('');
    void stop('signal');
  };
  const onSigterm = (): void => void stop('signal');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // The launch URL carries a one-time token and is a credential until it is
  // redeemed. It is written to the terminal on purpose, because a user whose
  // browser did not open needs it — and to the terminal only. Nothing here
  // puts it in a log file, and Brobridge sets `Referrer-Policy: no-referrer`
  // and `Cache-Control: no-store` so the browser does not persist it either.
  out.log(`${options.appName} v${options.version}`);
  out.log(`Open this address if your browser does not: ${bridge.url}`);
  out.log(
    mode === 'interactive'
      ? 'Close the tab to quit, or press Ctrl+C.'
      : 'Running in the background. Press Ctrl+C to quit.',
  );

  if (options.openBrowser !== false) {
    void openBrowser(bridge.url).then((opened) => {
      if (!opened) out.log('Could not open a browser automatically. Use the address above.');
    });
  }

  if (mode === 'interactive') {
    const startedAt = Date.now();
    let idleSince: number | null = null;

    poll = setInterval(() => {
      const attached = bridge.sessions.some((session) => session.endpoint.state === 'open');
      const now = Date.now();

      if (attached) {
        idleSince = null;
        return;
      }
      if (!everAttached) {
        if (now - startedAt >= launchTimeoutMs) {
          out.log('No browser ever connected. Stopping.');
          void stop('never-connected');
        }
        return;
      }
      // Work in flight outranks the idle timer: exiting here would discard it
      // silently, which is the one thing the grace period is meant to prevent.
      if (options.isBusy?.() === true) {
        idleSince = null;
        return;
      }
      idleSince ??= now;
      if (now - idleSince >= idleGraceMs) {
        out.log('Browser closed. Stopping.');
        void stop('idle');
      }
    }, POLL_INTERVAL_MS);
    // Do not let the poll timer alone hold the event loop open.
    poll.unref?.();
  }

  return { bridge, done, stop };
}
