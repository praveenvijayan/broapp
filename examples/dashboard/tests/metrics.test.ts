/**
 * The sampling arithmetic, and the platform honesty.
 *
 * Busy fraction is a difference between two samples, which is the kind of
 * calculation that looks obviously right and is off by a factor somewhere. The
 * platform test guards a decision rather than a calculation: reporting a load
 * average of zero on a platform that does not measure one would be a lie the
 * interface would draw as a flat line.
 */
import { describe, expect, test } from 'bun:test';
import type { CpuInfo } from 'node:os';

import { LOAD_IS_REAL, busyFraction } from '../src/host/operations.ts';

/** A CPU sample with the given cumulative times, in the shape `os.cpus()` returns. */
function sample(user: number, sys: number, idle: number): CpuInfo {
  return {
    model: 'test',
    speed: 0,
    times: { user, nice: 0, sys, idle, irq: 0 },
  };
}

describe('busyFraction', () => {
  test('a core that was entirely idle reports zero', () => {
    expect(busyFraction(sample(0, 0, 0), sample(0, 0, 100))).toBe(0);
  });

  test('a core that was entirely busy reports one', () => {
    expect(busyFraction(sample(0, 0, 0), sample(80, 20, 0))).toBe(1);
  });

  test('a half-busy core reports a half', () => {
    expect(busyFraction(sample(0, 0, 0), sample(40, 10, 50))).toBeCloseTo(0.5, 6);
  });

  test('only the delta counts, not the cumulative totals', () => {
    // Both samples carry large accumulated times; the interval between them
    // was three-quarters busy. Using the totals instead of the difference
    // would give a very different answer.
    const before = sample(9_000, 1_000, 40_000);
    const after = sample(9_060, 1_015, 40_025);
    expect(busyFraction(before, after)).toBeCloseTo(0.75, 6);
  });

  test('the first sample of a stream has nothing to compare against', () => {
    expect(busyFraction(undefined, sample(10, 10, 10))).toBe(0);
  });

  test('two identical samples do not divide by zero', () => {
    const point = sample(10, 10, 10);
    expect(busyFraction(point, point)).toBe(0);
  });

  test('counters that appear to go backwards do not produce a negative', () => {
    // Should not happen, but a suspended machine and a wrapped counter both
    // exist. A negative would render as a bar with a negative height.
    const result = busyFraction(sample(100, 0, 100), sample(90, 0, 120));
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe('platform support', () => {
  test('load average is reported as real everywhere except Windows', () => {
    expect(LOAD_IS_REAL).toBe(process.platform !== 'win32');
  });
});
