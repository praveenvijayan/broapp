/**
 * What the evaluation counts as an edit, a build and a check.
 *
 * The clean run after 0.4.2 reported no builds and no edits for twelve turns
 * that had built and checked, because it counted `candidate.build` and
 * `source.edit` and every run had used `candidate.cycle`. These are the three
 * functions every such column now goes through.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildOf,
  checkOf,
  editedBy,
  evaluationTable,
  tokenMean,
  tokensCell,
  triedEdit,
  twoTurnColumns,
  type EvaluationRow,
} from '../packages/broapp-autoapp/src/knowledge/evaluate.ts';

const release = 'a'.repeat(32);

describe('a cycle counts', () => {
  // What `editedBy` meant until 15d is `triedEdit` now; the assertions are the same.
  test('as an attempted edit when it carried hunks or files, and not otherwise', () => {
    expect(triedEdit({ tool: 'candidate.cycle', input: { hunks: [{ path: 'src/a.ts' }] }, output: {} })).toBe(true);
    expect(triedEdit({ tool: 'candidate.cycle', input: { hunks: [], create: [{ path: 'src/new.ts' }] }, output: {} })).toBe(true);
    expect(triedEdit({ tool: 'candidate.cycle', input: { hunks: [] }, output: {} })).toBe(false);
    expect(triedEdit({ tool: 'source.edit', input: {}, output: {} })).toBe(true);
    expect(triedEdit({ tool: 'source.read', input: {}, output: {} })).toBe(false);
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

describe('what a second turn repeats', () => {
  const HUNK = { path: 'src/host/app.ts', find: 'a', replace: 'a // kept' };
  const turnOne = [
    { tool: 'source.read', input: { appId: 'items', path: 'src/shared/contract.ts' }, output: { rev: 'r1', content: '' } },
    { tool: 'spec.reference', input: { topic: 'views' }, output: { text: '' } },
    { tool: 'source.edit', input: { appId: 'items', message: 'm', hunks: [HUNK] }, output: { changed: ['src/host/app.ts'] } },
  ];

  test('10. a re-read of a path counts one repeated read, and a re-applied hunk one repeated action', () => {
    const columns = twoTurnColumns(
      turnOne,
      [
        { tool: 'source.read', input: { appId: 'items', path: 'src/shared/contract.ts' }, output: { rev: 'r2', content: '' } },
        { tool: 'source.read', input: { appId: 'items', path: 'src/ui/main.tsx' }, output: { rev: 'r2', content: '' } },
        { tool: 'candidate.cycle', input: { appId: 'items', message: 'm', hunks: [HUNK], create: [{ path: 'src/new.ts' }] }, output: {} },
      ],
      { appId: 'items', existing: new Set(['src/host/app.ts']), changed: null, tokens: 9, tokensComplete: true },
    );
    expect(columns).toEqual({ readsBeforeEdit: 2, repeatedReads: 1, repeatedActions: 1, tokens: 9, tokensComplete: true, turnOneCalls: 3, readChangedFirst: null });
  });

  test('a hunk the first turn failed to apply is not a repeat, and creating a file that exists is', () => {
    const failed = [{ tool: 'source.edit', input: { appId: 'items', message: 'm', hunks: [HUNK] }, output: { error: 'no match' } }];
    const columns = twoTurnColumns(
      failed,
      [
        { tool: 'source.edit', input: { appId: 'items', message: 'm', hunks: [HUNK] }, output: {} },
        { tool: 'candidate.cycle', input: { appId: 'items', message: 'm', hunks: [], create: [{ path: 'src/host/app.ts' }] }, output: {} },
        { tool: 'apps.create', input: { appId: 'items', name: 'Items' }, output: {} },
      ],
      { appId: 'items', existing: new Set(['src/host/app.ts']), changed: null, tokens: 0, tokensComplete: true },
    );
    expect(columns.repeatedActions).toBe(2);
    expect(columns.readsBeforeEdit).toBe(0);
  });

  test('11a. the changed file counts as read first only when it was read before it was edited', () => {
    const context = { appId: 'items', existing: new Set<string>(), changed: 'src/shared/contract.ts', tokens: 0, tokensComplete: true };
    const read = { tool: 'source.read', input: { appId: 'items', path: 'src/shared/contract.ts' }, output: {} };
    const edit = { tool: 'source.edit', input: { appId: 'items', message: 'm', hunks: [{ path: 'src/shared/contract.ts', find: 'x', replace: 'y' }] }, output: {} };
    expect(twoTurnColumns([], [read, edit], context).readChangedFirst).toBe(true);
    expect(twoTurnColumns([], [edit, read], context).readChangedFirst).toBe(false);
    expect(twoTurnColumns([], [], context).readChangedFirst).toBe(false);
  });
});

describe('a two-turn task on the fake adapter', () => {
  const scratch: string[] = [];
  const children: { kill(): void }[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** The non-system messages of a prompt. */
  const conversation = (prompt: unknown): { role: string; content: unknown }[] =>
    (prompt as { role: string; content: unknown }[]).filter((message) => message.role !== 'system');
  /** Whether a prompt's last message is the person saying `continue`. */
  const isContinue = (prompt: unknown): boolean => JSON.stringify(conversation(prompt).at(-1)).includes('"text":"continue"');
  /** The revisions the `source.read` results in a prompt report. */
  const revisions = (prompt: unknown): string[] => [...JSON.stringify(prompt).matchAll(/\\?"rev\\?":\\?"([0-9a-f]{40,64})/g)].map((match) => match[1] ?? '');

  test('9 and 11. turn one stops at its first edit; turn two gets its tool results only under structured history, and sees the changed file’s new revision', async () => {
    // Under the tests directory, for the reason the knowledge test gives: the
    // starter resolves its packages from what it sits among.
    const runRoot = join(import.meta.dir, '.autoapp-run');
    mkdirSync(runRoot, { recursive: true });
    const directory = mkdtempSync(join(runRoot, 'evaluate-two-turn-'));
    scratch.push(directory);
    mkdirSync(join(directory, 'launcher'), { recursive: true });
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', join(import.meta.dir, 'autoapp-evaluate-child.ts'), directory, 'two-turn'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`the evaluation failed: ${stderr}`);
    const { rows, markdown, prompts } = JSON.parse(stdout) as {
      rows: { condition: string; history: string; restart: boolean; task: string; twoTurn: Record<string, number | null> | null }[];
      markdown: string;
      prompts: Record<string, unknown[]>;
    };

    // Two conditions, two history modes, and the restart cell for one of them.
    expect(rows.map((row) => `${row.condition} ${row.history}${row.restart ? ' restart' : ''}`)).toEqual([
      'baseline text',
      'baseline structured',
      'orientation+facts text',
      'orientation+facts structured',
      'orientation+facts structured restart',
    ]);
    for (const row of rows) {
      // Turn one read, edited, and was stopped: its closing sentence was never asked for.
      expect(row.twoTurn?.['meanTurnOneCalls']).toBe(2);
      // 10, end to end: the script re-reads under text and re-applies the hunk under both.
      expect(row.twoTurn?.['meanRepeatedActions']).toBe(1);
      expect(row.twoTurn?.['meanRepeatedReads']).toBe(row.history === 'text' ? 1 : 0);
      // 11: only the run that read the changed file gets the column.
      expect(row.twoTurn?.['readChangedFirst']).toBe(row.history === 'text' ? 1 : 0);
    }

    const turnTwo = (key: string): unknown => {
      const found = (prompts[key] ?? []).find(isContinue);
      if (found === undefined) throw new Error(`no turn two in ${key}`);
      return found;
    };
    const hasToolResults = (prompt: unknown): boolean => conversation(prompt).some((message) => message.role === 'tool');
    for (const condition of ['baseline', 'orientation+facts']) {
      const structured = turnTwo(`${condition}/structured/1`);
      expect(hasToolResults(structured)).toBe(true);
      expect(JSON.stringify(conversation(structured))).toContain('"toolName":"source.edit"');
      expect(hasToolResults(turnTwo(`${condition}/text/1`))).toBe(false);
    }
    // The restarted launcher's turn two was a fresh tab, and still got them.
    expect(hasToolResults(turnTwo('orientation+facts/structured/restart/2'))).toBe(true);

    // 11: turn one's read and turn two's read of the changed file report different revisions.
    const textPrompts = prompts['baseline/text/1'] ?? [];
    const [firstRead] = revisions(textPrompts[1]);
    const secondReads = revisions(textPrompts[3]);
    expect(firstRead).toBeDefined();
    expect(secondReads.at(-1)).toBeDefined();
    expect(secondReads.at(-1)).not.toBe(firstRead);

    expect(markdown).toContain('| condition | history | task | runs | working code | workflow completed | timed out | turn-one calls | reads before first edit | repeated reads | repeated actions | turn-two tokens | read changed file first |');
    expect(markdown).toContain('| orientation+facts | structured, restart | starter-priority | 1 |');
  }, 300_000);
});

// ── 15d. Counting what happened ──────────────────────────────────────────────

describe('15d: an edit is one that landed', () => {
  // 1.
  test('refused, denied, stalled and all-missed are tried but not edits; a landed edit and a patched cycle whose build failed are both', () => {
    const hunks = { hunks: [{ path: 'src/host/app.ts', find: 'a', replace: 'b' }] };
    const notEdits = [
      // The workspace refused it: the hunk matched nothing, reported as the tool's error.
      { tool: 'source.edit', input: hunks, output: { error: 'not found in src/host/app.ts: a' } },
      // The person, or the run, said no.
      { tool: 'source.edit', input: hunks, output: { error: 'declined', denied: true } },
      // Refused before patching: three cycles ended the same way.
      { tool: 'candidate.cycle', input: hunks, output: { error: '3 cycles in this turn have ended with the same failure' } },
      // Every hunk missed, so nothing was applied and the cycle came back as an error.
      { tool: 'candidate.cycle', input: hunks, output: { error: 'not found in src/host/app.ts: a' } },
    ];
    for (const call of notEdits) {
      expect(editedBy(call)).toBe(false);
      expect(triedEdit(call)).toBe(true);
    }
    expect(editedBy({ tool: 'source.edit', input: hunks, output: { changed: ['src/host/app.ts'] } })).toBe(true);
    expect(editedBy({ tool: 'source.change', input: { changes: [{ path: 'src/a.ts' }] }, output: { changed: ['src/a.ts'] } })).toBe(true);
    const patchedThenFailed = {
      tool: 'candidate.cycle',
      input: hunks,
      output: { applied: { changed: ['src/host/app.ts'], matchedBy: ['exact'], diff: '' }, build: { ok: false, problems: [{ stage: 'host', message: 'x' }] } },
    };
    expect(editedBy(patchedThenFailed)).toBe(true);
    // A cycle with no hunks verifies; nothing was changed, so nothing landed.
    expect(editedBy({ tool: 'candidate.cycle', input: { hunks: [] }, output: { applied: { changed: [] }, build: { ok: true, releaseId: release } } })).toBe(false);
  });
});

describe('15d: a turn’s tokens are a known subtotal with a flag', () => {
  const measured = (total: number, complete: boolean): { total: number; complete: boolean } => ({ total, complete });

  /** A single-turn row with everything at nothing but its tokens. */
  function row(meanTokens: { mean: number | null; of: number }, runs = 3): EvaluationRow {
    const none = { mean: null, of: 0 };
    return {
      condition: 'baseline',
      task: 'notes-archive',
      history: 'text',
      restart: false,
      twoTurn: null,
      runs,
      workingCode: 0,
      workflowCompleted: 0,
      callsToFirstEdit: none,
      callsToFirstEditTried: none,
      callsToFirstBuild: none,
      reachedBuild: 0,
      failedBuilds: 0,
      meanModelMs: 0,
      meanToolMs: 0,
      approvals: 0,
      meanTokens,
      knownTokens: 40,
      recurringSignatures: 0,
      includedUsed: 0,
      includedIgnored: 0,
      readsNotOffered: 0,
      unrelatedCredit: 0,
      timedOut: 0,
    };
  }
  const about = { model: { provider: 'fake', id: 'fake-1' }, runs: 3, timeout: 60_000 };

  // 6.
  test('a turn that was cut short is left out of the mean, counted in its denominator, and printed (2/3)', () => {
    const mean = tokenMean([measured(100, true), measured(200, true), measured(50, false)]);
    expect(mean).toEqual({ mean: 150, of: 2 });
    expect(tokensCell(mean, 3)).toBe('150 (2/3)');
    expect(evaluationTable([row(mean)], about)).toContain('| 150 (2/3) | 40 |');
    // Every run whole: no count, as the other mean columns print it.
    expect(tokensCell(tokenMean([measured(1_000, true), measured(3_000, true)]), 2)).toBe('2,000');
  });

  // 7.
  test('a cell with no complete run prints — (0/3), never 0', () => {
    const mean = tokenMean([measured(0, false), measured(12, false), measured(30, false)]);
    expect(mean).toEqual({ mean: null, of: 0 });
    expect(tokensCell(mean, 3)).toBe('— (0/3)');
    const table = evaluationTable([row(mean)], about);
    expect(table).toContain('| — (0/3) |');
    expect(table).toContain('| mean tokens | known tokens (floor) |');
    expect(table).toContain('| calls to first edit | calls to first edit tried |');
  });

  // 2, 3 and 6 through the harness.
  test('turn one stops after the edit that landed, not the one refused; both first-edit counts; its tokens are a subtotal', async () => {
    const runRoot = join(import.meta.dir, '.autoapp-run');
    mkdirSync(runRoot, { recursive: true });
    const directory = mkdtempSync(join(runRoot, 'evaluate-refused-edit-'));
    try {
      mkdirSync(join(directory, 'launcher'), { recursive: true });
      const child = Bun.spawn({
        cmd: [process.execPath, 'run', join(import.meta.dir, 'autoapp-evaluate-child.ts'), directory, 'refused-edit'],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`the evaluation failed: ${stderr}`);
      const { rows, prompts } = JSON.parse(stdout) as { rows: EvaluationRow[]; prompts: Record<string, unknown[]> };

      expect(rows.map((one) => one.history)).toEqual(['text', 'structured']);
      for (const one of rows) {
        // 2. read, refused edit, landed edit: stopped after the third call.
        expect(one.twoTurn?.meanTurnOneCalls).toBe(3);
        // 3. The first edit that landed is call 3; the first tried is call 2.
        expect(one.callsToFirstEdit).toEqual({ mean: 3, of: 1 });
        expect(one.callsToFirstEditTried).toEqual({ mean: 2, of: 1 });
        // 6. Turn one was stopped, so the run's total is not known; turn two finished.
        expect(one.meanTokens).toEqual({ mean: null, of: 0 });
        expect(one.knownTokens).toBeGreaterThan(0);
        expect(one.twoTurn?.meanTokens.of).toBe(1);
      }
      // 2. The workspace had moved when turn one stopped: turn two's read of
      // the file reports a revision turn one's read did not.
      const revisions = (prompt: unknown): string[] => [...JSON.stringify(prompt).matchAll(/\\?"rev\\?":\\?"([0-9a-f]{40,64})/g)].map((match) => match[1] ?? '');
      const textPrompts = prompts['baseline/text/1'] ?? [];
      const before = revisions(textPrompts[1])[0];
      const after = revisions(textPrompts.at(-1)).at(-1);
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect(after).not.toBe(before);

      // 6, per turn, as the harness measured it.
      const stamp = readdirSync(join(directory, 'evaluate')).find((name) => name !== 'base') ?? '';
      const runs = readFileSync(join(directory, 'evaluate', stamp, 'runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { tokens: { total: number; complete: boolean }; twoTurn: { tokensComplete: boolean } });
      for (const run of runs) {
        expect(run.tokens.complete).toBe(false);
        expect(run.tokens.total).toBeGreaterThan(0);
        expect(run.twoTurn.tokensComplete).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 300_000);
});
