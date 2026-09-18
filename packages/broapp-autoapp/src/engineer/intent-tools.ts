/**
 * How the engineer writes a backlog: three small tools.
 *
 * `intent.open` writes down what a person asked and what the engineer makes of
 * it, `intent.task` adds one task in the plan format, and `intent.submit` says
 * the plan is finished. They are small on purpose: report 08b measured that one
 * large tool input stalls a local model, while hunks under a kilobyte land, and
 * a whole backlog in one call would be exactly the large input.
 *
 * The model proposes; the host decides. Whether the analysis names anything the
 * application really has, whether a plan is valid, which tier a task is and so
 * which model runs it, all of that is decided here and in `intent/`, never taken
 * from the model's arguments.
 *
 * A turn that planned does not also build. The tools remember which turns
 * opened or changed an intent, and the tools that edit or build refuse in those
 * turns, so the person reads the plan before any of it happens.
 */
import { existsSync } from 'node:fs';

import { guardedTool } from 'broapp/ai/host';
import type { GuardedTool } from 'broapp/ai/host';
import { publicError } from 'broapp/host';
import type { Envelope, Gate, HostLogger } from 'broapp/host';
import { s } from 'broapp/shared';

import {
  exampleIdFor,
  modelFor,
  readTierModels,
  type IntentRecord,
  type IntentStore,
  type Label,
  type PlanProblem,
  type Priority,
  type Reasoning,
  type Risk,
  type TaskInput,
  type TaskRecord,
} from '../intent/index.ts';
import type { Executor } from '../intent/executor.ts';
import { readCurrent, readRelease, type AppSpec, type Layout } from '../spec/index.ts';
import type { Component } from '../views/types.ts';

import { SPLIT_RULES } from './reference.ts';
import { parsed, runIdOf, type EngineerKnowledge } from './tools.ts';

/** What `intent.task` and `intent.submit` say while the analysis has open questions. */
export const QUESTIONS_REFUSAL =
  'This intent has open questions. Ask the person, then call intent.open again with their answers folded in and questions empty.';

/** What `intent.open` says when `fits` names nothing the application has. */
export const UNGROUNDED =
  '`fits` names nothing this application has. Read it with spec.read and say which routes or pages the request builds on.';

/** The prefix of every run id a backlog run gives a builder's turn. */
export const BUILDER_RUN_PREFIX = 'intent-';

/** Whether a turn is a builder's, started by a backlog run rather than by a person. */
export function isBuilderRun(runId: string | null): boolean {
  return runId !== null && runId.startsWith(BUILDER_RUN_PREFIX);
}

/** What a planning tool says to a builder. */
export const BUILDER_MAY_NOT_PLAN = 'A builder builds its one task. It does not plan or change the backlog.';

/**
 * Refuse a planning call from a builder's turn.
 *
 * A builder is given one task and a standing answer for edits and builds; a
 * builder that could rewrite the backlog it is part of could widen its own
 * task, or start another run.
 */
function builderRefused(envelope: Envelope | undefined, tool: string): void {
  // `conflict`, not `rejected`: the run loop reads a rejection as the person
  // saying no, and this is a rule the builder has to be told.
  if (isBuilderRun(runIdOf(envelope))) throw publicError.conflict(`${tool}: ${BUILDER_MAY_NOT_PLAN}`);
}

/** What a person agrees to by starting a run, said by the tool, the panel and the documents alike. */
export const RUN_AGREEMENT =
  'Until it finishes or is stopped, edits, builds and previews for its application are approved without asking. Anything else is put to you in the Backlog panel and waits. Activation is never approved this way.';

/** What {@link intentTools} needs. */
export interface IntentToolsOptions {
  readonly layout: Layout;
  /** The launcher's own gate. */
  readonly gate: Gate;
  readonly intents: IntentStore;
  /** The turn a run belongs to, and the log accepted calls are written to. */
  readonly knowledge?: Pick<EngineerKnowledge, 'log' | 'turn'>;
  readonly logger?: HostLogger;
  /** The backlog's executor. Absent, there is no `intent.start` and no `intent.ask`. */
  readonly executor?: Pick<Executor, 'start' | 'ask'>;
}

/** The three tools, and the turns that used them. */
export interface IntentTools {
  readonly tools: Record<string, GuardedTool>;
  /** Whether a turn opened or changed an intent. */
  planning(runId: string): boolean;
  /** A turn has ended: it plans no longer. */
  ended(runId: string): void;
}

/** Everything a specification names that an analysis may build on. */
function namesIn(spec: Pick<AppSpec, 'contract' | 'views'>): string[] {
  const names = new Set<string>([...Object.keys(spec.contract.operations), ...Object.keys(spec.contract.streams)]);
  const visit = (components: readonly Component[]): void => {
    for (const component of components) {
      names.add(component.id);
      if (component.children !== undefined) visit(component.children);
    }
  };
  for (const page of spec.views.pages) {
    names.add(page.id);
    visit(page.children);
  }
  return [...names];
}

/**
 * Whether a specification has nothing to build on: no route at all.
 *
 * That is what the blank template is — an empty contract and one page holding
 * one placeholder sentence — and a request against it builds on nothing
 * because there is nothing yet.
 */
export function isBlank(spec: Pick<AppSpec, 'contract'>): boolean {
  return Object.keys(spec.contract.operations).length === 0 && Object.keys(spec.contract.streams).length === 0;
}

/**
 * The route names, page ids and component ids that `fits` names, each as a
 * whole word.
 *
 * An identifier here may carry a hyphen, and a route a dot, so a word boundary
 * is any character that cannot continue one: `items` is not found inside
 * `items-table`, `list-items` or the route `items.list`, and `items.list` is
 * found at the end of a sentence, before its full stop.
 */
export function groundedIn(fits: string, spec: Pick<AppSpec, 'contract' | 'views'>): string[] {
  return namesIn(spec).filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])`).test(fits);
  });
}

/** The plan's field names, as the tool's input spells them. */
const INPUT_NAMES: Readonly<Record<string, string>> = {
  blocked_by: 'blockedBy',
  repaid_by: 'repaidBy',
  estimated_lines: 'estimatedLines',
  no_failure_path: 'noFailurePath',
  non_functional: 'nonFunctional',
  test_notes: 'testNotes',
};

/**
 * A problem as the model should read it: in the names it sent.
 *
 * The validator speaks the plan format's names, because that is what a person
 * reads in the panel; the tool takes camel case. A problem that names a field
 * the model did not send is one it cannot fix.
 */
function asInput(problem: PlanProblem): PlanProblem {
  let message = problem.message;
  for (const [plan, input] of Object.entries(INPUT_NAMES)) message = message.replaceAll(plan, input);
  return { field: INPUT_NAMES[problem.field] ?? problem.field, message };
}

const lines = (max: number, items: number) => s.array(s.string({ max }), { max: items });

const openInput = s.object({
  appId: s.string({ min: 1, max: 40 }),
  restated: s.string({ min: 20, max: 400 }),
  fits: s.string({ min: 20, max: 600 }),
  conflicts: lines(200, 5),
  outOfReach: lines(200, 5),
  assumptions: lines(200, 5),
  questions: lines(200, 3),
});

// The schema checks shapes and nothing the plan format decides. A title of the
// wrong length or a label outside the list is a plan problem, answered with
// `ok: false` and the field, so the model repairs it the way it repairs a failed
// build; a schema refusal would read to it as the tool failing.
export const INTENT_TASK_INPUT = s.object({
  intentId: s.number({ int: true, min: 1 }),
  words: s.string({ min: 1, max: 80 }),
  title: s.string({ max: 400 }),
  priority: s.string({ max: 20 }),
  labels: lines(40, 10),
  blockedBy: lines(80, 12),
  estimatedLines: s.number(),
  locks: s.optional(lines(200, 10)),
  risk: s.optional(s.string({ max: 20 })),
  stub: s.optional(s.boolean()),
  repaidBy: s.optional(s.string({ max: 80 })),
  summary: s.string({ max: 2_000 }),
  criteria: s.array(s.object({ text: s.string({ max: 1_000 }), failure: s.boolean() }), { max: 20 }),
  noFailurePath: s.optional(s.string({ max: 1_000 })),
  nonFunctional: s.optional(lines(1_000, 20)),
  testNotes: s.optional(lines(1_000, 20)),
  runbook: s.optional(lines(1_000, 20)),
  reasoning: s.string({ max: 20 }),
  replaces: s.optional(s.string({ max: 80 })),
});

const submitInput = s.object({ intentId: s.number({ int: true, min: 1 }) });

/**
 * An optional text the model sent empty, as absent.
 *
 * The by-hand run on 2026-09-18 watched a hosted model fill every optional
 * field it was shown, `replaces: ""` included, and be told that "" was not a
 * task. An empty string here never means anything but "none".
 */
function given(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === '' ? undefined : text;
}

/** What `intent.task` says to do after a task was stored. */
const NEXT_TASK = 'Add the next part with intent.task, or call intent.submit once every part is planned.';
/** What it says after a refusal it can repair. */
const FIX_FIELDS = 'Fix these fields and call intent.task again.';
/** What `intent.submit` says after the plan is in. */
const AFTER_SUBMIT =
  'Tell the person the plan is in the Backlog panel, in one or two sentences. Do not list the tasks in the chat. Do not start any of them.';

/** Build the three tools over a backlog. */
export function intentTools(options: IntentToolsOptions): IntentTools {
  const { layout: root, gate, intents: store } = options;
  const logger: HostLogger = options.logger ?? console;
  const knowledge = options.knowledge;

  /**
   * The turns that opened or changed an intent. Cleared when the turn ends,
   * so the person's next message can build what they approved.
   */
  const planningTurns = new Set<string>();
  const planned = (envelope: Envelope | undefined): void => {
    const runId = runIdOf(envelope);
    if (runId !== null) planningTurns.add(runId);
  };

  /** One knowledge event per accepted call. Never a reason for the call to fail. */
  const logged = (message: string, envelope: Envelope | undefined, appId: string): void => {
    if (knowledge === undefined) return;
    try {
      const runId = runIdOf(envelope);
      knowledge.log.event('log', message, undefined, { appId, ...(runId === null ? {} : { runId }) });
    } catch (cause) {
      logger.error(`[autoapp] could not record a backlog change: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  };

  /** The draft an intent tool may change, or a refusal naming why not. */
  const draft = (intentId: number, tool: string): IntentRecord => {
    const found = store.get(intentId);
    if (found === null) throw publicError.notFound(`There is no intent ${String(intentId)}.`);
    const intent = found.intent;
    if (intent.status !== 'draft') {
      throw publicError.conflict(
        `Intent ${String(intentId)} is ${intent.status}. ${tool} changes only a draft; a person decides what happens to it now.`,
      );
    }
    return intent;
  };
  const answered = (intent: IntentRecord): void => {
    if (intent.questions.length > 0) throw publicError.conflict(QUESTIONS_REFUSAL);
  };

  /** The model a task runs on, in words: an id, or the Settings model. */
  const modelOf = (task: TaskRecord): string => modelFor(task, readTierModels(store.dataDir)) ?? 'the model chosen in Settings';

  const tools: Record<string, GuardedTool> = {};

  // All three are `read`. A draft is the engineer's proposal written down, as a
  // transcript is: it changes no application and no release, nothing acts on
  // it, and it leaves `draft` only when a person on channel `user` moves it, or
  // a tool that asks the person does (13c). So the gate asks nobody about
  // writing one, and the person reads it in the Backlog panel instead. Each tool
  // refuses with `conflict` once the intent is anything but a draft.

  tools['intent.open'] = guardedTool(gate, {
    name: 'intent.open',
    description:
      'Write down a request with more than one part before building any of it: what you understood (restated), which routes, pages or components of the application it builds on, by name (fits), what it collides with (conflicts), what the rules put out of reach (outOfReach), what you are assuming, and what you must ask the person (questions). One application per intent; a request that spans two applications is two intents. Read the application with spec.read first. Calling it again for the same application replaces the analysis and keeps the tasks. With questions, ask them and stop.',
    inputSchema: openInput.toJsonSchema(),
    effect: 'read',
    run: (input, _signal, envelope) => {
      builderRefused(envelope, 'intent.open');
      const analysis = parsed(openInput, input);
      const { appId } = analysis;
      if (!existsSync(root.app(appId).dir)) {
        throw publicError.notFound(`There is no application ${appId}. apps.list names the ones there are.`);
      }
      const live = store.live(appId);
      if (live.some((intent) => intent.status === 'running')) {
        throw publicError.conflict(`${appId} has a backlog running. Wait for it to stop before planning another.`);
      }

      // What exists is read by the host, from the release that is serving: the
      // analysis has to be about the application as it is, not as the model
      // remembers it.
      const releaseId = readCurrent(root, appId);
      if (releaseId === null) {
        throw publicError.notFound(`${appId} has no release yet, so there is nothing to plan against. Build it first.`);
      }
      const spec = readRelease(root, appId, releaseId);
      if (!isBlank(spec) && groundedIn(analysis.fits, spec).length === 0) throw publicError.invalidInput(UNGROUNDED);

      // What the person typed, from the turn the tab recorded: never the model's
      // paraphrase of it.
      const runId = runIdOf(envelope);
      const turn = runId === null ? undefined : knowledge?.turn?.(runId);
      const fields = {
        restated: analysis.restated,
        fits: analysis.fits,
        conflicts: analysis.conflicts,
        outOfReach: analysis.outOfReach,
        assumptions: analysis.assumptions,
        questions: analysis.questions,
      };
      const existing = live.find((intent) => intent.status === 'draft');
      // One draft per application. A second call — usually the next turn, with
      // the person's answers folded in — rewrites the analysis of that draft
      // and keeps its tasks and the request it was opened with.
      const intent =
        existing === undefined
          ? store.createIntent({
              appId,
              request: turn?.message ?? analysis.restated,
              ...(runId === null ? {} : { proposedByRun: runId }),
              ...(turn?.model === null || turn?.model === undefined ? {} : { hubModel: turn.model.id }),
            })
          : existing;
      const stored = store.replaceAnalysis(intent.id, fields);
      planned(envelope);
      logged(`intent ${String(stored.id)} opened for ${appId}`, envelope, appId);

      const waiting = stored.questions.length > 0;
      return Promise.resolve({
        intentId: stored.id,
        status: 'draft',
        waitingForAnswers: waiting,
        ...(existing === undefined && turn === undefined
          ? { note: 'No record of the person’s message was found, so the restatement is stored as the request.' }
          : {}),
        next: waiting
          ? 'Ask the person these questions in the chat, then stop. Their answer starts a new turn: call intent.open again with it folded in and questions empty.'
          : 'Add each part with intent.task, then call intent.submit.',
      });
    },
  });

  tools['intent.task'] = guardedTool(gate, {
    name: 'intent.task',
    description: `Add one task to a draft intent, in the plan format. You give the slug's words, the title (imperative, 8 to 100 characters, no full stop), priority (high, medium, low), labels, blockedBy, estimatedLines, a summary of at most 400 characters, two to eight criteria and reasoning (low, medium, high); the host assigns the slug's number, the tier and the model. blockedBy and repaidBy name a task by its whole slug, such as 0001-add-tags, or by its words alone, such as add-tags; the host stores the whole slug. A task not added yet may be named, and is resolved at submit. A plan problem comes back as ok: false with each field named; fix those and call again. replaces: a slug, to rewrite a task still proposed.
What a good split is:
${SPLIT_RULES}`,
    inputSchema: INTENT_TASK_INPUT.toJsonSchema(),
    effect: 'read',
    run: (input, _signal, envelope) => {
      builderRefused(envelope, 'intent.task');
      const sent = parsed(INTENT_TASK_INPUT, input);
      // A stopped intent's failed task may be revised: that is one of the two
      // ways on from a stop. Anything else about a stopped intent is a person's.
      const found = store.get(sent.intentId);
      const revising =
        found?.intent.status === 'stopped' &&
        given(sent.replaces) !== undefined &&
        found.tasks.some((task) => task.slug === given(sent.replaces) && task.stored === 'failed');
      const intent = revising && found !== null ? found.intent : draft(sent.intentId, 'intent.task');
      answered(intent);

      // Plain strings until the validator has seen them: it is what says
      // whether `medium` is a priority, with the field named.
      const plan: TaskInput = {
        words: sent.words,
        title: sent.title,
        priority: sent.priority as Priority,
        labels: sent.labels as Label[],
        blockedBy: sent.blockedBy,
        estimatedLines: sent.estimatedLines,
        locks: sent.locks ?? [],
        risk: (sent.risk ?? 'normal') as Risk,
        stub: sent.stub ?? false,
        ...(given(sent.repaidBy) === undefined ? {} : { repaidBy: sent.repaidBy }),
        summary: sent.summary,
        criteria: sent.criteria,
        ...(given(sent.noFailurePath) === undefined ? {} : { noFailurePath: sent.noFailurePath }),
        ...(sent.nonFunctional === undefined ? {} : { nonFunctional: sent.nonFunctional }),
        ...(sent.testNotes === undefined ? {} : { testNotes: sent.testNotes }),
        ...(sent.runbook === undefined ? {} : { runbook: sent.runbook }),
        reasoning: sent.reasoning as Reasoning,
      };

      let replacing: TaskRecord | undefined;
      const replaces = given(sent.replaces);
      if (replaces !== undefined) {
        replacing = store.get(intent.id)?.tasks.find((task) => task.slug === replaces);
        if (replacing === undefined) {
          throw publicError.notFound(`${replaces} is not a task of intent ${String(intent.id)}.`);
        }
        if (replacing.stored !== 'proposed' && !(revising && replacing.stored === 'failed')) {
          throw publicError.conflict(
            `${replacing.slug} is ${replacing.stored}; only a proposed task, or a failed one in a stopped run, is rewritten.`,
          );
        }
      }

      const problems = store.planProblems(intent.id, plan, replacing?.id);
      if (problems.length > 0) {
        return Promise.resolve({ ok: false, problems: problems.map(asInput), next: FIX_FIELDS });
      }
      const task =
        replacing === undefined
          ? store.addTask(intent.id, plan, { deferReferences: true })
          : store.replaceTask(replacing.id, plan, { deferReferences: true });
      planned(envelope);
      logged(
        `task ${task.slug} ${replacing === undefined ? 'proposed' : 'rewritten'} (${task.tier})`,
        envelope,
        intent.appId,
      );
      return Promise.resolve({
        ok: true,
        slug: task.slug,
        tier: task.tier,
        tierReasons: task.tierReasons,
        model: modelOf(task),
        exampleIds: task.criteria.map((criterion) => exampleIdFor(task.slug, criterion.id)),
        next: NEXT_TASK,
      });
    },
  });

  tools['intent.submit'] = guardedTool(gate, {
    name: 'intent.submit',
    description:
      'Say the plan of a draft intent is finished. The host checks that every blockedBy and repaidBy names a task, that nothing waits on itself in a cycle, and that there is at least one task. Then stop: the person reads the plan in the Backlog panel.',
    inputSchema: submitInput.toJsonSchema(),
    effect: 'read',
    run: (input, _signal, envelope) => {
      builderRefused(envelope, 'intent.submit');
      const { intentId } = parsed(submitInput, input);
      const intent = draft(intentId, 'intent.submit');
      answered(intent);
      const problems = store.submit(intentId);
      if (problems.length > 0) {
        return Promise.resolve({
          ok: false,
          problems: problems.map(asInput),
          next: 'Fix these with intent.task (replaces rewrites a task), then call intent.submit again.',
        });
      }
      const tasks = store.runOrder(intentId).filter((task) => task.stored !== 'removed');
      planned(envelope);
      logged(`intent ${String(intentId)} submitted with ${String(tasks.length)} tasks`, envelope, intent.appId);
      return Promise.resolve({
        ok: true,
        tasks: tasks.map((task) => ({
          slug: task.slug,
          title: task.title,
          tier: task.tier,
          model: modelOf(task),
          blockedBy: task.blockedBy,
        })),
        next: AFTER_SUBMIT,
      });
    },
  });

  const executor = options.executor;
  if (executor !== undefined) {
    const startInput = s.object({ intentId: s.number({ int: true, min: 1 }) });
    tools['intent.start'] = guardedTool(gate, {
      name: 'intent.start',
      // What the person agrees to is in the question the gate puts to them,
      // which shows this tool and its input: so the description says it.
      description: `Start building a reviewed backlog. ${RUN_AGREEMENT} Call it when the person says to go ahead with a backlog they have reviewed.`,
      inputSchema: startInput.toJsonSchema(),
      // A write, so the gate asks: starting is the person's decision, and the
      // question is where they are told what it covers.
      effect: 'write',
      run: async (input, _signal, envelope) => {
        builderRefused(envelope, 'intent.start');
        const { intentId } = parsed(startInput, input);
        const runId = runIdOf(envelope);
        const started = await executor.start(intentId, runId === null ? 'the person' : `the person, in chat turn ${runId}`);
        const intent = store.get(intentId)?.intent;
        if (intent !== undefined) logged(`intent ${String(intentId)} started from the chat`, envelope, intent.appId);
        return {
          ...started,
          next: 'Tell the person it has started and that progress is in the Backlog panel. Do nothing else this turn.',
        };
      },
    });

    const askInput = s.object({ question: s.string({ min: 10, max: 300 }) });
    tools['intent.ask'] = guardedTool(gate, {
      name: 'intent.ask',
      description:
        'Only while building one task of a backlog run: ask the person one question, when the plan leaves open a real choice that changes what you build. The task waits for the answer and is run again with it. At most two per task.',
      inputSchema: askInput.toJsonSchema(),
      // A read: it changes no application and asks nobody. It records a
      // question for the person and ends the builder's turn.
      effect: 'read',
      run: (input, _signal, envelope) => {
        const { question } = parsed(askInput, input);
        const runId = runIdOf(envelope);
        if (!isBuilderRun(runId) || runId === null) {
          throw publicError.conflict('intent.ask is for a builder in a backlog run. Ask the person in the chat instead.');
        }
        return Promise.resolve(executor.ask(runId, question));
      },
    });
  }

  return {
    tools,
    planning: (runId) => planningTurns.has(runId),
    ended: (runId) => {
      planningTurns.delete(runId);
    },
  };
}

