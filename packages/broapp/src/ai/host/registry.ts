/**
 * Settings plus adapters, resolved into "the model to use right now".
 *
 * Every route that needs a provider goes through here, so the rules about what
 * counts as configured are written once. `resolve()` is the single source of
 * that truth: `configured` in the settings the browser sees is literally
 * "would `resolve()` succeed", rather than a second copy of the same
 * conditions that can drift from the first.
 */
import { PublicError, publicError } from '../../shared/errors.ts';
import type { AiSettings } from '../shared/types.ts';

import type { AdapterConfig, ProviderAdapter } from './adapter.ts';
import { apiKeySecretName, type SecretStore } from './secrets.ts';
import type { SettingsStore, StoredSettings } from './settings.ts';

/** Everything needed to run one chat turn. */
export interface ResolvedModel {
  readonly adapter: ProviderAdapter;
  readonly config: AdapterConfig;
  readonly modelId: string;
}

/** The fields `ai.settings.update` may change. */
export interface UpdatePatch {
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly apiKey?: string | null | undefined;
  readonly remember?: boolean | undefined;
}

/** The adapters this build has, and the settings pointing at one of them. */
export interface Registry {
  readonly adapters: readonly ProviderAdapter[];
  adapter(id: string): ProviderAdapter | null;
  /** Current settings plus the key, for adapter calls. */
  currentConfig(): Promise<{ adapter: ProviderAdapter; config: AdapterConfig } | null>;
  /** Everything needed to run a chat, or a `PublicError` explaining what is missing. */
  resolve(): Promise<ResolvedModel>;
  /** The public view: settings without the key. */
  settings(): Promise<AiSettings>;
  update(patch: UpdatePatch): Promise<AiSettings>;
  /** The config an adapter would get today, ignoring which one is selected. */
  configFor(adapter: ProviderAdapter): AdapterConfig;
}

/** What {@link createRegistry} needs from its surroundings. */
export interface RegistryOptions {
  readonly adapters: readonly ProviderAdapter[];
  readonly settingsStore: SettingsStore;
  readonly fileSecrets: SecretStore;
  readonly memorySecrets: SecretStore;
  readonly fetch: typeof fetch;
}

const NOT_SET_UP = 'AI is not set up yet. Open Settings to choose a provider.';

/**
 * A key is hinted by its last four characters, and only when it is long
 * enough that four characters are a small fraction of it. A short key would
 * be half-published by its own hint.
 */
function hint(key: string | null): string | null {
  if (key === null || key.length < 8) return null;
  return key.slice(-4);
}

export function createRegistry(options: RegistryOptions): Registry {
  const byId = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));

  /** The store the key currently lives in, which `remember` decides. */
  function store(settings: StoredSettings): SecretStore {
    return settings.remember ? options.fileSecrets : options.memorySecrets;
  }

  async function keyFor(settings: StoredSettings, providerId: string): Promise<string | null> {
    return store(settings).get(apiKeySecretName(providerId));
  }

  function configFrom(settings: StoredSettings, adapter: ProviderAdapter, apiKey: string | null): AdapterConfig {
    return {
      apiKey,
      baseUrl: settings.baseUrl ?? adapter.defaultBaseUrl,
      fetch: options.fetch,
    };
  }

  const registry: Registry = {
    adapters: options.adapters,

    adapter: (id) => byId.get(id) ?? null,

    configFor(adapter) {
      const settings = options.settingsStore.read();
      // The stored base URL belongs to the *selected* provider. Applying it to
      // the others would have told the user that Anthropic runs on their
      // computer, simply because they had Ollama selected a moment ago.
      const scoped: StoredSettings =
        settings.provider === adapter.id ? settings : { ...settings, baseUrl: null };
      // No key either: whether a provider stays on this machine is a property
      // of the address, and the answer must not depend on what is stored.
      return configFrom(scoped, adapter, null);
    },

    async currentConfig() {
      const settings = options.settingsStore.read();
      if (settings.provider === null) return null;
      const adapter = byId.get(settings.provider);
      if (adapter === undefined) return null;
      const apiKey = await keyFor(settings, adapter.id);
      return { adapter, config: configFrom(settings, adapter, apiKey) };
    },

    async resolve() {
      const settings = options.settingsStore.read();
      if (settings.provider === null) throw publicError.unavailable(NOT_SET_UP);
      const adapter = byId.get(settings.provider);
      if (adapter === undefined) {
        throw publicError.unavailable('The configured AI provider is not available in this build.');
      }
      // The key and the address come before the model on purpose: the list of
      // models is fetched *from* the provider, so telling a user to choose one
      // before they can see any is an instruction they cannot follow.
      const apiKey = await keyFor(settings, adapter.id);
      if (adapter.needs.apiKey === 'required' && (apiKey === null || apiKey === '')) {
        throw publicError.unavailable(`An API key is required for ${adapter.label}.`);
      }
      const config = configFrom(settings, adapter, apiKey);
      if (adapter.needs.baseUrl === 'required' && (config.baseUrl === null || config.baseUrl === '')) {
        throw publicError.unavailable(`A server address is required for ${adapter.label}.`);
      }
      if (settings.modelId === null) {
        // Distinct from "not set up": the user is looking at the settings panel
        // with a provider selected, and being told to choose a provider is an
        // instruction they have already followed.
        throw publicError.unavailable(`Choose a model for ${adapter.label}.`);
      }
      return { adapter, config, modelId: settings.modelId };
    },

    async settings() {
      const settings = options.settingsStore.read();
      const apiKey =
        settings.provider === null ? null : await keyFor(settings, settings.provider);
      let configured = true;
      try {
        await registry.resolve();
      } catch (cause) {
        // Anything that is not a deliberate "not configured" is a real fault
        // and must not be reported as merely unconfigured.
        if (!(cause instanceof PublicError)) throw cause;
        configured = false;
      }
      return {
        provider: settings.provider,
        modelId: settings.modelId,
        baseUrl: settings.baseUrl,
        hasKey: apiKey !== null && apiKey !== '',
        keyHint: hint(apiKey),
        remember: settings.remember,
        configured,
      };
    },

    async update(patch) {
      const before = options.settingsStore.read();
      const next: StoredSettings = { ...before };

      if (patch.provider !== undefined) {
        if (!byId.has(patch.provider)) throw publicError.invalidInput('Unknown provider.');
        if (patch.provider !== before.provider) {
          next.provider = patch.provider;
          // A model id belongs to the provider that offers it, and a base URL
          // points at that provider's server. Carrying either across a change
          // would leave the settings describing something that does not exist.
          next.modelId = null;
          next.baseUrl = byId.get(patch.provider)?.defaultBaseUrl ?? null;
        }
      }
      if (patch.modelId !== undefined) next.modelId = patch.modelId;
      if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;

      if (patch.remember !== undefined && patch.remember !== before.remember) {
        next.remember = patch.remember;
        await moveKeys(before, next);
      }

      if (patch.apiKey !== undefined && next.provider !== null) {
        const name = apiKeySecretName(next.provider);
        const value = patch.apiKey === null || patch.apiKey === '' ? null : patch.apiKey;
        if (value === null) await store(next).delete(name);
        else await store(next).set(name, value);
      }

      options.settingsStore.write(next);
      return registry.settings();
    },
  };

  /**
   * Move every stored key to the store `after` selects.
   *
   * Turning `remember` off must not merely stop future writes: the key already
   * on disk has to leave the disk, or the setting would be a promise the
   * layer does not keep.
   */
  async function moveKeys(before: StoredSettings, after: StoredSettings): Promise<void> {
    const from = store(before);
    const to = store(after);
    for (const adapter of options.adapters) {
      const name = apiKeySecretName(adapter.id);
      const value = await from.get(name);
      if (value === null) continue;
      await to.set(name, value);
      await from.delete(name);
    }
  }

  return registry;
}
