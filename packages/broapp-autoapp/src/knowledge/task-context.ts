/**
 * Two switches over what a task's turn is given, in a file a person can edit.
 *
 * 14a and 14b between them measured no run in which the attempts document or
 * the lessons that share a file with the task (the second tier) helped a
 * retry, on one local model, and nothing on any other. They stay on, because
 * no run showed them doing harm either. But turning either off should not need
 * a rebuild, so `task-context.json` in the launcher's data directory says
 * `{ "attempts": boolean, "related": boolean }`, read the way
 * `intent-models.json` is: a missing or unreadable file, or a field that is not
 * a boolean, means on, because a setting nobody made should change nothing.
 *
 * It is read again for every turn, so an edit applies to the next one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file, inside the launcher's own data directory. */
export const TASK_CONTEXT_FILE = 'task-context.json';

/** Whether a task's turn is given each of the two. */
export interface TaskContextSwitches {
  /** The attempts document, `attempts:<appId>`, on a retry. */
  readonly attempts: boolean;
  /** Lessons that share a file with the task. */
  readonly related: boolean;
}

export const DEFAULT_TASK_CONTEXT: TaskContextSwitches = { attempts: true, related: true };

/** Read the switches, or both on when there is no file or it cannot be read. */
export function readTaskContext(dataDir: string): TaskContextSwitches {
  const path = join(dataDir, TASK_CONTEXT_FILE);
  if (!existsSync(path)) return DEFAULT_TASK_CONTEXT;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_TASK_CONTEXT;
    const record = parsed as Record<string, unknown>;
    return {
      attempts: record['attempts'] !== false,
      related: record['related'] !== false,
    };
  } catch {
    return DEFAULT_TASK_CONTEXT;
  }
}
