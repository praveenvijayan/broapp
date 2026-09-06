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
import type { Bridge } from 'brobridge';

// Imported from the host entry point rather than from `host/app.ts` directly:
// the AI layer is part of the host runtime, and depending on that entry point
// is what makes a browser bundle of `broapp/ai/host` fail to build. Bun's
// browser target polyfills `node:fs`, so the file stores alone would not stop
// this code from being bundled into a page.
import { createReservedHostApp } from '../../host/index.ts';
import type { HostApp, HostLogger } from '../../host/app.ts';
import { publicError } from '../../shared/errors.ts';
import { aiContract, type AiContract } from '../shared/contract.ts';
import type { ProviderInfo } from '../shared/types.ts';

import { AdapterError, toPublicError, type AdapterConfig, type ProviderAdapter } from './adapter.ts';
import { createRegistry, type Registry } from './registry.ts';
import { runChat, type RunDeps } from './run.ts';
import { createFileSecretStore, createMemorySecretStore } from './secrets.ts';
import { createSettingsStore } from './settings.ts';
import { createConfirmations, type AiContextProviders, type AiTool } from './tool.ts';

/** What the application is, in the words a model is given. */
export interface AiAppDescription {
  readonly name: string;
  readonly purpose: string;
  readonly terminology?: readonly string[];
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
  readonly activeStreams: number;
  /** For tests, and for applications that read settings on the host. */
  readonly registry: Registry;
}

/** How long a provider is given to answer a listing or a connection test. */
const PROVIDER_TIMEOUT_MS = 20_000;

/** Defaults for the run loop, all overridable per application. */
const DEFAULT_CONTEXT_BUDGET_CHARS = 40_000;
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_CONFIRM_TIMEOUT_MS = 300_000;

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
  for (const name of Object.keys(options.tools ?? {})) {
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new TypeError(`tool name ${JSON.stringify(name)} must be letters, digits, "_" or "."`);
    }
  }

  // Both stores are built once and kept. `remember` chooses between them, and
  // switching has to move a key from one to the other rather than construct a
  // new store and lose what the old one held.
  const registry = createRegistry({
    adapters: options.providers,
    settingsStore: createSettingsStore(options.dataDir),
    fileSecrets: createFileSecretStore(options.dataDir),
    memorySecrets: createMemorySecretStore(),
    fetch: options.fetch ?? globalThis.fetch,
  });

  const host: HostApp<AiContract> = createReservedHostApp<AiContract>(aiContract, {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  host.operation('ai.settingsGet', () => registry.settings());
  host.operation('ai.settingsUpdate', (input) => registry.update(input));

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

  host.operation('ai.modelsList', async () => {
    const { adapter, config } = await requireConfig();
    try {
      const models = await adapter.models(config, AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
      return { models };
    } catch (cause) {
      throw toPublicError(cause);
    }
  });

  host.operation('ai.connectionTest', async () => {
    // `resolve()` rather than `currentConfig()`: testing a connection that is
    // missing its key would just ask the provider to reject it, and the layer
    // already knows the answer and can say it in better words.
    const { adapter, config } = await registry.resolve();
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
  });

  const confirmations = createConfirmations();
  const runDeps: RunDeps = {
    registry,
    app: options.app,
    context: options.context ?? {},
    tools: options.tools ?? {},
    contextBudgetChars: options.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    confirmTimeoutMs: options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
    confirmations,
    logger: options.logger ?? console,
  };

  host.stream('ai.chat', (params, sink) => runChat(params, sink, runDeps));
  host.operation('ai.chatConfirm', ({ runId, callId, approve }) => ({
    accepted: confirmations.answer(runId, callId, approve),
  }));

  /** The current provider config, or the "not set up" error. */
  async function requireConfig(): Promise<{ adapter: ProviderAdapter; config: AdapterConfig }> {
    const current = await registry.currentConfig();
    if (current === null) {
      throw publicError.unavailable('AI is not set up yet. Open Settings to choose a provider.');
    }
    return current;
  }

  return {
    mount: (bridge: Bridge) => host.mount(bridge),
    abortAll: (reason: string) => host.abortAll(reason),
    get activeStreams() {
      return host.activeStreams;
    },
    registry,
  };
}
