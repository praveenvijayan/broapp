/**
 * The contract between this application's host and its browser UI.
 *
 * Both sides import this file and nothing else from each other. It is the one
 * place to look to answer "what can the UI ask the host to do?", and the one
 * place to change when the answer changes — the compiler finds every site that
 * needs updating.
 *
 * ## Adding an operation
 *
 * 1. Add an entry to `operations` below with an input and an output schema.
 * 2. Implement it in `src/host/operations.ts`.
 * 3. Call it from the UI with `useOperation("group.name")`.
 *
 * Step 2 is not optional: the host refuses to start when a declared route has
 * no implementation, so a half-added operation fails at startup rather than
 * under a user's click.
 */
import { defineContract, s } from 'broapp/shared';

export const contract = defineContract({
  operations: {
    /** A validated round trip, to show the shape of a typed call. */
    'demo.greet': {
      summary: 'Return a greeting for a name the browser supplied.',
      input: s.object({
        name: s.string({ min: 1, max: 64 }),
      }),
      output: s.object({
        greeting: s.string(),
        /** Milliseconds since the epoch, measured on the host. */
        at: s.number(),
      }),
    },

    /** Facts about the host process, for the developer panel. */
    'demo.hostInfo': {
      summary: 'Describe the running host process.',
      input: s.void(),
      output: s.object({
        appName: s.string(),
        version: s.string(),
        platform: s.string(),
        arch: s.string(),
        bunVersion: s.string(),
        /** Where this application keeps its data. */
        dataDir: s.string(),
        /** True when started by `broapp dev` rather than as a compiled binary. */
        development: s.boolean(),
        lifecycle: s.enum(['interactive', 'background']),
      }),
    },
  },

  streams: {
    /**
     * A long local computation reporting progress.
     *
     * Deliberately harmless and deliberately slow: it counts prime numbers by
     * trial division, which is a real workload that takes a real amount of
     * time, so cancelling it is something you can observe rather than take on
     * trust. Nothing here reads a file or runs a command.
     */
    'demo.countPrimes': {
      summary: 'Count primes below a bound, reporting progress, cancellable.',
      params: s.object({
        upTo: s.number({ int: true, min: 2, max: 200_000_000 }),
      }),
      event: s.object({
        /** Highest number examined so far. */
        examined: s.number(),
        /** Primes found so far. */
        found: s.number(),
        /** 0 to 1. */
        progress: s.number(),
        /** True on the final event. */
        done: s.boolean(),
      }),
    },
  },
});

/** The application's contract type, for anything that needs to name it. */
export type AppContract = typeof contract;
