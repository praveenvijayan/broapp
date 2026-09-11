/**
 * The facts the launcher starts with.
 *
 * Each is something the engineer cannot read off a workspace and was measured
 * or decided somewhere in this package's history. They are facts, never
 * procedure: how to work is `instructions.ts`, which a person reviews as a
 * whole, and a document that repeated it would be a second copy of the method
 * that could drift from the first. A test holds them apart sentence by
 * sentence.
 *
 * One seed the prompt suggested is not here: "a `source.edit` hunk over 2 KB was
 * measured not to land; three to eight lines do" is already step 3 of the
 * instructions, word for word in substance, and the rule above excludes it.
 */
import type { Knowledge } from './store.ts';
import { sha256 } from './store.ts';
import { AUTOAPP_VERSION } from './version.ts';

/** Where a lesson applies. Every field optional; an empty object applies anywhere. */
export interface LessonApplies {
  readonly stage?: 'spec' | 'contract' | 'views' | 'page' | 'host' | 'check';
  /** Globs over workspace-relative paths. */
  readonly files?: readonly string[];
  readonly routes?: readonly string[];
}

/** One curated lesson, before it is stored. */
export interface SeedLesson {
  readonly summary: string;
  readonly detail: string;
  /** Words a request or a problem would contain when this applies. */
  readonly trigger: string;
  readonly applies: LessonApplies;
}

/** The launcher's starting facts. Under 300 characters each. */
export const SEED_LESSONS: readonly SeedLesson[] = [
  {
    summary:
      'The renderer has no navigation-only action. A button that only moves the person to another page still names an operation: a read one, such as a status route, with `then` naming the page.',
    detail: 'Found building Notes: its "Back to all notes" button calls notes.status only to reach its `then`.',
    trigger: 'button navigate navigation page back link then action',
    applies: { stage: 'views', files: ['src/shared/views.ts'] },
  },
  {
    summary:
      'The build exports the contract and refuses, at the contract stage, any operation or stream that lacks an effect or a summary.',
    detail: 'exportContract throws naming the route; parseSpec refuses the same thing a second time.',
    trigger: 'effect summary route declare contract operation stream refused',
    applies: { stage: 'contract', files: ['src/shared/contract.ts'] },
  },
  {
    summary:
      'A release inlines everything its host imports except bun:sqlite and Node builtins. A package that is not installed in the workspace cannot be added by editing package.json: the build has nothing to resolve it from.',
    detail: 'Dependencies are installed when an application is imported or created, not when package.json changes.',
    trigger: 'dependency package module import resolve install bundle could not find',
    applies: { stage: 'host', files: ['package.json', 'src/host/**'] },
  },
  {
    summary:
      'A migration checksum in autoapp.json is validated as 64 hex characters and never compared with anything. The list is history: a new step takes the next id, and an old step is never changed or removed.',
    detail: 'Nothing computes or verifies MigrationSpec.checksum yet (reports 03 and 11).',
    trigger: 'migration checksum schema schemaversion autoapp append history',
    applies: { stage: 'spec', files: ['autoapp.json'] },
  },
  {
    summary:
      'A component id in views.ts is the key a person’s customisations are stored under. A renamed id does not carry them across; they are reported as a conflict against an id that no longer exists.',
    detail: 'Overrides live in the application’s own data directory, keyed by component id.',
    trigger: 'component rename views override customisation conflict',
    applies: { stage: 'views', files: ['src/shared/views.ts'] },
  },
  {
    summary:
      'An operation that writes a file, such as notes.backup, is a write, not external, so MCP clients are offered it. Only external operations are withheld from MCP.',
    detail: 'The effect vocabulary does not distinguish writing the data directory from writing a file beside it (report 08).',
    trigger: 'mcp external write backup file effect offered agent',
    applies: { files: ['src/shared/contract.ts'] },
  },
];

/**
 * Insert the seeds, once, into an empty lesson table.
 *
 * Once means "when there are no lessons at all": a person who has retired a
 * seed has a table that is not empty, and must not find it back after a
 * restart. Every insert is one corpus version, so a context row can say which
 * body of lessons it was served from.
 */
export function seedLessons(knowledge: Knowledge, instructions: string, now: number = Date.now()): number {
  const { db } = knowledge;
  const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lessons').get()?.n ?? 0;
  if (count > 0) return 0;
  const instructionsHash = sha256(instructions).slice(0, 32);
  db.transaction(() => {
    for (const seed of SEED_LESSONS) {
      const inserted = db
        .query<null, [string, string, string, string, string, string, number, number]>(
          `INSERT INTO lessons
             (version, status, origin, scope, applies, summary, detail, trigger,
              instructions_hash, autoapp_version, created_at, updated_at)
           VALUES (1, 'confirmed', 'curated', 'global', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          JSON.stringify(seed.applies),
          seed.summary,
          seed.detail,
          seed.trigger,
          instructionsHash,
          AUTOAPP_VERSION,
          now,
          now,
        );
      const lessonId = Number(inserted.lastInsertRowid);
      // The full-text row shares the lesson's rowid, which is how a match is
      // joined back to its lesson.
      db.query<null, [number, string, string]>(
        'INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)',
      ).run(lessonId, seed.summary, seed.trigger);
      db.query<null, [number, number]>(
        `INSERT INTO corpus_versions (version, lesson_id, change, at)
         VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM corpus_versions), ?, 'seed', ?)`,
      ).run(lessonId, now);
    }
  })();
  return SEED_LESSONS.length;
}
