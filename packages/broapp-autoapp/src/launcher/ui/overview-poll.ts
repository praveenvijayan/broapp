/**
 * How often the launcher reads `launcher.overview`.
 *
 * Every two seconds while the Overview is the view and the tab is visible —
 * somebody is looking at it — and every ten seconds otherwise: while the chat
 * is the view, for the rail's count, and while the tab is hidden, because a
 * hidden tab is exactly when an alert matters, so reading does not stop there.
 *
 * One read in flight at a time. The next read is scheduled when the last one
 * settles, never on a fixed beat, so a slow launcher is read less often rather
 * than piled up. The timers are injected so a test can drive them.
 */

/** Which of the two screens is showing. */
export type LauncherView = 'overview' | 'chat';

/** While the Overview is looked at. */
export const OVERVIEW_FAST_MS = 2_000;
/** While the chat is the view, or the tab is hidden. */
export const OVERVIEW_SLOW_MS = 10_000;

/** How long to wait between reads, for what is showing and whether anybody can see it. */
export function overviewInterval(view: LauncherView, visible: boolean): number {
  return view === 'overview' && visible ? OVERVIEW_FAST_MS : OVERVIEW_SLOW_MS;
}

/** The timers a poller uses. */
export interface PollTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

/** A running poller. */
export interface OverviewPoller {
  /** The view or the visibility changed: the next read comes at the new pace. */
  setMode(view: LauncherView, visible: boolean): void;
  stop(): void;
}

export const REAL_TIMERS: PollTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Read now, then again at the pace the mode sets, one read at a time.
 *
 * `read` resolves when the read has settled, however it went: a failed read
 * is the caller's to show, and the next one is scheduled all the same.
 */
export function startOverviewPoller(
  read: () => Promise<void>,
  initial: { readonly view: LauncherView; readonly visible: boolean },
  timers: PollTimers = REAL_TIMERS,
): OverviewPoller {
  let interval = overviewInterval(initial.view, initial.visible);
  let timer: unknown = null;
  let inFlight = false;
  let stopped = false;
  let lastSettled = timers.now();

  const schedule = (): void => {
    if (stopped || inFlight) return;
    if (timer !== null) timers.clear(timer);
    const wait = Math.max(0, lastSettled + interval - timers.now());
    timer = timers.set(tick, wait);
  };

  function tick(): void {
    timer = null;
    if (stopped || inFlight) return;
    inFlight = true;
    void read()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        lastSettled = timers.now();
        schedule();
      });
  }

  tick();
  return {
    setMode(view, visible) {
      const next = overviewInterval(view, visible);
      if (next === interval) return;
      interval = next;
      // Measured from the last read, so coming back to the Overview after a
      // while reads at once, and leaving it does not read sooner than planned.
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  };
}
