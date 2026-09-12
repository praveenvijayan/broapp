/**
 * The theme, in a browser.
 *
 * `tests/autoapp-theme.test.ts` holds the token table, the generated
 * stylesheet, the starter and the presets to each other. It cannot say what a
 * browser computed, and until this file nothing in the repository could: the
 * renderer and the AI panel were checked as text, never as one page. So this
 * runs `scripts/theme-check.ts` in process — three themes, three schemes, the
 * panel's select opened so its portal is exercised — and holds the rules it
 * measured.
 *
 * It needs Chromium, which is not part of `bun install`. Where Chromium cannot
 * be launched the whole block is skipped rather than failed: a contributor
 * without it still gets a green `bun test tests`, and CI's `theme` job
 * installs it so that somebody's machine is not the only place this ran.
 *
 *   bun x playwright install chromium
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import type { CheckReport } from '../scripts/theme-check.ts';
import { chromiumRuns, themeCheck } from '../scripts/theme-check.ts';

const available = await chromiumRuns();
// One run, many assertions: building three pages and driving nine combinations
// takes seconds, and doing it once per rule would take minutes. Where Chromium
// is missing the run is skipped and the report below is never looked at. The
// run is a `beforeAll`, not a module-level await, so a failure in it is a
// failed test with the stack, not an "unhandled error between tests".
let report: CheckReport = { combinations: [], failures: [], pageBytes: {}, seconds: 0 };

describe.skipIf(!available)('the theme in a compiled page', () => {
  beforeAll(async () => {
    report = await themeCheck();
  }, 120_000);


  test('every rule the harness checks passes in every combination', () => {
    expect(report.failures).toEqual([]);
  });

  test('nine combinations, and every target was on the page', () => {
    expect(report.combinations.length).toBe(9);
    const missing = report.combinations.flatMap((combination) =>
      combination.targets.filter((target) => !target.found).map((target) => `${combination.theme}/${combination.scheme}: ${target.id}`),
    );
    expect(missing).toEqual([]);
  });

  test('the renderer and the panel agree about the palette', () => {
    for (const combination of report.combinations) {
      const card = combination.targets.find((target) => target.id === 'card');
      const content = combination.targets.find((target) => target.id === 'select-content');
      const cell = combination.targets.find((target) => target.id === 'table-cell');
      expect(card?.backgroundColor).toBeTruthy();
      // The renderer's card reads `--autoapp-surface`, which follows
      // `--surface`; the panel's popover reads `--surface` directly. One
      // palette property, two vocabularies, one colour. (A field is not the
      // comparison to make: the quiet preset points `--autoapp-input`
      // somewhere else on purpose, which is the override case, not a fault.)
      expect(content?.backgroundColor).toBe(card?.backgroundColor);
      expect(content?.color).toBe(cell?.color);
    }
  });

  test("the panel's portalled content carries the panel's token scope", () => {
    const escaped = report.combinations.flatMap((combination) =>
      combination.targets
        .filter((target) => target.drawnBy === 'panel' && !target.inTokenScope)
        .map((target) => `${combination.theme}/${combination.scheme}: ${target.id}`),
    );
    expect(escaped).toEqual([]);
  });

  test('every text and background pair meets 4.5:1', () => {
    const failing = report.combinations.flatMap((combination) =>
      combination.targets
        .filter((target) => target.contrast !== null && target.contrast < 4.5)
        .map((target) => `${combination.theme}/${combination.scheme}: ${target.id} ${String(target.contrast)}:1`),
    );
    expect(failing).toEqual([]);
  });

  test('a token set directly reaches the renderer and not the panel', () => {
    const overridden = report.combinations.filter((combination) => combination.theme === 'override');
    expect(overridden.length).toBe(3);
    for (const combination of overridden) {
      expect(combination.rootAccentToken).not.toBe(combination.panelPrimary);
    }
    // And with no override the two are the same colour, or the case above
    // would prove nothing.
    for (const combination of report.combinations.filter((one) => one.theme !== 'override')) {
      expect(combination.rootAccentToken).toBe(combination.panelPrimary);
    }
  });

  test('the dark scheme is a different theme, not the same one twice', () => {
    const light = report.combinations.find((one) => one.theme === 'starter' && one.scheme === 'light');
    const dark = report.combinations.find((one) => one.theme === 'starter' && one.scheme === 'dark');
    const system = report.combinations.find((one) => one.theme === 'starter' && one.scheme === 'no-preference');
    const colourOf = (combination: typeof light, id: string): string | undefined =>
      combination?.targets.find((target) => target.id === id)?.color;
    expect(colourOf(light, 'table-cell')).not.toBe(colourOf(dark, 'table-cell'));
    // A machine with no preference is light, which is what a page with no
    // forced `color-scheme` must do.
    expect(colourOf(system, 'table-cell')).toBe(colourOf(light, 'table-cell'));
  });
});
