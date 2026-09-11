/**
 * What a replay's runs say, in a word and a table.
 *
 * Pure, so the review command can print the same table from stored rows that
 * the replay command printed as it ran. The word is shown, never applied:
 * nothing reads it to change a lesson's status.
 */

/** One replayed run, as a table row needs it. */
export interface ReplayRow {
  readonly arm: string;
  readonly n: number;
  readonly episodeId: number;
  readonly outcome: string;
  readonly steps: number;
  readonly ms: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly buildReached: boolean;
}

/**
 * The verdict words.
 *
 * `supports`: passed only with the lesson. `unrelated`: passed with and without
 * it. `no effect`: failed both ways. The prompt names those three; `against` is
 * the fourth case they leave out — passed only without the lesson — which
 * would otherwise have to be called one of them untruthfully. `inconclusive`:
 * an arm has no run that could be judged.
 */
export type Verdict = 'supports' | 'unrelated' | 'no effect' | 'against' | 'inconclusive';

/** The word for a replay's two arms. */
export function verdictOf(rows: readonly ReplayRow[]): Verdict {
  const judged = (arm: string): number => rows.filter((row) => row.arm === arm && row.outcome !== 'inconclusive').length;
  const passed = (arm: string): number => rows.filter((row) => row.arm === arm && row.outcome === 'passed').length;
  if (judged('with') === 0 || judged('without') === 0) return 'inconclusive';
  const withLesson = passed('with');
  const without = passed('without');
  if (withLesson > 0 && without === 0) return 'supports';
  if (withLesson > 0 && without > 0) return 'unrelated';
  if (withLesson === 0 && without === 0) return 'no effect';
  return 'against';
}

/** Milliseconds as `3m12s`. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** One run, as a cell. */
function cell(row: ReplayRow | undefined): string {
  if (row === undefined) return '';
  const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  return `${row.outcome} (${String(row.steps)} calls, ${duration(row.ms)}, ${tokens.toLocaleString('en')} tokens${row.buildReached ? ', built' : ''})`;
}

/** The two arms side by side, their pass counts, and the word. */
export function replayTable(rows: readonly ReplayRow[]): string[] {
  const arm = (name: string): ReplayRow[] => rows.filter((row) => row.arm === name).sort((a, b) => a.n - b.n);
  const withLesson = arm('with');
  const without = arm('without');
  const width = Math.max(4, ...withLesson.map((row) => cell(row).length));
  const lines = [`run  ${'with'.padEnd(width)}  without`];
  for (let index = 0; index < Math.max(withLesson.length, without.length); index += 1) {
    lines.push(`${String(index + 1).padEnd(3)}  ${cell(withLesson[index]).padEnd(width)}  ${cell(without[index])}`);
  }
  const count = (list: readonly ReplayRow[]): string =>
    `${String(list.filter((row) => row.outcome === 'passed').length)}/${String(list.length)} passed`;
  lines.push(`     ${count(withLesson).padEnd(width)}  ${count(without)}`);
  lines.push(`verdict: ${verdictOf(rows)}`);
  return lines;
}
