/**
 * The AI layer's host runtime.
 *
 * `createAi(...)` builds a second `HostApp` — over Broapp's own AI contract —
 * that an application mounts on the same bridge as its own. Keeping them
 * separate means an application's route table never grows Broapp's routes, and
 * an application that does not call `createAi` carries none of this.
 *
 * Chat arrives in the next layer up; the routes are registered here so that
 * `mount` has an implementation for every route in the contract, which it
 * insists on.
 */
import type { LanguageModel } from 'ai';
import type { Bridge } from 'brobridge';

// Imported from the host entry point rather than from `host/app.ts` directly:
// the AI layer is part of the host runtime, and depending on that entry point
// is what makes a browser bundle of `broapp/ai/host` fail to build. Bun's
// browser target polyfills `node:fs`, so the file stores alone would not stop
// this code from being bundled into a page.
import { createPendingApprovals, createReservedHostApp } from '../../host/index.ts';
import type { HostApp, HostLogger, StreamSink } from '../../host/app.ts';
import { isPublicError, publicError, type PublicError } from '../../shared/errors.ts';
import { aiContract, type AiContract } from '../shared/contract.ts';
import { formatModelRef } from '../shared/model-ref.ts';
import type { AiSettings, BroappModel, ChatTurn, ProviderInfo, UnavailableProvider } from '../shared/types.ts';

import { AdapterError, type AdapterConfig, type ProviderAdapter } from './adapter.ts';
import { createModelLists } from './model-lists.ts';
import { createRegistry, type Registry } from './registry.ts';
import { runChat, type RunDeps } from './run.ts';
import type { ChatEvent } from './run-types.ts';
import { apiKeySecretName, createFileSecretStore, createMemorySecretStore } from './secrets.ts';
import { createSettingsStore } from './settings.ts';
import { openThreads, type ThreadStore } from './threads.ts';
import { GUARDED, type AiContextProviders, type AiTool, type ContextDocument } from './tool.ts';

/** How a turn went, beyond whether it ended well. */
export interface RunEndDetail {
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Tool round trips the turn made. */
  readonly steps: number;
  readonly ms: number;
  /** The model the turn was sent to; absent when the turn ended before one was resolved. */
  readonly modelId?: string;
}

/**
 * What one turn was given, after the budget. Documents are exactly what the
 * model saw.
 *
 * Reported before the model is called, so a listener can write down the turn's
 * inputs with the identity they had then rather than reconstruct them later
 * from settings that may since have changed.
 */
export interface DeliveredContext {
  readonly system: string;
  readonly documents: readonly ContextDocument[];
  /** The person's message for this turn, which the system prompt does not carry. */
  readonly message: string;
  /** The provider and model the turn was sent to. */
  readonly model: { readonly provider: string; readonly id: string };
}

/** One turn run in-process by {@link Ai.turn}. */
export interface InProcessTurn {
  readonly runId: string;
  readonly message: string;
  /** The model for this turn: a model reference, bare or naming an enabled provider. */
  readonly modelId?: string;
  /**
   * Earlier turns, as a browser would send them. An assistant turn naming a
   * run this layer kept a transcript for is expanded exactly as on `ai.chat`.
   */
  readonly history?: readonly ChatTurn[];
}

/** One question put to an in-process turn's stand-in. */
export interface InProcessQuestion {
  readonly tool: string;
  readonly input: unknown;
  /** The approval table's key, `<runId>:<callId>`. */
  readonly requestId: string;
  /** The call the question is about, as `ai.chatConfirm` names it with the run id. */
  readonly callId: string;
  /** When the question stops waiting, when the gate said. */
  readonly expiresAt?: number;
}

/** How {@link Ai.turn} is answered and stopped. */
export interface InProcessTurnOptions {
  /**
   * The answer to each question the gate asks during the turn.
   *
   * The caller is the person's stand-in, so it decides exactly as the person
   * would have: the gate still asks, and still records the answer.
   *
   * `'defer'` answers nothing. The question stays in the approval table for
   * somebody else to answer by its request id, over `ai.chatConfirm` as a
   * person in a chat would, and the gate's own window still ends it. That is
   * for a stand-in that answers some questions itself and brings the rest to a
   * person: whoever answers, each question is answered once.
   */
  readonly answer: (question: InProcessQuestion) => boolean | 'defer';
  /** Aborting it cancels the turn, as a browser's cancel would. */
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ChatEvent) => void;
}

/** How an in-process turn ended, and everything it emitted. */
export interface InProcessTurnResult {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly events: readonly ChatEvent[];
  /** The reason a turn that could not start gave, such as no provider being set up. */
  readonly error?: string;
}

/** What the application is, in the words a model is given. */
export interface AiAppDescription {
  readonly name: string;
  readonly purpose: string;
  readonly terminology?: readonly string[];
  /**
   * Extra standing instructions, appended verbatim after the purpose.
   *
   * For an assistant whose job needs more than a sentence to describe — the
   * shape of a workspace it edits, a sequence it has to follow, things it may
   * not do. It is host-authored text, not anything a browser or a model
   * supplied, and it goes in front of the documents rather than among them.
   */
  readonly instructions?: string;
}

/** Options for {@link createAi}. */
export interface CreateAiOptions {
  readonly dataDir: string;
  readonly providers: readonly ProviderAdapter[];
  readonly app: AiAppDescription;
  /** Defaults to `globalThis.fetch`. Tests inject a fake. */
  readonly fetch?: typeof fetch;
  readonly logger?: HostLogger;
  readonly context?: AiContextProviders;
  readonly tools?: Record<string, AiTool>;
  /** Character budget for context documents in one turn. Default 40_000. */
  readonly contextBudgetChars?: number;
  /** Max model steps (tool round trips) per turn. Default 8. */
  readonly maxSteps?: number;
  /** How long a `confirm` tool waits for the user. Default 300_000 ms. */
  readonly confirmTimeoutMs?: number;
  /**
   * Called once when a chat turn ends, however it ends.
   *
   * Autoapp's run store uses it to close the record the gate has been writing
   * steps into: the browser's run identifier is the prefix of every request
   * identifier the turn produced, so this is the one signal that ties the two
   * together. An application that does not record runs leaves it unset.
   */
  readonly onRunEnd?: (
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    summary: string,
    detail?: RunEndDetail,
  ) => void;
  /**
   * Called once per turn, after the context budget and before the model, with
   * what the model is about to be given.
   *
   * A hook that throws is logged and ignored: recording a turn is never a
   * reason to fail it.
   */
  readonly onContext?: (runId: string, delivered: DeliveredContext) => void;
  /**
   * Called after each completed model step of a turn, with the tokens its
   * completed steps have used so far: what a running turn has cost, before
   * `onRunEnd` says what it cost in all. A hook that throws is logged and
   * ignored, like the others.
   */
  readonly onUsageSoFar?: (runId: string, soFar: { inputTokens: number; outputTokens: number }) => void;
  /**
   * How long a model listing waits for a provider before it shows the list
   * that provider gave last. Default 5_000 ms. A connection test keeps its own
   * twenty seconds: a person who pressed Test is waiting for that one answer.
   */
  readonly modelListTimeoutMs?: number;
  /**
   * How young a provider's last list must be to answer `ai.modelsList`
   * without asking it again. Default 30_000 ms. `ai.modelsRefresh` ignores it.
   */
  readonly modelListFreshMs?: number;
  /** The clock kept lists are dated by. Defaults to `Date.now`; tests inject one. */
  readonly now?: () => number;
}

/**
 * What a tool may be called.
 *
 * Dots are allowed so that a contract route can be its own tool name, which is
 * what `fromContract` does. Anything else risks a provider rejecting the whole
 * request over a name the application chose carelessly.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** The AI layer, ready to mount. */
export interface Ai {
  mount(bridge: Bridge): void;
  abortAll(reason: string): void;
  /**
   * Release what the layer holds open. Call it from the application's
   * shutdown, beside `abortAll`.
   *
   * Today that is the conversation store: closing it checkpoints the WAL, so
   * what is left on disk is one complete database rather than one that needs
   * its sidecars. Calling it twice is harmless, and an application that never
   * opened a conversation has nothing to close.
   */
  close(): void;
  readonly activeStreams: number;
  /** For tests, and for applications that read settings on the host. */
  readonly registry: Registry;
  /**
   * The configured model, for host code that needs one outside a chat turn.
   *
   * Resolved the same way a turn resolves it, so a caller is told "AI is not
   * set up yet" in the same words, and always a model instance — never a
   * string the AI SDK would send to its gateway.
   */
  model(override?: { readonly modelId?: string }): Promise<LanguageModel>;
  /**
   * Run one chat turn in this process, without a bridge or a browser.
   *
   * For scripts that drive the engineer themselves, such as a replay. It is
   * the `ai.chat` route's own loop — the same tools, gate, context providers
   * and hooks — with a sink that collects the events instead of writing them to
   * a socket, and `answer` standing where the person's click would.
   */
  turn(turn: InProcessTurn, options: InProcessTurnOptions): Promise<InProcessTurnResult>;
}

/** How long an in-process answer waits for its question to be registered. */
const ANSWER_ATTEMPTS = 200;
const ANSWER_INTERVAL_MS = 5;

/**
 * How long a provider is given to answer a connection test, and how long a
 * request for its list may run after the listing has stopped waiting for it.
 */
const PROVIDER_TIMEOUT_MS = 20_000;

/** The contract's bound on `ai.modelsList`, over every provider's list together. */
const MAX_LISTED_MODELS = 1000;

const NOT_SET_UP = 'AI is not set up yet. Open Settings to choose a provider.';

/**
 * A model id no provider offers, for asking `resolve` whether a provider's
 * key and address are there. `resolve` checks the model last and never sends
 * anything, so the id is never used.
 */
const NO_MODEL = '-';

/** One provider's list, read now or, when `stale` is set, kept from earlier. */
interface Listed {
  readonly adapter: ProviderAdapter;
  readonly models: BroappModel[];
  readonly stale?: { readonly listedAt: number; readonly message: string };
}

/** One provider that could not be listed, and the error that says why. */
interface Unlisted {
  readonly adapter: ProviderAdapter;
  readonly failure: PublicError;
}

/**
 * What stops a provider being tested, in `resolve`'s words, or `null`.
 *
 * Written here as well as in the registry because a provider that is off
 * cannot go through `resolve` — which refuses it for being off — and still has
 * to be testable. A test holds the two sets of sentences equal.
 */
function unmet(adapter: ProviderAdapter, config: AdapterConfig): string | null {
  if (adapter.needs.apiKey === 'required' && (config.apiKey === null || config.apiKey === '')) {
    return `An API key is required for ${adapter.label}.`;
  }
  if (adapter.needs.baseUrl === 'required' && (config.baseUrl === null || config.baseUrl === '')) {
    return `A server address is required for ${adapter.label}.`;
  }
  return null;
}

/**
 * Split `limit` rows between lists of the given lengths so that no list gives
 * up rows while another keeps more than it: a short list is shown whole, and
 * what is left is shared equally between the long ones.
 */
export function fairShares(lengths: readonly number[], limit: number): number[] {
  const shares = lengths.map(() => 0);
  let left = limit;
  let open = lengths.map((_, index) => index).filter((index) => (lengths[index] ?? 0) > 0);
  // Each round gives every list still wanting rows an equal part of what is
  // left, at least one, so the loop ends: rows run out or every list is whole.
  while (open.length > 0 && left > 0) {
    const each = Math.max(1, Math.floor(left / open.length));
    const next: number[] = [];
    for (const index of open) {
      if (left === 0) break;
      const given = Math.min((lengths[index] ?? 0) - (shares[index] ?? 0), each, left);
      shares[index] = (shares[index] ?? 0) + given;
      left -= given;
      if ((shares[index] ?? 0) < (lengths[index] ?? 0)) next.push(index);
    }
    open = next;
  }
  return shares;
}

/** Defaults for the run loop, all overridable per application. */
const DEFAULT_CONTEXT_BUDGET_CHARS = 40_000;
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_CONFIRM_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL_LIST_FRESH_MS = 30_000;

/**
 * The providers whose kept list `patch` makes wrong: its address changed, its
 * key was set or cleared, or it was turned off. Changing `remember`, a model,
 * or which provider is in use drops nothing — none of them changes what a
 * provider would list.
 */
function listsToDrop(
  before: AiSettings,
  after: AiSettings,
  patch: { readonly provider?: string | undefined; readonly target?: string | undefined; readonly apiKey?: string | null | undefined },
): string[] {
  const keyFor = patch.apiKey === undefined ? null : (patch.target ?? patch.provider ?? before.provider);
  return after.providers
    .filter((now) => {
      const then = before.providers.find((entry) => entry.id === now.id);
      if (then === undefined) return true;
      return (
        then.baseUrl !== now.baseUrl ||
        then.hasKey !== now.hasKey ||
        (then.enabled && !now.enabled) ||
        now.id === keyFor
      );
    })
    .map((entry) => entry.id);
}

/** Build the AI layer for one application. */
export function createAi(options: CreateAiOptions): Ai {
  if (options.providers.length === 0) {
    throw new TypeError('createAi needs at least one provider adapter');
  }
  const seen = new Set<string>();
  for (const adapter of options.providers) {
    if (seen.has(adapter.id)) {
      throw new TypeError(`two provider adapters share the id ${JSON.stringify(adapter.id)}`);
    }
    seen.add(adapter.id);
  }
  for (const [name, definition] of Object.entries(options.tools ?? {})) {
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new TypeError(`tool name ${JSON.stringify(name)} must be letters, digits, "_" or "."`);
    }
    // A tool is host code that a model gets to trigger. Whether it asked
    // anybody first is not visible in its type, so the brand is required
    // rather than hoped for: an application cannot hand a model an ungated
    // capability by forgetting one wrapper.
    if ((definition as { [GUARDED]?: true })[GUARDED] !== true) {
      throw new TypeError(
        `tool ${JSON.stringify(name)} does not pass the gate; build it with guardedTool()`,
      );
    }
  }

  // Both stores are built once and kept. `remember` chooses between them, and
  // switching has to move a key from one to the other rather than construct a
  // new store and lose what the old one held.
  const settingsStore = createSettingsStore(options.dataDir);
  const fileSecrets = createFileSecretStore(options.dataDir);
  const memorySecrets = createMemorySecretStore();
  const registry = createRegistry({
    adapters: options.providers,
    settingsStore,
    fileSecrets,
    memorySecrets,
    fetch: options.fetch ?? globalThis.fetch,
  });

  const host: HostApp<AiContract> = createReservedHostApp<AiContract>(aiContract, {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  host.operation('ai.settingsGet', () => registry.settings());
  const modelLists = createModelLists({
    deadlineMs: options.modelListTimeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS,
    freshMs: options.modelListFreshMs ?? DEFAULT_MODEL_LIST_FRESH_MS,
    requestTimeoutMs: PROVIDER_TIMEOUT_MS,
    now: options.now ?? Date.now,
  });

  host.operation('ai.settingsUpdate', async (input) => {
    const before = await registry.settings();
    const after = await registry.update(input);
    // What is remembered about a provider goes with the address, the key and
    // the switch it was read under, as surely as what is sent to it does.
    for (const id of listsToDrop(before, after, input)) modelLists.drop(id);
    return after;
  });

  host.operation('ai.providersList', () => ({
    providers: options.providers.map((adapter): ProviderInfo => {
      // Deliberately computed without the key: whether requests leave this
      // machine is a property of the address, and the user is entitled to the
      // answer before they have entered anything.
      const config = registry.configFor(adapter);
      return {
        id: adapter.id,
        label: adapter.label,
        local: adapter.local(config),
        needs: { apiKey: adapter.needs.apiKey, baseUrl: adapter.needs.baseUrl },
        defaultBaseUrl: adapter.defaultBaseUrl,
      };
    }),
  }));

  host.operation('ai.modelsList', () => listModels({ fresh: true }));
  // The Refresh button: every enabled provider is asked, whatever it answered
  // a moment ago. Mounting a panel goes through `ai.modelsList` and is cheap.
  host.operation('ai.modelsRefresh', () => listModels({ fresh: false }));

  async function listModels({ fresh }: { readonly fresh: boolean }): Promise<{
    models: BroappModel[];
    unavailable: UnavailableProvider[];
  }> {
    // Nothing set up is still "not set up", in today's words, whatever else is
    // turned on: a launcher with no provider in use has not been set up.
    await requireConfig();
    const settings = await registry.settings();
    // A provider that is off is never listed, from memory either.
    const enabled = options.providers.filter((adapter) =>
      settings.providers.some((entry) => entry.id === adapter.id && entry.enabled),
    );
    // Every enabled provider at once, each under the listing's own deadline,
    // so one that is slow or down costs its own group and not the whole list.
    const answers = await Promise.all(enabled.map((adapter) => listOf(adapter, fresh)));
    const read = answers.filter((answer): answer is Listed => 'models' in answer);
    if (read.length === 0) {
      // Nothing to show at all. An application with one provider sees exactly
      // what it saw: that provider's own error. With several, the first in the
      // build's order.
      const first = answers.find((answer): answer is Unlisted => 'failure' in answer);
      throw first === undefined ? publicError.unavailable(NOT_SET_UP) : first.failure;
    }
    const shares = fairShares(read.map((answer) => answer.models.length), MAX_LISTED_MODELS);
    const unavailable: UnavailableProvider[] = [];
    const models: BroappModel[] = [];
    // In the build's order, so each provider's lines sit where its group does.
    for (const answer of answers) {
      if ('failure' in answer) {
        unavailable.push({ provider: answer.adapter.id, message: answer.failure.message, reason: 'failed' });
        continue;
      }
      if (answer.stale !== undefined) {
        unavailable.push({
          provider: answer.adapter.id,
          message: answer.stale.message,
          reason: 'stale',
          listedAt: answer.stale.listedAt,
        });
      }
      const share = shares[read.indexOf(answer)] ?? 0;
      models.push(...answer.models.slice(0, share));
      if (share < answer.models.length) {
        unavailable.push({
          provider: answer.adapter.id,
          message: `${answer.adapter.label}: only the first ${String(share)} models are shown.`,
          reason: 'truncated',
        });
      }
    }
    return { models, unavailable };
  }

  host.operation('ai.connectionTest', async () => {
    // `resolve()` rather than `currentConfig()`: testing a connection that is
    // missing its key would just ask the provider to reject it, and the layer
    // already knows the answer and can say it in better words.
    const { adapter, config } = await registry.resolve();
    return tryConnection(adapter, config);
  });

  host.operation('ai.providerTest', async ({ provider }) => {
    const adapter = registry.adapter(provider);
    if (adapter === null) throw publicError.invalidInput('Unknown provider.');
    // Its own stored address and key, whether or not it is turned on: a person
    // tests a provider before they decide to use it. Testing leaves it as it was.
    const settings = settingsStore.read();
    const secrets = settings.remember ? fileSecrets : memorySecrets;
    const config: AdapterConfig = {
      ...registry.configFor(adapter),
      apiKey: await secrets.get(apiKeySecretName(adapter.id)),
    };
    const problem = unmet(adapter, config);
    if (problem !== null) throw publicError.unavailable(problem);
    return tryConnection(adapter, config);
  });

  /** One test of one provider: an answer either way, never a failed route for a provider's refusal. */
  async function tryConnection(
    adapter: ProviderAdapter,
    config: AdapterConfig,
  ): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const started = Bun.nanoseconds();
    const elapsed = (): number => Math.round((Bun.nanoseconds() - started) / 1_000_000);
    try {
      await adapter.test(config, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
      return { ok: true, message: `Connected to ${adapter.label}.`, latencyMs: elapsed() };
    } catch (cause) {
      // A failed connection test is the answer to the question, not a failure
      // of the route: the UI shows the reason next to the button. Anything
      // that is not a deliberate adapter failure is still a fault.
      if (!(cause instanceof AdapterError)) throw cause;
      return { ok: false, message: cause.message, latencyMs: elapsed() };
    }
  }

  /**
   * One enabled provider's list, or why there is none. A provider whose key
   * or address is missing is not asked: `resolve` names what is missing, in
   * the same words a turn would hear, so the rule stays written once.
   */
  async function listOf(adapter: ProviderAdapter, fresh: boolean): Promise<Listed | Unlisted> {
    let config: AdapterConfig;
    try {
      ({ config } = await registry.resolve({ modelId: formatModelRef(adapter.id, NO_MODEL) }));
    } catch (cause) {
      if (isPublicError(cause)) return { adapter, failure: cause };
      throw cause;
    }
    const outcome = await modelLists.list(adapter, config, { fresh });
    switch (outcome.kind) {
      case 'listed':
        return { adapter, models: outcome.models };
      case 'stale':
        return { adapter, models: outcome.models, stale: { listedAt: outcome.listedAt, message: outcome.message } };
      case 'failed':
        return { adapter, failure: outcome.failure };
    }
  }

  // Opened on the first conversation route and not before: an application
  // whose user never opens the panel should not find a database in its data
  // directory, and `createAi` is built unconditionally by every application
  // that offers AI at all. A turn opens it too, to keep its transcript.
  let threads: ThreadStore | null = null;
  const threadStore = (): ThreadStore =>
    (threads ??= openThreads(options.dataDir, options.logger === undefined ? {} : { logger: options.logger }));

  const approvals = createPendingApprovals(options.logger);
  const runDeps: RunDeps = {
    registry,
    app: options.app,
    context: options.context ?? {},
    tools: options.tools ?? {},
    contextBudgetChars: options.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    confirmTimeoutMs: options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
    approvals,
    ...(options.onRunEnd === undefined ? {} : { onRunEnd: options.onRunEnd }),
    ...(options.onContext === undefined ? {} : { onContext: options.onContext }),
    ...(options.onUsageSoFar === undefined ? {} : { onUsageSoFar: options.onUsageSoFar }),
    transcripts: {
      save: (runId, messages) => {
        threadStore().saveTranscript(runId, messages);
      },
      read: (runId) => threadStore().transcript(runId),
    },
    logger: options.logger ?? console,
  };

  host.stream('ai.chat', (params, sink) => runChat(params, sink, runDeps));
  // The wire shape is unchanged: a run and a call name the question, and
  // `accepted` says whether anybody was waiting on it. What changed is where
  // the answer goes — into the same approval table the gate asks.
  host.operation('ai.chatConfirm', ({ runId, callId, approve }) => ({
    accepted:
      approvals.answer({ requestId: `${runId}:${callId}`, approved: approve }) === 'accepted',
  }));

  host.operation('ai.threadsList', () => ({ threads: threadStore().list() }));
  host.operation('ai.threadsCreate', (input) => threadStore().create(input));
  host.operation('ai.threadsGet', ({ id }) => threadStore().get(id));
  host.operation('ai.threadsSave', (input) => threadStore().save(input));
  host.operation('ai.threadsUpdate', (input) => threadStore().update(input));
  host.operation('ai.threadsDelete', ({ id }) => ({ deleted: threadStore().remove(id) }));
  host.operation('ai.threadsClear', () => ({ deleted: threadStore().clear() }));

  /** The current provider config, or the "not set up" error. */
  async function requireConfig(): Promise<{ adapter: ProviderAdapter; config: AdapterConfig }> {
    const current = await registry.currentConfig();
    if (current === null) {
      throw publicError.unavailable(NOT_SET_UP);
    }
    return current;
  }

  return {
    mount: (bridge: Bridge) => host.mount(bridge),
    abortAll: (reason: string) => host.abortAll(reason),
    close: () => {
      threads?.close();
      threads = null;
    },
    get activeStreams() {
      return host.activeStreams;
    },
    registry,
    model: async (override) => {
      const { adapter, config, modelId } = await registry.resolve(override);
      return adapter.model(config, modelId);
    },
    turn: async (turn, turnOptions) => {
      const controller = new AbortController();
      const relay = (): void => controller.abort(turnOptions.signal?.reason);
      turnOptions.signal?.addEventListener('abort', relay, { once: true });
      if (turnOptions.signal?.aborted === true) relay();

      const events: ChatEvent[] = [];
      /**
       * Answer a question once the approval table holds it.
       *
       * The `confirm` event is emitted, and awaited, before the run's approver
       * registers the question, so an answer given inside `emit` would find
       * nobody waiting. This waits for it, briefly, the way a person's click
       * necessarily arrives later.
       */
      const settle = async (requestId: string, approved: boolean): Promise<void> => {
        for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt += 1) {
          if (approvals.answer({ requestId, approved }) !== 'unknown') return;
          await Bun.sleep(ANSWER_INTERVAL_MS);
        }
      };
      const sink: StreamSink<ChatEvent> = {
        signal: controller.signal,
        sessionId: 'in-process',
        emit(event) {
          if (controller.signal.aborted) return Promise.reject(new Error('stream is no longer open'));
          events.push(event);
          turnOptions.onEvent?.(event);
          if (event.type === 'confirm') {
            // The gate's request id is `<runId>:<callId>`, which is what an
            // event without one would have named.
            const requestId = event.requestId ?? `${turn.runId}:${event.callId}`;
            const answer = turnOptions.answer({
              tool: event.tool ?? '',
              input: event.input,
              requestId,
              callId: event.callId ?? '',
              ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
            });
            if (answer !== 'defer') void settle(requestId, answer);
          }
          return Promise.resolve();
        },
      };

      let status: InProcessTurnResult['status'] | null = null;
      const onRunEnd = runDeps.onRunEnd;
      try {
        await runChat(
          {
            runId: turn.runId,
            message: turn.message,
            refs: [],
            history: turn.history === undefined ? [] : [...turn.history],
            ...(turn.modelId === undefined ? {} : { modelId: turn.modelId }),
          },
          sink,
          {
            ...runDeps,
            // The turn's own ending is what this returns; whoever the layer
            // was built to tell is still told.
            onRunEnd: (runId, ended, summary, detail) => {
              status = ended;
              onRunEnd?.(runId, ended, summary, detail);
            },
          },
        );
        return { status: status ?? 'succeeded', events };
      } catch (cause) {
        // A turn that could not start — no provider set up, most often — ends
        // failed with the sentence the browser would have been shown.
        const error = String(cause instanceof Error ? cause.message : cause);
        return { status: status ?? 'failed', events, error };
      } finally {
        turnOptions.signal?.removeEventListener('abort', relay);
      }
    },
  };
}
