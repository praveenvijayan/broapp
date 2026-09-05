/**
 * Live Dashboard — host.
 *
 * Reads only aggregate, non-identifying counters from `node:os`. Nothing here
 * shells out, and nothing here reads a path.
 */
import { arch, cpus, freemem, loadavg, platform, release, totalmem, type CpuInfo } from 'node:os';

import { createHostApp } from 'broapp/host';

import { contract } from '../shared/contract.ts';

/** `os.loadavg()` returns `[0, 0, 0]` on Windows, which is a stub, not a reading. */
export const LOAD_IS_REAL = process.platform !== 'win32';

export function createApp() {
  const app = createHostApp(contract);

  app.operation('system.describe', () => {
    const cores = cpus();
    return {
      platform: platform(),
      arch: arch(),
      release: release(),
      cpuModel: cores[0]?.model ?? 'unknown',
      cpuCount: cores.length,
      totalMemoryBytes: totalmem(),
      supports: {
        cpu: cores.length > 0 ? ('available' as const) : ('unsupported' as const),
        memory: 'available' as const,
        load: LOAD_IS_REAL ? ('available' as const) : ('unsupported' as const),
      },
    };
  });

  app.stream('metrics.cpu', async ({ intervalMs }, sink) => {
    // Busy fraction is a *difference* between two samples, so the first tick
    // has nothing to compare against and is used only as a baseline.
    let previous = cpus();
    while (!sink.signal.aborted) {
      await sleep(intervalMs, sink.signal);
      if (sink.signal.aborted) return;

      const current = cpus();
      const cores = current.map((core, index) => busyFraction(previous[index], core));
      previous = current;

      await sink.emit({
        at: Date.now(),
        cores,
        overall: cores.length === 0 ? 0 : cores.reduce((total, value) => total + value, 0) / cores.length,
      });
    }
  });

  app.stream('metrics.memory', async ({ intervalMs }, sink) => {
    while (!sink.signal.aborted) {
      const totalBytes = totalmem();
      const freeBytes = freemem();
      await sink.emit({
        at: Date.now(),
        totalBytes,
        freeBytes,
        usedFraction: totalBytes === 0 ? 0 : (totalBytes - freeBytes) / totalBytes,
      });
      await sleep(intervalMs, sink.signal);
    }
  });

  app.stream('metrics.load', async ({ intervalMs }, sink) => {
    while (!sink.signal.aborted) {
      const [one, five, fifteen] = loadavg();
      // Honest about the platform: nulls, not zeroes dressed up as readings.
      await sink.emit({
        at: Date.now(),
        one: LOAD_IS_REAL ? (one ?? null) : null,
        five: LOAD_IS_REAL ? (five ?? null) : null,
        fifteen: LOAD_IS_REAL ? (fifteen ?? null) : null,
      });
      await sleep(intervalMs, sink.signal);
    }
  });

  return app;
}

/** Fraction of the interval one core spent outside idle. Exported for tests. */
export function busyFraction(before: CpuInfo | undefined, after: CpuInfo): number {
  if (before === undefined) return 0;
  const total = (times: CpuInfo['times']): number =>
    times.user + times.nice + times.sys + times.idle + times.irq;
  const elapsed = total(after.times) - total(before.times);
  if (elapsed <= 0) return 0;
  const idle = after.times.idle - before.times.idle;
  return Math.min(1, Math.max(0, 1 - idle / elapsed));
}

/** Sleep, but wake early when the stream is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
