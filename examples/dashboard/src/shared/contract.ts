/**
 * Live Dashboard — contract.
 *
 * Three independent streams rather than one combined one, deliberately. It is
 * the arrangement that shows what multiplexing buys: each has its own cadence,
 * each can be started and stopped without touching the others, and each resumes
 * on its own after a reconnect.
 *
 * Everything here is non-sensitive: aggregate CPU, memory and load. No process
 * list, no command lines, no environment.
 */
import { defineContract, s } from 'broapp/shared';

/** A metric that a platform may simply not provide. */
const availability = s.enum(['available', 'unsupported']);

export const contract = defineContract({
  operations: {
    'system.describe': {
      summary: 'Static facts about this machine, read once.',
      input: s.void(),
      output: s.object({
        platform: s.string(),
        arch: s.string(),
        release: s.string(),
        cpuModel: s.string(),
        cpuCount: s.number(),
        totalMemoryBytes: s.number(),
        /** Which of the streams below will report on this platform. */
        supports: s.object({
          cpu: availability,
          memory: availability,
          load: availability,
        }),
      }),
    },
  },

  streams: {
    'metrics.cpu': {
      summary: 'Per-core busy fraction, sampled between ticks.',
      params: s.object({ intervalMs: s.number({ int: true, min: 250, max: 10_000 }) }),
      event: s.object({
        at: s.number(),
        /** 0 to 1 per core. */
        cores: s.array(s.number(), { max: 512 }),
        overall: s.number(),
      }),
    },

    'metrics.memory': {
      summary: 'Total and free physical memory.',
      params: s.object({ intervalMs: s.number({ int: true, min: 250, max: 10_000 }) }),
      event: s.object({
        at: s.number(),
        totalBytes: s.number(),
        freeBytes: s.number(),
        usedFraction: s.number(),
      }),
    },

    'metrics.load': {
      summary: 'One, five and fifteen minute load averages.',
      params: s.object({ intervalMs: s.number({ int: true, min: 250, max: 10_000 }) }),
      event: s.object({
        at: s.number(),
        /**
         * Null on a platform that does not report load. Windows always reports
         * zeroes from `os.loadavg()`, which is not the same as a load of zero —
         * so the host sends null and the interface says "not available" rather
         * than drawing a flat line that looks like real data.
         */
        one: s.nullable(s.number()),
        five: s.nullable(s.number()),
        fifteen: s.nullable(s.number()),
      }),
    },
  },
});
