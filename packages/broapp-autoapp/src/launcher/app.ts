/**
 * The launcher, as an application.
 *
 * One tab, one bridge, and the engineer in a side column. It is the only
 * process holding every application's launch URL, which is why opening an
 * application is a route here rather than something a person does with a
 * terminal — and why that route is the person's own click and never a tool.
 *
 * The launcher runs application code in exactly one place: nowhere. Building,
 * migrating, previewing and serving all happen in child processes. What this
 * file does is decide, record, and hand out addresses.
 */
import { createGate, createHostApp, openBrowser as openSystemBrowser, publicError } from 'broapp/host';
import type { Envelope, Gate, HostApp, HostLogger } from 'broapp/host';
import type { Bridge } from 'brobridge';

import { startPreview } from '../engineer/preview.ts';
import type { CandidateStates } from '../engineer/state.ts';
import type { RunStore } from '../host/run-store.ts';
import {
  externalRoutes,
  modelFor,
  readTierModels,
  renderPlan,
  routesNamedIn,
  writeTierModels,
  type Executor,
  type IntentStore,
  type TaskRecord,
} from '../intent/index.ts';
import { readPrices, writePrices } from '../intent/prices.ts';
import type { EventLog } from '../knowledge/log.ts';
import { confirmLesson, retireLesson, writeLesson } from '../knowledge/review.ts';
import type { Session } from '../knowledge/session.ts';
import type { Knowledge } from '../knowledge/store.ts';
import {
  knowledgeCase,
  knowledgeCases,
  knowledgeLesson,
  knowledgeLessons,
  knowledgeTurn,
  knowledgeTurns,
} from '../knowledge/window.ts';
import {
  listReleases,
  readCurrent,
  readGrants,
  readRelease,
  releasePageBytes,
  writeGrants,
  type Layout,
} from '../spec/index.ts';

import { activate } from './activate.ts';
import { appIds, listApps, serving as servingChild, workspaceOf } from './apps.ts';
import { launcherContract, type LauncherContract } from './contract.ts';
import { createApplication } from './create.ts';
import { createFolderChooser, type FolderChooserOptions } from './choose-folder.ts';
import { checkLocation, locateApplication } from './location.ts';
import { readOverview, supersededCandidate, type LiveUsage } from './overview.ts';
import type { Journal } from './journal.ts';
import { removeApplication } from './remove.ts';
import { addServing, removeServing } from './serving.ts';
import { clearStanding, readStanding, writeStanding, type Standing } from './standing.ts';
import { STANDING_WORDS } from './standing-words.ts';
import type { Templates } from './starter.ts';
import type { ChildHandle, Supervisor } from './supervisor.ts';
import type { PrepareOptions } from './workspace.ts';

/** What the launcher's host app needs. */
export interface CreateLauncherAppOptions {
  readonly layout: Layout;
  readonly supervisor: Supervisor;
  readonly journal: Journal;
  readonly states: CandidateStates;
  /** The launcher's own gate. `user` for the tab's clicks; the engineer shares it. */
  readonly gate: Gate;
  readonly logger?: HostLogger;
  /** Where a person's own preview starts and activations are written down. */
  readonly log?: EventLog;
  /** Where the application the person selected is remembered. */
  readonly session?: Session;
  /**
   * The knowledge store the Knowledge panel reads and a person's lesson
   * changes are written to. Absent, every knowledge route answers `unavailable`.
   */
  readonly knowledge?: Knowledge;
  /** The launcher's run store, for a turn's steps, duration and status. */
  readonly store?: RunStore;
  /**
   * The backlog the Backlog panel reads and a person's changes to it are
   * written to. Absent, every intent route answers `unavailable`.
   */
  readonly intents?: IntentStore;
  /**
   * The backlog's executor: `launcher.intentRun` and `intentStop` reach it,
   * `intentGet` reads its progress, and its `busy` refuses an activation while
   * a run works on the application. Absent, no backlog runs.
   */
  readonly executor?: Executor;
  /**
   * Open a URL in the person's browser. Defaults to the operating system's
   * opener; tests pass a stub so a suite does not open tabs.
   */
  readonly openBrowser?: (url: string) => Promise<boolean>;
  /** The starter workspaces this launcher carries, for `launcher.appCreate`. */
  readonly templates: Templates;
  /** The dependency ranges a created workspace is written with. */
  readonly versions: { readonly broapp: string; readonly autoapp: string };
  /** Creation's two spawns, injectable so a test reaches no registry and no git. */
  readonly install?: PrepareOptions['install'];
  readonly initGit?: PrepareOptions['initGit'];
  /**
   * The system's folder window, replaceable as `install` is, so a test opens
   * no window: its spawn, its platform and its deadline.
   */
  readonly folderChooser?: Omit<FolderChooserOptions, 'logger'>;
  /**
   * Begin the launcher's stop path, the one Ctrl+C takes. `launcher.quit`
   * calls it after its reply has gone. Absent, the route answers `unavailable`.
   */
  readonly quit?: () => void;
  /**
   * What each live turn has used so far, for `launcher.overview`. Absent, a
   * running turn's tokens are not in any total.
   */
  readonly live?: () => readonly LiveUsage[];
  /**
   * The ids of the providers this launcher has, so a usage row naming one
   * (`ollama:qwen3:27b`) is also priced by its bare model id.
   */
  readonly providerIds?: readonly string[];
}

/** How long `launcher.quit` waits after answering before the launcher begins to stop. */
export const QUIT_AFTER_MS = 250;

/** The launcher's routes, ready to mount. */
export interface LauncherApp {
  mount(bridge: Bridge): void;
  /**
   * Call one route as the bridge would, with the envelope given. For a test
   * that has to show a route refuses a channel no tab can send.
   */
  invoke(route: string, input: unknown, envelope: Envelope): Promise<unknown>;
  /** Applications this launcher has started. */
  readonly children: readonly ChildHandle[];
  /**
   * Close what the routes left open on the person's screen — a folder window
   * nobody answered. The launcher's shutdown calls it; nothing else needs to.
   */
  shutdown(): void;
}

/** How long a child gets to drain, and then to stop. */
const DRAIN_DEADLINE_MS = 10_000;
const STOP_DEADLINE_MS = 10_000;

/** Build the launcher's host app. */
export function createLauncherApp(options: CreateLauncherAppOptions): LauncherApp {
  const { layout: root, supervisor, journal, states, gate } = options;
  const logger: HostLogger = options.logger ?? console;

  // An ordinary host app: `launcher` is not a reserved group, because nothing
  // else is ever mounted on this bridge but the AI layer, which owns `ai`.
  const host: HostApp<LauncherContract> = createHostApp<LauncherContract>(launcherContract, {
    gate,
    logger,
  });

  /** The live child serving one application, if any. */
  const serving = (appId: string): ChildHandle | null => servingChild(supervisor, appId);

  const openBrowser = options.openBrowser ?? openSystemBrowser;

  /**
   * Open a child's tab from the host, never from the launcher's page. A
   * `window.open` from the launcher's origin to the child's arrives with
   * `Sec-Fetch-Site: same-site`, which Brobridge's fence refuses; a tab the
   * operating system opens arrives with `none`. When no browser can be
   * opened, the address goes to the launcher's terminal — the same place
   * `serve` prints it — and the tab is told so.
   *
   * Every open gets an address of its own, minted by the child for this
   * click. The bare origin used to serve the second open, riding on the
   * session cookie the first had minted — but the panel, a preview and every
   * other application on this host set the same cookie, and a browser keeps
   * one per host, so whichever bootstrapped last owned it and every other
   * tab's reload or reopen was refused. A fresh token needs no cookie.
   */
  async function openTab(child: ChildHandle): Promise<{ opened: boolean }> {
    const url = await child.launchUrl();
    const opened = await openBrowser(url);
    if (!opened) {
      // The one line that must reach the terminal whole: the event log
      // sanitises what it prints, and the token is the query it would take.
      const line = `could not open a browser; open this address yourself: ${url}`;
      if (options.log === undefined) logger.warn(line);
      else options.log.announce(line);
    }
    return { opened };
  }

  // The same rows the engineer's `apps.list` gets, from the same helper.
  host.operation('launcher.appsList', () => {
    const apps = listApps(root, supervisor, journal).map((row) => ({
      ...row,
      workspace: { ...(row.workspace ?? workspaceOf(root, row.appId)) },
    }));
    const chosen = options.session?.get().selectedAppId ?? null;
    return { apps, selected: chosen !== null && apps.some((row) => row.appId === chosen) ? chosen : null };
  });

  /**
   * Start an application if it is not running, and open its tab.
   *
   * One function rather than two: `appOpen` is a person clicking Open, and
   * `appCreate` ends by doing exactly the same thing to the application it has
   * just made. A copy of this that drifted would be a copy that started a child
   * the other one would not.
   */
  async function openApplication(appId: string): Promise<{ opened: boolean }> {
    const existing = serving(appId);
    if (existing !== null) {
      addServing(root, appId);
      return await openTab(existing);
    }
    const releaseId = readCurrent(root, appId);
    if (releaseId === null) throw publicError.notFound(`${appId} has no current release yet.`);
    const app = root.app(appId);
    const child = await supervisor.start({
      appId,
      releaseDir: app.release(releaseId),
      releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    // Written down so a restarted launcher serves it again.
    addServing(root, appId);
    // Opened from here. The address is never returned to the tab, never
    // written down, never given to a model.
    return await openTab(child);
  }

  host.operation('launcher.appCreate', async ({ appId, name, description, template, location }) => {
    const created = await createApplication({
      layout: root,
      templates: options.templates,
      ...(template === undefined ? {} : { template }),
      ...(location === undefined ? {} : { location }),
      versions: options.versions,
      appId,
      name,
      ...(description === undefined ? {} : { description }),
      logger,
      ...(options.install === undefined ? {} : { install: options.install }),
      ...(options.initGit === undefined ? {} : { initGit: options.initGit }),
    });
    if (!created.ok) {
      return {
        ok: false,
        releaseId: null,
        installed: created.installed,
        problems: created.problems.map((problem) => ({ ...problem })),
        notes: [...created.notes],
        opened: false,
      };
    }
    const { opened } = await openApplication(appId);
    return {
      ok: true,
      releaseId: created.releaseId,
      installed: created.installed,
      problems: [],
      notes: [...created.notes],
      opened,
    };
  });

  host.operation('launcher.appOpen', async ({ appId }) => await openApplication(appId));

  // The form's question before Create is pressed: the same checks creation
  // makes, so the answer here and the refusal there cannot disagree. It
  // writes nothing and takes no lock, so its "yes" is a prediction, and
  // creation checks again.
  host.operation('launcher.locationCheck', ({ appId, location }) => {
    const checked = checkLocation(root, appId, location);
    return checked.ok
      ? { ok: true, target: checked.target, problem: null }
      : { ok: false, target: null, problem: checked.problem };
  });

  // A person saying where a moved workspace went. No engineer tool reaches
  // this: where a person's files are is theirs to say.
  host.operation('launcher.appLocate', ({ appId, sourceDir }) => locateApplication(root, appId, sourceDir));

  // The system's folder window, for the form and for Locate. What it answers
  // is a string like any typed one: the form checks it with `locationCheck`,
  // and creation and `appLocate` check it again.
  const folders = createFolderChooser({ ...options.folderChooser, logger });
  host.operation('launcher.folderChoose', async ({ startAt }) => await folders.choose(startAt));

  /**
   * Move an application to the trash.
   *
   * The confirmation is checked here rather than in `removeApplication`,
   * because it is about how this request reached the host: somebody typed the
   * id into a field beside a list of what would go. The command line asks its
   * own way, with `--yes`, and neither of them is a rule the removal itself
   * should be carrying.
   */
  host.operation('launcher.appRemove', async ({ appId, confirm }) => {
    if (confirm !== appId) {
      throw publicError.invalidInput(
        `Type ${appId} to confirm. Nothing has been removed.`,
      );
    }
    return await removeApplication(
      {
        layout: root,
        supervisor,
        states,
        journal,
        ...(options.session === undefined ? {} : { session: options.session }),
        ...(options.log === undefined ? {} : { log: options.log }),
        logger,
      },
      appId,
    );
  });

  host.operation('launcher.eventsList', (filter) => {
    const log = options.log;
    if (log === undefined) throw publicError.unavailable('This launcher keeps no log.');
    return {
      events: [...log.recent({
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        ...(filter.level === undefined ? {} : { level: filter.level }),
        ...(filter.appId === undefined ? {} : { appId: filter.appId }),
        ...(filter.before === undefined ? {} : { before: filter.before }),
      })],
      dropped: log.stats().dropped,
    };
  });

  /**
   * The knowledge store, or the refusal every knowledge route gives without one.
   *
   * Reads here write nothing. The three writes write what `knowledge confirm`
   * and `knowledge retire` write, from the same functions, and one event each
   * saying who did it; the serve layer reads lessons from the database at every
   * turn, so the next turn is served the change.
   */
  function store(): Knowledge {
    if (options.knowledge === undefined) throw publicError.unavailable('This launcher keeps no knowledge store.');
    return options.knowledge;
  }

  host.operation('launcher.knowledgeTurns', (filter) => ({
    turns: knowledgeTurns(store(), filter, options.store).map((turn) => ({
      ...turn,
      words: [...turn.words],
      documents: turn.documents.map((document) => ({ ...document })),
      servings: turn.servings.map((serving) => ({ ...serving })),
    })),
  }));

  host.operation('launcher.knowledgeTurn', ({ runId }) => {
    const turn = knowledgeTurn(store(), runId, options.store);
    if (turn === null) throw publicError.notFound(`There is no recorded turn ${runId}.`);
    return {
      turn: {
        ...turn,
        words: [...turn.words],
        documents: turn.documents.map((document) => ({ ...document })),
        servings: turn.servings.map((serving) => ({ ...serving })),
        texts: turn.texts.map((entry) => ({ ...entry })),
      },
    };
  });

  host.operation('launcher.knowledgeLessons', (filter) => ({ lessons: knowledgeLessons(store(), filter) }));

  host.operation('launcher.knowledgeLesson', ({ id }) => {
    const found = knowledgeLesson(store(), id);
    if (found === null) throw publicError.notFound(`There is no lesson ${String(id)}.`);
    return {
      ...found,
      // The newest five hundred: a lesson served for months has more, and the
      // command line's `show` still prints every one.
      lesson: { ...found.lesson, servings: found.lesson.servings.slice(-500).map((serving) => ({ ...serving })) },
    };
  });

  host.operation('launcher.knowledgeCases', (filter) => ({ cases: knowledgeCases(store(), filter) }));

  host.operation('launcher.knowledgeCase', ({ id }) => {
    const found = knowledgeCase(store(), id);
    if (found === null) throw publicError.notFound(`There is no case ${String(id)}.`);
    return { case: found };
  });

  host.operation('launcher.lessonReview', ({ id, decision, by }) => {
    const knowledge = store();
    const changed = decision === 'confirm' ? confirmLesson(knowledge, id, by) : retireLesson(knowledge, id, by);
    const status = knowledge.db.query<{ status: string }, [number]>('SELECT status FROM lessons WHERE id = ?').get(id)?.status;
    if (status === undefined) throw publicError.notFound(`There is no lesson ${String(id)}.`);
    if (changed) {
      options.log?.event('log', `lesson ${String(id)} ${decision === 'confirm' ? 'confirmed' : 'retired'} by ${by}`);
    }
    return { changed, status };
  });

  host.operation('launcher.lessonWrite', ({ by, stage, routes, files, supersedes, ...fields }) => {
    const id = writeLesson(
      store(),
      {
        ...fields,
        applies: {
          ...(stage === undefined ? {} : { stage }),
          ...(routes === undefined ? {} : { routes }),
          ...(files === undefined ? {} : { files }),
        },
        ...(supersedes === undefined ? {} : { supersedes }),
      },
      by,
    );
    options.log?.event(
      'log',
      supersedes === undefined
        ? `lesson ${String(id)} written by ${by}`
        : `lesson ${String(id)} written by ${by}, superseding lesson ${String(supersedes)}`,
    );
    return { id };
  });

  /**
   * The backlog, or the refusal every intent route gives without one.
   *
   * The writes are a person's: each is refused off channel `user`, so a
   * request that reached this bridge some other way changes nothing even if
   * somebody approved it. No engineer tool names any of them.
   */
  function intents(): IntentStore {
    if (options.intents === undefined) throw publicError.unavailable('This launcher keeps no backlog.');
    return options.intents;
  }

  function byPerson(context: { readonly channel: string }): IntentStore {
    const store = intents();
    if (context.channel !== 'user') throw publicError.rejected('Only a person changes the backlog, from the Backlog panel.');
    return store;
  }

  host.operation('launcher.intentsList', ({ appId, limit }) => ({
    intents: intents()
      .list({ ...(appId === undefined ? {} : { appId }), ...(limit === undefined ? {} : { limit }) })
      .map((intent) => ({ ...intent, counts: { ...intent.counts } })),
  }));

  host.operation('launcher.intentGet', ({ id }) => {
    const store = intents();
    const found = store.get(id);
    if (found === null) throw publicError.notFound(`There is no intent ${String(id)}.`);
    const mapping = readTierModels(store.dataDir);
    // Every array copied: the route's output type is mutable, the record's is not.
    const copy = (task: TaskRecord) => ({
      ...task,
      labels: [...task.labels],
      blockedBy: [...task.blockedBy],
      locks: [...task.locks],
      criteria: task.criteria.map((criterion) => ({ ...criterion })),
      nonFunctional: [...task.nonFunctional],
      testNotes: [...task.testNotes],
      runbook: [...task.runbook],
      tierReasons: [...task.tierReasons],
      waitingOn: [...task.waitingOn],
      runIds: [...task.runIds],
      answers: task.answers.map((answer) => ({ ...answer })),
    });
    const progress = options.executor?.progress(id) ?? { run: null, question: null };
    // Which of a task's runbook lines name a route a preview refuses, by the
    // release the task completed at, else the serving one. Read once per
    // release: an intent's tasks mostly share one.
    const external = new Map<string, string[]>();
    const externalIn = (releaseId: string | null): string[] => {
      const id = releaseId ?? readCurrent(root, found.intent.appId);
      if (id === null) return [];
      let routes = external.get(id);
      if (routes === undefined) {
        try {
          routes = externalRoutes(readRelease(root, found.intent.appId, id).contract);
        } catch {
          routes = [];
        }
        external.set(id, routes);
      }
      return routes;
    };
    const afterActivating = (task: TaskRecord): number[] => {
      const routes = externalIn(task.releaseId);
      return task.runbook.flatMap((line, index) => (routesNamedIn(line, routes).length > 0 ? [index] : []));
    };
    return {
      run:
        progress.run === null
          ? null
          : { ...progress.run, question: progress.question === null ? null : { ...progress.question } },
      intent: {
        ...found.intent,
        conflicts: [...found.intent.conflicts],
        outOfReach: [...found.intent.outOfReach],
        assumptions: [...found.intent.assumptions],
        questions: [...found.intent.questions],
      },
      tasks: found.tasks.map((task) => ({
        ...copy(task),
        model: modelFor(task, mapping),
        afterActivating: afterActivating(task),
        events: task.events.map((event) => ({ ...event })),
      })),
    };
  });

  /** The executor, or the refusal every run route gives without one. */
  function executor(): Executor {
    if (options.executor === undefined) throw publicError.unavailable('This launcher runs no backlog.');
    return options.executor;
  }

  host.operation('launcher.intentRunning', () => {
    const active = options.executor?.active() ?? null;
    if (active === null) return { run: null };
    return { run: { ...active, waiting: executor().progress(active.intentId).question !== null } };
  });

  // The person's own click, after the panel's confirmation said what the run
  // answers for them. `intent.start` reaches the same function from the chat.
  host.operation('launcher.intentRun', async ({ id }, context) => {
    byPerson(context);
    return await executor().start(id, 'the person, from the Backlog panel');
  });

  host.operation('launcher.intentStop', ({ id }, context) => {
    byPerson(context);
    return executor().stop(id, 'the person');
  });

  host.operation('launcher.intentAnswer', ({ taskId, answer, by }, context) => {
    const store = byPerson(context);
    const task = store.answer(taskId, answer, by);
    options.log?.event('log', `task ${task.slug}: answered by ${by}`, undefined, { appId: task.appId });
    return { status: task.stored };
  });

  host.operation('launcher.intentPlan', ({ taskId }) => {
    const task = intents().task(taskId);
    if (task === null) throw publicError.notFound(`There is no task ${String(taskId)}.`);
    return { markdown: renderPlan(task) };
  });

  host.operation('launcher.intentModelsGet', () => ({ ...readTierModels(intents().dataDir) }));

  host.operation('launcher.intentTaskModel', ({ taskId, modelId }, context) => {
    const store = byPerson(context);
    const task = store.setModel(taskId, modelId);
    return { model: modelFor(task, readTierModels(store.dataDir)) };
  });

  host.operation('launcher.intentTaskRemove', ({ taskId }, context) => ({
    status: byPerson(context).removeTask(taskId).stored,
  }));

  host.operation('launcher.intentWithdraw', ({ id }, context) => ({ status: byPerson(context).withdraw(id).status }));

  /**
   * One read for the person who has just come back: what needs them, the run
   * and its stage, spend, what is left, the applications. It starts nothing
   * and writes nothing.
   */
  host.operation('launcher.overview', () => {
    const overview = readOverview({
      layout: root,
      supervisor,
      journal,
      states,
      ...(options.intents === undefined ? {} : { intents: options.intents }),
      ...(options.executor === undefined ? {} : { executor: options.executor }),
      ...(options.live === undefined ? {} : { live: options.live }),
      ...(options.providerIds === undefined ? {} : { providerIds: options.providerIds }),
      ...(options.intents === undefined
        ? {}
        : { modelOf: (task: TaskRecord) => modelFor(task, readTierModels((options.intents as IntentStore).dataDir)) }),
    });
    // Every array and record copied: the route's output type is mutable.
    return {
      needsYou: overview.needsYou.map((item) => ({ ...item, target: { ...item.target } })),
      running:
        overview.running === null
          ? null
          : {
              ...overview.running,
              criteria: { ...overview.running.criteria },
              lastRefusal: overview.running.lastRefusal === null ? null : { ...overview.running.lastRefusal },
              tokens: { ...overview.running.tokens },
            },
      spend: {
        task: overview.spend.task === null ? null : { ...overview.spend.task },
        run: overview.spend.run === null ? null : { ...overview.spend.run },
        today: { ...overview.spend.today },
        budgetDay: overview.spend.budgetDay,
        todayByModel: overview.spend.todayByModel.map((part) => ({ ...part })),
      },
      backlog: overview.backlog.map((block) => ({
        ...block,
        intentIds: [...block.intentIds],
        estimate: block.estimate === null ? null : { ...block.estimate },
      })),
      apps: overview.apps.map((app) => ({ ...app, checks: app.checks === null ? null : { ...app.checks } })),
      recent: overview.recent.map((event) => ({ ...event })),
      // Said only when it is on: a launcher nobody turned it on in answers
      // exactly what it answered before the switch existed.
      ...(overview.standing ? { standing: true } : {}),
    };
  });

  /** What each model costs, as the person wrote it, and the day's budget. */
  host.operation('launcher.pricesGet', () => {
    const prices = readPrices(intents().dataDir);
    return {
      models: Object.entries(prices.models).map(([modelId, price]) => ({ modelId, input: price.input, output: price.output })),
      budgetDay: prices.budgetDay,
    };
  });

  // A person's prices and nobody else's: a model has no business saying what
  // it costs, and the route refuses every channel but `user` as the backlog's do.
  host.operation('launcher.pricesSet', ({ models, budgetDay }, context) => {
    const store = intents();
    if (context.channel !== 'user') throw publicError.rejected('Only a person sets prices, from the launcher.');
    const prices = writePrices(store.dataDir, models, budgetDay);
    options.log?.event('log', `prices set for ${String(Object.keys(prices.models).length)} model(s) by the person`);
    return {
      models: Object.entries(prices.models).map(([modelId, price]) => ({ modelId, input: price.input, output: price.output })),
      budgetDay: prices.budgetDay,
    };
  });

  /** Whether the engineer works without asking, read from the file as it stands. */
  host.operation('launcher.standingGet', () => ({ ...readStanding(root, logger) }));

  // The person's switch and nobody else's. Settings, the card's third button
  // and the command line are all a person; a model reaching this route on any
  // other channel would be asking to be trusted, and that is not its to ask.
  host.operation('launcher.standingSet', ({ standing }, context) => {
    if (context.channel !== 'user') throw publicError.rejected(STANDING_WORDS.onlyAPerson);
    let now: Standing;
    try {
      now = standing ? writeStanding(root) : clearStanding(root);
    } catch (cause) {
      throw publicError.unavailable(STANDING_WORDS.notSaved(String(cause instanceof Error ? cause.message : cause)));
    }
    options.log?.event('log', STANDING_WORDS.turned(now.standing));
    return { ...now };
  });

  host.operation('launcher.intentModelsSet', (models, context) => {
    const store = byPerson(context);
    writeTierModels(store.dataDir, models);
    return { ...readTierModels(store.dataDir) };
  });

  host.operation('launcher.appSelect', ({ appId }) => {
    if (!appIds(root).includes(appId)) throw publicError.notFound(`There is no application called ${appId}.`);
    options.session?.select(appId);
    return { ok: true };
  });

  host.operation('launcher.appStop', async ({ appId }) => {
    // A person stopped it: a restarted launcher should not start it again.
    removeServing(root, appId);
    const child = serving(appId);
    if (child === null) return { stopped: false };
    await child.drain(DRAIN_DEADLINE_MS);
    await child.shutdown(STOP_DEADLINE_MS);
    return { stopped: true };
  });

  host.operation('launcher.releasesList', ({ appId }) => {
    const current = readCurrent(root, appId);
    return {
      releases: listReleases(root, appId).map((release) => ({
        releaseId: release.releaseId,
        createdAt: release.createdAt,
        schemaVersion: readRelease(root, appId, release.releaseId).manifest.schemaVersion,
        current: release.releaseId === current,
      })),
    };
  });

  host.operation('launcher.journalList', ({ appId }) => ({
    activations: journal.history(appId, 100).map((row) => ({
      id: row.id,
      fromRelease: row.fromRelease,
      toRelease: row.toRelease,
      phase: row.phase,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      error: row.error,
    })),
  }));

  host.operation('launcher.grantsGet', ({ appId }) => {
    const releaseId = readCurrent(root, appId);
    const grants = readGrants(root, appId);
    // What the *candidate* asks for when there is one, because that is what a
    // person is being asked to decide about.
    const candidateId = states.get(appId).releaseId ?? releaseId;
    const requested =
      candidateId === null ? [] : readRelease(root, appId, candidateId).manifest.capabilities;
    return {
      releaseId: candidateId,
      granted: [...(grants?.capabilities ?? [])],
      requested: [...requested],
    };
  });

  host.operation('launcher.grantsSet', ({ appId, releaseId, capabilities }) => {
    // The release the person was shown has to still be the one being asked
    // about. If a new candidate has been built since, the list they read is not
    // the list they would be granting.
    const shown = states.get(appId).releaseId ?? readCurrent(root, appId);
    if (shown !== releaseId) {
      throw publicError.conflict(
        'What this application asks for has changed since you were shown it. Look again before granting.',
      );
    }
    writeGrants(root, appId, {
      appId,
      releaseId,
      grantedAt: Date.now(),
      capabilities,
    });
    return { ok: true };
  });

  host.operation('launcher.candidateStatus', ({ appId }) => {
    const status = states.status(appId);
    const current = readCurrent(root, appId);
    return {
      pageBytes: status.releaseId === null ? null : releasePageBytes(root, appId, status.releaseId),
      pageBytesBefore: current === null ? null : releasePageBytes(root, appId, current),
      appId: status.appId,
      releaseId: status.releaseId,
      problems: [...status.problems],
      changed: [...status.changed],
      previewRunning: status.previewRunning,
      checks: status.checks.map((check) => ({ ...check })),
      addedCapabilities: [...status.addedCapabilities],
      removedCapabilities: [...status.removedCapabilities],
      editsSinceBuild: status.editsSinceBuild,
      previewLost: status.previewLost,
      checksVerified: status.checksVerified,
      stagesRun: [...status.stagesRun],
      superseded: supersededCandidate(journal.history(appId), status.releaseId, current),
    };
  });

  host.operation('launcher.previewStart', async ({ appId }, context) => {
    const releaseId = states.get(appId).releaseId;
    if (releaseId === null) {
      throw publicError.unavailable('Nothing has been built for this application, so there is no preview to start.');
    }
    // Exactly what the engineer's `candidate.preview` runs. A click is its own
    // run, so its request identifier is both the run and the call.
    await startPreview(
      { layout: root, supervisor, states, ...(options.log === undefined ? {} : { log: options.log }) },
      appId,
      releaseId,
      { runId: context.requestId, callId: context.requestId },
    );
    return { previewRunning: states.get(appId).preview !== null };
  });

  host.operation('launcher.previewOpen', async ({ appId }) => {
    const preview = states.get(appId).preview;
    if (preview === null) {
      throw publicError.unavailable('There is no preview running for this application.');
    }
    return await openTab(preview);
  });

  host.operation('launcher.activate', async ({ appId, releaseId }, context) => {
    // Not while a backlog run is building on it: the candidate is moving
    // under the person's feet, and activation is theirs to decide once it stops.
    const busy = options.executor?.busy(appId, null) ?? null;
    if (busy !== null) throw publicError.conflict(busy);
    // The same function the engineer's tool reaches. What differs is the channel
    // the request arrived on, which the journal's run record already carries.
    const preview = states.get(appId).preview;
    if (preview !== null) await preview.shutdown(STOP_DEADLINE_MS);
    states.update(appId, { preview: null, previewWasRunning: false });
    const result = await activate({ layout: root, supervisor, journal, appId, releaseId, logger });
    options.log?.event(
      'activate',
      result.ok ? 'the release was activated' : 'the activation did not complete',
      result.ok
        ? { ok: true, releaseId }
        : { ok: false, phase: result.phase, reason: result.reason, recovered: result.recovered, releaseId },
      { runId: context.requestId, callId: context.requestId, appId, releaseId },
    );
    if (!result.ok) return { ok: false, phase: result.phase, reason: result.reason };
    // The new release is a new child on a new port with a new credential, so
    // the tab that showed the old one cannot be reloaded into it. Open the new
    // one, the way a click on Open would.
    const child = serving(appId);
    const opened = child === null ? false : (await openTab(child)).opened;
    return { ok: true, previousRelease: result.previousRelease, opened };
  });

  // The panel's Quit. The reply goes first: the stop closes this bridge, and a
  // person pressing Quit is told the launcher stopped, not that a call failed.
  host.operation('launcher.quit', (_input, context) => {
    if (context.channel !== 'user') throw publicError.rejected('Only a person stops the launcher, from its panel.');
    const quit = options.quit;
    if (quit === undefined) throw publicError.unavailable('This launcher cannot be stopped from its panel.');
    options.log?.event('log', 'the person pressed Quit in the panel');
    setTimeout(quit, QUIT_AFTER_MS);
    return { stopping: true };
  });

  return {
    mount: (bridge: Bridge) => host.mount(bridge),
    invoke: (route, input, envelope) => host.invoke(route as never, input as never, envelope),
    get children() {
      return supervisor.children;
    },
    shutdown: () => folders.stop(),
  };
}

/**
 * How long one of the launcher's questions waits: ten minutes.
 *
 * Not the gate's own two minutes, which is right for an application: a
 * question there comes from a person's own workflow run or an MCP call they
 * are watching. The engineer's questions do not. Report 08b measured a local
 * model spending seven to fourteen minutes composing a single `source.edit`
 * and then handing the person two minutes to answer it; two of six attempts
 * were lost to that arithmetic rather than to anything either of them did.
 */
export const LAUNCHER_CONFIRM_TIMEOUT_MS = 600_000;

/**
 * How many model steps one engineer turn may take: forty.
 *
 * Not the AI layer's eight, which is right for an assistant answering a
 * question about its application. The engineer's loop is read, edit, build,
 * preview, check and explain, and eight steps do not hold it. Report 12b's
 * rerun of the 08c request ended after sixteen tool calls in exactly eight
 * model steps, with two edits landed, no closing text and no build — the cap,
 * not the model, ended the turn. 08c's turn (eighteen calls, ending right after
 * an edit) fits the same cap.
 */
export const LAUNCHER_MAX_STEPS = 40;

/** The launcher's own gate: its tab's clicks and its engineer's tools. */
export function createLauncherGate(options: {
  releaseId: string;
  recorder?: Parameters<typeof createGate>[0]['recorder'];
  confirmTimeoutMs?: number;
  logger?: HostLogger;
}): Gate {
  return createGate({
    appId: 'launcher',
    releaseId: options.releaseId,
    confirmTimeoutMs: options.confirmTimeoutMs ?? LAUNCHER_CONFIRM_TIMEOUT_MS,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
