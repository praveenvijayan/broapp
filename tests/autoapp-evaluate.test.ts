/**
 * What the evaluation counts as an edit, a build and a check.
 *
 * The clean run after 0.4.2 reported no builds and no edits for twelve turns
 * that had built and checked, because it counted `candidate.build` and
 * `source.edit` and every run had used `candidate.cycle`. These are the three
 * functions every such column now goes through.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildOf, checkOf, editedBy, twoTurnColumns } from '../packages/broapp-autoapp/src/knowledge/evaluate.ts';

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
      { appId: 'items', existing: new Set(['src/host/app.ts']), changed: null, tokens: 9 },
    );
    expect(columns).toEqual({ readsBeforeEdit: 2, repeatedReads: 1, repeatedActions: 1, tokens: 9, turnOneCalls: 3, readChangedFirst: null });
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
      { appId: 'items', existing: new Set(['src/host/app.ts']), changed: null, tokens: 0 },
    );
    expect(columns.repeatedActions).toBe(2);
    expect(columns.readsBeforeEdit).toBe(0);
  });

  test('11a. the changed file counts as read first only when it was read before it was edited', () => {
    const context = { appId: 'items', existing: new Set<string>(), changed: 'src/shared/contract.ts', tokens: 0 };
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
