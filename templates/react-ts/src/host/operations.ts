/**
 * Host implementations.
 *
 * This is where to add server-side behaviour. Everything here runs in the Bun
 * process, with the invoking user's permissions, and everything here receives
 * input that came from a browser tab — validated against the contract before
 * it arrives, but still worth thinking about.
 */
import { createHostApp, publicError } from 'broapp/host';

import { contract } from '../shared/contract.ts';

/** What the host knows about itself, gathered once at startup. */
export interface HostFacts {
  readonly appName: string;
  readonly version: string;
  readonly dataDir: string;
  readonly development: boolean;
  readonly lifecycle: 'interactive' | 'background';
}

/** How often the prime counter reports progress. */
const REPORT_EVERY = 100_000;

/** Build the host application for this contract. */
export function createApp(facts: HostFacts) {
  const app = createHostApp(contract);

  app.operation('demo.greet', ({ name }) => {
    // The schema already enforced length. This is the application's own rule:
    // a name that is only whitespace passes `min: 1` but is not a name.
    const trimmed = name.trim();
    if (trimmed === '') {
      throw publicError.invalidInput('Enter a name with at least one visible character.');
    }
    return { greeting: `Hello, ${trimmed}.`, at: Date.now() };
  });

  app.operation('demo.hostInfo', () => ({
    appName: facts.appName,
    version: facts.version,
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    dataDir: facts.dataDir,
    development: facts.development,
    lifecycle: facts.lifecycle,
  }));

  app.stream('demo.countPrimes', async ({ upTo }, sink) => {
    let found = 0;

    for (let candidate = 2; candidate <= upTo; candidate += 1) {
      if (isPrime(candidate)) found += 1;

      if (candidate % REPORT_EVERY === 0) {
        // Two things happen at this checkpoint, and both matter.
        //
        // First, cancellation. `sink.signal` is aborted when the browser calls
        // `cancel()`, when its tab goes away, or when the host shuts down. A
        // tight loop that never looks at it would keep burning a core after
        // the user pressed Cancel, because nothing preempts it.
        if (sink.signal.aborted) return;

        // Second, backpressure and fairness. `emit` resolves when Brobridge's
        // flow control has room, and awaiting it also yields the event loop —
        // without which this loop would starve the socket it is reporting on.
        await sink.emit({
          examined: candidate,
          found,
          progress: candidate / upTo,
          done: false,
        });
      }
    }

    if (sink.signal.aborted) return;
    await sink.emit({ examined: upTo, found, progress: 1, done: true });
  });

  return app;
}

/** Trial division. Slow on purpose — see the contract's note on this stream. */
function isPrime(value: number): boolean {
  if (value < 2) return false;
  if (value % 2 === 0) return value === 2;
  for (let divisor = 3; divisor * divisor <= value; divisor += 2) {
    if (value % divisor === 0) return false;
  }
  return true;
}
