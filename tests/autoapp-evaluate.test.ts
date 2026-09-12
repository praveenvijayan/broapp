/**
 * What the evaluation counts as an edit, a build and a check.
 *
 * The clean run after 0.4.2 reported no builds and no edits for twelve turns
 * that had built and checked, because it counted `candidate.build` and
 * `source.edit` and every run had used `candidate.cycle`. These are the three
 * functions every such column now goes through.
 */
import { describe, expect, test } from 'bun:test';

import { buildOf, checkOf, editedBy } from '../packages/broapp-autoapp/src/knowledge/evaluate.ts';

const release = 'a'.repeat(32);

describe('a cycle counts', () => {
  test('as an edit when it carried hunks or files, and not otherwise', () => {
    expect(editedBy({ tool: 'candidate.cycle', input: { hunks: [{ path: 'src/a.ts' }] }, output: {} })).toBe(true);
    expect(editedBy({ tool: 'candidate.cycle', input: { hunks: [], create: [{ path: 'src/new.ts' }] }, output: {} })).toBe(true);
    expect(editedBy({ tool: 'candidate.cycle', input: { hunks: [] }, output: {} })).toBe(false);
    expect(editedBy({ tool: 'source.edit', input: {}, output: {} })).toBe(true);
    expect(editedBy({ tool: 'source.read', input: {}, output: {} })).toBe(false);
  });

  test('as a build when it built, with its problems when it failed, and not when the build was declined', () => {
    expect(buildOf({ tool: 'candidate.cycle', input: {}, output: { build: { ok: true, releaseId: release } } })).toEqual({
      ok: true,
      releaseId: release,
    });
    expect(
      buildOf({ tool: 'candidate.cycle', input: {}, output: { build: { ok: false, problems: [{ stage: 'contract', message: 'x' }] } } }),
    ).toEqual({ ok: false, problems: [{ stage: 'contract', message: 'x' }] });
    expect(buildOf({ tool: 'candidate.cycle', input: {}, output: { build: { declined: true } } })).toBeNull();
    expect(buildOf({ tool: 'candidate.cycle', input: {}, output: { applied: {} } })).toBeNull();
    // The old tool still counts.
    expect(buildOf({ tool: 'candidate.build', input: {}, output: { ok: true, releaseId: release } })).toEqual({ ok: true, releaseId: release });
    expect(buildOf({ tool: 'source.read', input: {}, output: { ok: true, releaseId: release } })).toBeNull();
  });

  test('as a check when it reached one, passing only when every example passed', () => {
    const passed = { tool: 'candidate.cycle', input: {}, output: { build: { ok: true, releaseId: release }, check: { passed: 2, of: 2, failed: [] } } };
    expect(checkOf(passed)).toEqual({ releaseId: release, allPassed: true, ids: null });
    const failed = { tool: 'candidate.cycle', input: {}, output: { build: { ok: true, releaseId: release }, check: { passed: 1, of: 2, failed: [{ id: 'x' }] } } };
    expect(checkOf(failed)?.allPassed).toBe(false);
    const none = { tool: 'candidate.cycle', input: {}, output: { build: { ok: true, releaseId: release }, check: { passed: 0, of: 0, failed: [] } } };
    expect(checkOf(none)?.allPassed).toBe(false);
    expect(checkOf({ tool: 'candidate.cycle', input: {}, output: { build: { ok: false, problems: [] } } })).toBeNull();
    // The old tool reports every result, ids included.
    expect(
      checkOf({ tool: 'candidate.check', input: { releaseId: release }, output: { results: [{ id: 'a', passed: true }, { id: 'b', passed: true }] } }),
    ).toEqual({ releaseId: release, allPassed: true, ids: ['a', 'b'] });
  });
});
