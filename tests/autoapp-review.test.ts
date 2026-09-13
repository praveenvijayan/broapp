/**
 * A person's changes to the lessons, through `review.ts`.
 *
 * The command line and the launcher's tab share these three functions, so the
 * properties are asked of the functions themselves: what each writes, that a
 * retired or superseded lesson is gone from the index and from what a fresh
 * serving offers, that a written lesson is served for its own words, that a
 * lesson which breaks the distiller's limits is refused by name, and that the
 * command line still writes exactly the rows it wrote before.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HostLogger } from 'broapp/host';
import { createCandidateStates } from 'broapp-autoapp/engineer';
import {
  confirmLesson,
  createEventLog,
  createServe,
  openKnowledge,
  openSession,
  retireLesson,
  runKnowledgeCommand,
  writeLesson,
  type Knowledge,
} from 'broapp-autoapp/knowledge';
import { layout } from 'broapp-autoapp/spec';

const quiet: HostLogger = { warn: () => undefined, error: () => undefined };
const signal = new AbortController().signal;
const scratch: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      // The next close may be the one that matters.
    }
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A launcher root with an empty `items` workspace and its knowledge store. */
function world(): { directory: string; knowledge: Knowledge } {
  const directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  scratch.push(directory);
  mkdirSync(join(directory, 'apps', 'items', 'source'), { recursive: true });
  const knowledge = openKnowledge(join(directory, 'launcher'));
  closers.push(() => knowledge.close());
  return { directory, knowledge };
}

/** Insert a provisional lesson by hand, with its index row. */
function handLesson(knowledge: Knowledge, summary: string, trigger: string): number {
  const id = Number(
    knowledge.db
      .query<null, [string, string, string]>(
        `INSERT INTO lessons (version, status, origin, scope, applies, summary, detail, trigger,
                              instructions_hash, autoapp_version, created_at, updated_at)
         VALUES (1, 'provisional', 'distilled', 'global', '{}', ?, 'detail', ?, ?, '0.0.0', 0, 0)`,
      )
      .run(summary, trigger, 'h').lastInsertRowid,
  );
  knowledge.db.query<null, [number, string, string]>('INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)').run(id, summary, trigger);
  return id;
}

interface LessonRow {
  status: string;
  review: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  updated_at: number;
}
function row(knowledge: Knowledge, id: number): LessonRow | null {
  return knowledge.db
    .query<LessonRow, [number]>('SELECT status, review, reviewed_by, reviewed_at, updated_at FROM lessons WHERE id = ?')
    .get(id);
}

function changes(knowledge: Knowledge): { lesson_id: number; change: string }[] {
  return knowledge.db.query<{ lesson_id: number; change: string }, []>('SELECT lesson_id, change FROM corpus_versions ORDER BY version').all();
}

function inIndex(knowledge: Knowledge, id: number): boolean {
  return knowledge.db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM lessons_fts WHERE rowid = ?').get(id)?.n === 1;
}

function matches(knowledge: Knowledge, word: string): number[] {
  return knowledge.db
    .query<{ rowid: number }, [string]>('SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH ?')
    .all(`"${word}"`)
    .map((entry) => entry.rowid);
}

/** A fresh serving over the store, and the lesson ids a request is offered. */
async function offered(directory: string, knowledge: Knowledge, text: string): Promise<number[]> {
  const root = layout(directory);
  const serve = createServe({
    knowledge,
    log: createEventLog(knowledge, { source: 'launcher', tee: quiet }),
    layout: root,
    states: createCandidateStates(root, quiet),
    session: openSession(join(directory, 'launcher'), quiet),
    instructions: 'test instructions',
    apps: () => [{ appId: 'items', name: 'Items', currentRelease: null, serving: false, pid: null, schemaVersion: null, activationPending: false }],
    seed: false,
  });
  const runId = `r-${String(Math.random()).slice(2, 8)}`;
  const refs = await serve.search({ text, limit: 10, runId }, signal);
  serve.ended(runId);
  return refs.filter((ref) => ref.ref.startsWith('lesson:')).map((ref) => Number(ref.ref.slice('lesson:'.length)));
}

describe('review.ts', () => {
  test('confirm sets the status, clears the flag, names the reviewer and writes one corpus version', () => {
    const { knowledge } = world();
    const id = handLesson(knowledge, 'A colour tag is stored on the item row itself.', 'colour tag item row');
    knowledge.db.query<null, [number]>("UPDATE lessons SET review = 'needs_review:recurring' WHERE id = ?").run(id);

    expect(confirmLesson(knowledge, id, 'pv', 1_000)).toBe(true);
    expect(row(knowledge, id)).toEqual({ status: 'confirmed', review: null, reviewed_by: 'pv', reviewed_at: 1_000, updated_at: 1_000 });
    expect(changes(knowledge)).toEqual([{ lesson_id: id, change: 'confirm' }]);

    // Already what it would become: nothing written.
    expect(confirmLesson(knowledge, id, 'someone else', 2_000)).toBe(false);
    expect(row(knowledge, id)?.reviewed_by).toBe('pv');
    expect(changes(knowledge)).toHaveLength(1);
  });

  test('retire leaves the index and stops being served on a fresh serving', async () => {
    const { directory, knowledge } = world();
    const id = handLesson(knowledge, 'A colour tag is stored on the item row itself.', 'colour tag item row');
    expect(await offered(directory, knowledge, 'store a colour tag on each item')).toContain(id);

    expect(retireLesson(knowledge, id, 'pv', 1_000)).toBe(true);
    expect(row(knowledge, id)).toMatchObject({ status: 'retired', reviewed_by: 'pv', reviewed_at: 1_000 });
    expect(inIndex(knowledge, id)).toBe(false);
    expect(matches(knowledge, 'colour')).toEqual([]);
    expect(changes(knowledge)).toEqual([{ lesson_id: id, change: 'retire' }]);
    expect(await offered(directory, knowledge, 'store a colour tag on each item')).not.toContain(id);
    expect(retireLesson(knowledge, id, 'pv', 2_000)).toBe(false);
  });

  test('write inserts a curated, confirmed lesson; with supersedes it replaces the old one', async () => {
    const { directory, knowledge } = world();
    const old = handLesson(knowledge, 'A colour tag is stored in a separate table.', 'colour tag item row');
    const written = writeLesson(
      knowledge,
      {
        summary: 'A colour tag is stored on the item row itself, as plain text.',
        detail: 'Found by a person reading the schema.',
        trigger: 'colour tag item row',
        scope: 'app:items',
        applies: { stage: 'host', routes: ['items.tag'], files: [' src/host/app.ts ', ''] },
        supersedes: old,
      },
      'pv',
      5_000,
    );
    const lesson = knowledge.db
      .query<{ status: string; origin: string; scope: string; applies: string; supersedes: number | null; reviewed_by: string }, [number]>(
        'SELECT status, origin, scope, applies, supersedes, reviewed_by FROM lessons WHERE id = ?',
      )
      .get(written);
    expect(lesson).toEqual({
      status: 'confirmed',
      origin: 'curated',
      scope: 'app:items',
      applies: JSON.stringify({ stage: 'host', files: ['src/host/app.ts'], routes: ['items.tag'] }),
      supersedes: old,
      reviewed_by: 'pv',
    });
    expect(inIndex(knowledge, written)).toBe(true);
    expect(row(knowledge, old)?.status).toBe('superseded');
    expect(inIndex(knowledge, old)).toBe(false);
    expect(changes(knowledge)).toEqual([
      { lesson_id: written, change: 'write' },
      { lesson_id: old, change: 'supersede' },
    ]);
    const served = await offered(directory, knowledge, 'store a colour tag on each item row');
    expect(served).toContain(written);
    expect(served).not.toContain(old);

    // A lesson that is no longer served cannot be replaced again.
    expect(() => writeLesson(knowledge, { summary: 's', detail: 'd', trigger: 't', scope: 'global', supersedes: old }, 'pv')).toThrow(/superseded/);
  });

  test('write refuses what the distiller would refuse, naming the field', () => {
    const { knowledge } = world();
    const base = { summary: 'A fact.', detail: 'Where it was found.', trigger: 'fact words', scope: 'global' };
    expect(() => writeLesson(knowledge, { ...base, summary: '   ' }, 'pv')).toThrow(/^summary: /);
    expect(() => writeLesson(knowledge, { ...base, detail: 'x'.repeat(2_001) }, 'pv')).toThrow(/^detail: .*2000/);
    expect(() => writeLesson(knowledge, { ...base, applies: { stage: 'deploy' } }, 'pv')).toThrow(/^stage: /);
    expect(() => writeLesson(knowledge, { ...base, scope: 'items' }, 'pv')).toThrow(/^scope: /);
    expect(() => writeLesson(knowledge, { ...base, scope: 'app:No Such' }, 'pv')).toThrow(/^scope: /);
    expect(knowledge.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lessons').get()?.n).toBe(0);
    expect(changes(knowledge)).toEqual([]);
  });

  test('the command line writes the same rows as the functions', () => {
    const viaCli = world();
    const viaFunctions = world();
    const lessons = (knowledge: Knowledge): [number, number] => [
      handLesson(knowledge, 'The first provisional lesson, about effects.', 'effect route words'),
      handLesson(knowledge, 'The second provisional lesson, about views.', 'view page words'),
    ];
    const [cliFirst, cliSecond] = lessons(viaCli.knowledge);
    const [first, second] = lessons(viaFunctions.knowledge);
    // The command opens the store itself, and closes it.
    viaCli.knowledge.close();

    const lines: string[] = [];
    const command = (...argv: string[]): number =>
      runKnowledgeCommand({ root: layout(viaCli.directory), argv, out: (line) => lines.push(line), err: (line) => lines.push(line), now: 7_000 });
    expect(command('confirm', String(cliFirst), '--by', 'pv', '--yes')).toBe(0);
    expect(command('retire', String(cliSecond), '--by', 'pv')).toBe(0);
    // A second confirmation of a lesson with nothing to review writes nothing and is not an error.
    expect(command('confirm', String(cliFirst), '--by', 'pv')).toBe(0);
    expect(lines).toContain(`lesson ${String(cliFirst)} is already confirmed`);

    confirmLesson(viaFunctions.knowledge, first, 'pv', 7_000);
    retireLesson(viaFunctions.knowledge, second, 'pv', 7_000);

    const reopened = openKnowledge(join(viaCli.directory, 'launcher'));
    closers.push(() => reopened.close());
    expect(row(reopened, cliFirst)).toEqual(row(viaFunctions.knowledge, first));
    expect(row(reopened, cliSecond)).toEqual(row(viaFunctions.knowledge, second));
    expect(inIndex(reopened, cliSecond)).toBe(false);
    expect(changes(reopened)).toEqual(changes(viaFunctions.knowledge));
  });
});
