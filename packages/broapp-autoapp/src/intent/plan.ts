/**
 * The plan format: what a task must say, and how it is written out.
 *
 * The rows are the source of truth and the markdown is a view of them, so
 * there is a validator and a renderer and no parser. A plan that cannot be
 * parsed back cannot drift from the row it came from, because nothing ever
 * reads it back.
 *
 * Every limit here is one somebody reading the plan relies on: a title short
 * enough to be a row, a summary short enough to read before deciding, two to
 * eight criteria because a task with one is not verifiable and one with twenty
 * is several tasks. Whether a title is imperative cannot be checked, so it is
 * not.
 */
import {
  LABELS,
  PRIORITIES,
  REASONING,
  RISKS,
  type Criterion,
  type PlanProblem,
  type StoredTaskStatus,
  type TaskInput,
  type TaskRecord,
} from './types.ts';

/** `0007-add-tags`: four digits, then one to six lowercase words. */
export const SLUG_PATTERN = /^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+){0,5}$/;

/** The words half of a slug, on its own. */
const WORDS_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){0,5}$/;

/** The most live tasks one intent may hold. More is several requests. */
export const MAX_TASKS_PER_INTENT = 12;

/**
 * The line every plan ends its criteria with.
 *
 * Never stored: the host writes it when it renders, because the host is what
 * checks it. Criterion `c2` of task `0007-add-tags` is tested by the
 * acceptance example whose id is `0007-add-tags-c2`.
 */
export const LAST_CRITERION = 'Every criterion above has exactly one test named after it';

/** The acceptance example that tests one criterion of one task. */
export function exampleIdFor(slug: string, criterionId: string): string {
  return `${slug}-${criterionId}`;
}

/** The words a slug is made of when the caller gives none: the title's first six. */
export function slugWords(title: string): string {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .slice(0, 6);
  return words.length === 0 ? 'task' : words.join('-');
}

/** A slug from its number and its words. */
export function makeSlug(number: number, words: string): string {
  return `${String(number).padStart(4, '0')}-${words}`;
}

/** Another task of the same application, as the validator needs to see it. */
export interface SiblingTask {
  readonly slug: string;
  readonly stored: StoredTaskStatus;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Up to six lines, each at most 200 characters. */
function checkSection(field: string, lines: readonly string[] | undefined, problems: PlanProblem[]): void {
  if (lines === undefined) return;
  if (lines.length > 6) problems.push({ field, message: `${field} has ${String(lines.length)} lines; at most 6.` });
  lines.forEach((line, index) => {
    if (line.length > 200) {
      problems.push({ field, message: `${field} line ${String(index + 1)} is ${String(line.length)} characters; at most 200.` });
    }
  });
}

/** How {@link validateTask} treats a slug it does not know. */
export interface ValidateTaskOptions {
  /**
   * Leave `blocked_by` and `repaid_by` naming a task that does not exist yet
   * for later. A plan is written one task at a time, and the task a stub is
   * repaid by is often the next one; {@link referenceProblems} checks them
   * once every task is in. Naming the task itself is still refused.
   */
  readonly deferReferences?: boolean;
}

/**
 * Everything wrong with one task, or nothing.
 *
 * `siblings` are the other tasks of the same application, across all its
 * intents, because a task may wait on one planned earlier. `slug` is the
 * task's own when it already has one, so it cannot name itself.
 */
export function validateTask(
  input: TaskInput,
  siblings: readonly SiblingTask[],
  slug?: string,
  options: ValidateTaskOptions = {},
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const add = (field: string, message: string): void => {
    problems.push({ field, message });
  };

  const title = input.title;
  if (title.length < 8 || title.length > 100) add('title', `title is ${String(title.length)} characters; it must be 8 to 100.`);
  if (title.endsWith('.')) add('title', 'title ends with a full stop; a title is a summary, not a sentence.');

  if (input.words !== undefined && !WORDS_PATTERN.test(input.words)) {
    add('words', `words "${input.words}" must be one to six lowercase words joined by hyphens.`);
  }

  if (!isOneOf(PRIORITIES, input.priority)) add('priority', `priority must be one of ${PRIORITIES.join(', ')}.`);
  if (!isOneOf(RISKS, input.risk)) add('risk', `risk must be one of ${RISKS.join(', ')}.`);
  if (!isOneOf(REASONING, input.reasoning)) add('reasoning', `reasoning must be one of ${REASONING.join(', ')}.`);

  if (input.labels.length < 1 || input.labels.length > 4) {
    add('labels', `labels has ${String(input.labels.length)} entries; it must have 1 to 4.`);
  }
  for (const label of input.labels) {
    if (!isOneOf(LABELS, label)) add('labels', `label "${String(label)}" is not one of ${LABELS.join(', ')}.`);
  }
  if (new Set(input.labels).size !== input.labels.length) add('labels', 'labels names the same label twice.');

  if (!Number.isInteger(input.estimatedLines) || input.estimatedLines < 1 || input.estimatedLines > 400) {
    add('estimated_lines', `estimated_lines is ${String(input.estimatedLines)}; it must be a whole number from 1 to 400.`);
  }

  if (input.locks.length > 5) add('locks', `locks has ${String(input.locks.length)} entries; at most 5.`);
  for (const lock of input.locks) {
    if (lock.length > 60) add('locks', `lock "${lock.slice(0, 20)}…" is ${String(lock.length)} characters; at most 60.`);
  }

  if (input.summary.length < 20 || input.summary.length > 400) {
    add('summary', `summary is ${String(input.summary.length)} characters; it must be 20 to 400.`);
  }

  // A task another depends on has to be one that will exist: of this
  // application, and not removed.
  const live = new Set(siblings.filter((task) => task.stored !== 'removed').map((task) => task.slug));
  const known = (field: string, named: string): void => {
    if (slug !== undefined && named === slug) add(field, `${field} names this task itself (${named}).`);
    else if (!live.has(named) && options.deferReferences !== true) {
      add(field, `${field} names ${named}, which is not a task of this application.`);
    }
  };
  for (const named of input.blockedBy) known('blocked_by', named);
  if (new Set(input.blockedBy).size !== input.blockedBy.length) add('blocked_by', 'blocked_by names the same task twice.');

  if (input.stub && input.repaidBy === undefined) {
    add('repaid_by', 'A stub needs repaid_by: the task that replaces it with the real thing.');
  }
  if (!input.stub && input.repaidBy !== undefined) {
    add('repaid_by', 'repaid_by is only for a stub; this task is not one.');
  }
  if (input.repaidBy !== undefined) known('repaid_by', input.repaidBy);

  const criteria = input.criteria;
  if (criteria.length < 2 || criteria.length > 8) {
    add('criteria', `criteria has ${String(criteria.length)} entries; it must have 2 to 8.`);
  }
  criteria.forEach((criterion, index) => {
    const length = criterion.text.trim().length;
    if (length === 0 || criterion.text.length > 200) {
      add('criteria', `criterion ${String(index + 1)} is ${String(criterion.text.length)} characters; it must be 1 to 200.`);
    }
  });
  if (input.noFailurePath === undefined) {
    if (!criteria.some((criterion) => criterion.failure)) {
      add(
        'criteria',
        'No criterion says what the person sees when it goes wrong. Add one with failure: true, or give no_failure_path.',
      );
    }
  } else if (input.noFailurePath.length < 20 || input.noFailurePath.length > 200) {
    add('no_failure_path', `no_failure_path is ${String(input.noFailurePath.length)} characters; it must be 20 to 200.`);
  }

  checkSection('non_functional', input.nonFunctional, problems);
  checkSection('test_notes', input.testNotes, problems);
  checkSection('runbook', input.runbook, problems);

  return problems;
}

/** A task as the reference check needs to see it. */
export interface ReferencingTask {
  readonly slug: string;
  readonly blockedBy: readonly string[];
  readonly repaidBy: string | null;
  readonly stored: StoredTaskStatus;
}

/**
 * Every `blocked_by` and `repaid_by` among `tasks` that names no live task of
 * the application, one problem each, naming the task that holds it.
 *
 * `known` is every task of the application, `tasks` those being checked.
 */
export function referenceProblems(tasks: readonly ReferencingTask[], known: readonly SiblingTask[]): PlanProblem[] {
  const live = new Set(known.filter((task) => task.stored !== 'removed').map((task) => task.slug));
  const problems: PlanProblem[] = [];
  for (const task of tasks) {
    if (task.stored === 'removed') continue;
    for (const named of task.blockedBy) {
      if (!live.has(named)) {
        problems.push({ field: 'blocked_by', message: `${task.slug} is blocked by ${named}, which is not a task of this application.` });
      }
    }
    if (task.repaidBy !== null && !live.has(task.repaidBy)) {
      problems.push({ field: 'repaid_by', message: `${task.slug} is repaid by ${task.repaidBy}, which is not a task of this application.` });
    }
  }
  return problems;
}

/** A task as the graph check needs to see it. */
export interface GraphTask {
  readonly slug: string;
  readonly intentId: number;
  readonly blockedBy: readonly string[];
  readonly stored: StoredTaskStatus;
}

/**
 * Everything wrong with a set of tasks taken together, or nothing.
 *
 * A cycle in `blocked_by` is a set of tasks none of which can start, and is
 * named slug by slug so it can be broken. More than twelve live tasks in one
 * intent is refused: that is several requests, and the measurements this
 * feature exists for say long turns are where the model stalls.
 */
export function validateGraph(tasks: readonly GraphTask[]): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const live = tasks.filter((task) => task.stored !== 'removed');

  const perIntent = new Map<number, number>();
  for (const task of live) perIntent.set(task.intentId, (perIntent.get(task.intentId) ?? 0) + 1);
  for (const [intentId, count] of perIntent) {
    if (count > MAX_TASKS_PER_INTENT) {
      problems.push({
        field: 'tasks',
        message: `Intent ${String(intentId)} would have ${String(count)} live tasks; at most ${String(MAX_TASKS_PER_INTENT)}. Split the request.`,
      });
    }
  }

  const bySlug = new Map(live.map((task) => [task.slug, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const seen = new Set<string>();

  const visit = (slug: string): void => {
    const mark = state.get(slug);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const cycle = path.slice(path.indexOf(slug));
      const key = [...cycle].sort().join(',');
      if (!seen.has(key)) {
        seen.add(key);
        problems.push({
          field: 'blocked_by',
          message: `blocked_by forms a cycle: ${[...cycle, slug].join(' → ')}. None of them could ever start.`,
        });
      }
      return;
    }
    state.set(slug, 'visiting');
    path.push(slug);
    for (const next of bySlug.get(slug)?.blockedBy ?? []) {
      if (bySlug.has(next)) visit(next);
    }
    path.pop();
    state.set(slug, 'done');
  };
  for (const task of [...live].sort((a, b) => a.slug.localeCompare(b.slug))) visit(task.slug);

  return problems;
}

/** The fields a plan is rendered from. */
export type RenderableTask = Pick<
  TaskRecord,
  | 'slug'
  | 'title'
  | 'priority'
  | 'labels'
  | 'blockedBy'
  | 'estimatedLines'
  | 'locks'
  | 'risk'
  | 'stub'
  | 'repaidBy'
  | 'summary'
  | 'criteria'
  | 'noFailurePath'
  | 'nonFunctional'
  | 'testNotes'
  | 'runbook'
>;

function list(values: readonly string[]): string {
  return `[${values.join(', ')}]`;
}

function checkbox(criterion: Criterion): string {
  return `- [${criterion.passed === true ? 'x' : ' '}] ${criterion.text}`;
}

/** One optional section, or nothing when it is empty. */
function section(heading: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  return ['', `## ${heading}`, ...lines.map((line) => `- ${line}`)];
}

/**
 * A task as markdown, exactly in the plan format.
 *
 * Front matter in its fixed key order, the summary, the criteria with the
 * host's last line, then each optional section only when it has something in
 * it. `repaid_by` follows `stub` only on a stub.
 */
export function renderPlan(task: RenderableTask): string {
  const lines = [
    '---',
    `title: ${task.title}`,
    `priority: ${task.priority}`,
    `labels: ${list(task.labels)}`,
    `blocked_by: ${list(task.blockedBy)}`,
    `estimated_lines: ${String(task.estimatedLines)}`,
    `locks: ${list(task.locks)}`,
    `risk: ${task.risk}`,
    `stub: ${String(task.stub)}`,
    ...(task.stub && task.repaidBy !== null ? [`repaid_by: ${task.repaidBy}`] : []),
    '---',
    '',
    task.summary,
    '',
    '## Acceptance criteria',
    ...task.criteria.map(checkbox),
    ...(task.noFailurePath === null ? [] : [`- [ ] No failure path: ${task.noFailurePath}`]),
    `- [ ] ${LAST_CRITERION}`,
    ...section('Non-functional', task.nonFunctional),
    ...section('Test notes', task.testNotes),
    ...section('Human runbook', task.runbook),
  ];
  return `${lines.join('\n')}\n`;
}
