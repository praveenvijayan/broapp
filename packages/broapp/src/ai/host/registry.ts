/**
 * Settings plus adapters, resolved into "the model to use right now".
 *
 * Every route that needs a provider goes through here, so the rules about what
 * counts as configured are written once. `resolve()` is the single source of
 * that truth: `configured` in the settings the browser sees is literally
 * "would `resolve()` succeed", rather than a second copy of the same
 * conditions that can drift from the first.
 */
import { isPublicError, publicError } from '../../shared/errors.ts';
import { parseModelRef } from '../shared/model-ref.ts';
import type { AiSettings, ProviderSettings } from '../shared/types.ts';

import type { AdapterConfig, ProviderAdapter } from './adapter.ts';
import { apiKeySecretName, type SecretStore } from './secrets.ts';
import type { ProviderEntry, SettingsStore, StoredSettings } from './settings.ts';


/** Everything needed to run one chat turn. */
export interface ResolvedModel {
  readonly adapter: ProviderAdapter;
  readonly config: AdapterConfig;
  /** The provider's own id for the model: never a qualified reference. */
  readonly modelId: string;
}

/** The fields `ai.settings.update` may change. */
export interface UpdatePatch {
  /** Make this provider the one in use. */
  readonly provider?: string | undefined;
  /**
   * The provider `modelId`, `baseUrl`, `apiKey` and `enabled` apply to. Absent
   * means the provider in use, which is what every field meant before there
   * was more than one.
   */
  readonly target?: string | undefined;
  readonly modelId?: string | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly apiKey?: string | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly remember?: boolean | undefined;
}

/** The adapters this build has, and the settings pointing at them. */
export interface Registry {
  readonly adapters: readonly ProviderAdapter[];
  adapter(id: string): ProviderAdapter | null;
  /**
   * The id of the provider in use, read now and without a key: for a caller
   * that must say, as a turn ends, whether it ran somewhere else.
   */
  activeProvider(): string | null;
  /** The provider in use and its key, for adapter calls. */
  currentConfig(): Promise<{ adapter: ProviderAdapter; config: AdapterConfig } | null>;
  /**
   * One provider's own address and key, for adapter calls; `null` when this
   * build has no such provider or it is not turned on — a provider that is
   * off is sent nothing, not even a request for its list.
   */
  configOf(providerId: string): Promise<{ adapter: ProviderAdapter; config: AdapterConfig } | null>;
  /**
   * Everything needed to run a chat, or a `PublicError` explaining what is
   * missing.
   *
   * `override.modelId` replaces the model Settings names, for this call only.
   * It is a model reference: bare, it is a model of the provider in use; as
   * `<provider>:<model>` it runs on that provider, with that provider's own
   * key and address, provided the person turned it on.
   */
  resolve(override?: { readonly modelId?: string | undefined }): Promise<ResolvedModel>;
  /** The public view: settings without the key. */
  settings(): Promise<AiSettings>;
  update(patch: UpdatePatch): Promise<AiSettings>;
  /** The config an adapter would get today from its own entry, whether or not it is in use. No key. */
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

/**
 * A provider's entry, or what one it has never had would hold: its default
 * address, no model, and off.
 */
function entryOf(settings: StoredSettings, adapter: ProviderAdapter): ProviderEntry {
  return settings.providers[adapter.id] ?? { baseUrl: adapter.defaultBaseUrl, modelId: null, enabled: false };
}

/** The provider in use is always on, whatever its entry says. */
function isEnabled(settings: StoredSettings, providerId: string): boolean {
  return settings.active === providerId || settings.providers[providerId]?.enabled === true;
}

function hasValue(value: string | null): value is string {
  return value !== null && value !== '';
}

export function createRegistry(options: RegistryOptions): Registry {
  const byId = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
  const ids = options.adapters.map((adapter) => adapter.id);

  /** The store the keys currently live in, which `remember` decides. */
  function store(settings: StoredSettings): SecretStore {
    return settings.remember ? options.fileSecrets : options.memorySecrets;
  }

  async function keyFor(settings: StoredSettings, providerId: string): Promise<string | null> {
    return store(settings).get(apiKeySecretName(providerId));
  }

  /**
   * The config a provider gets: its own entry's address and its own key. An
   * address is only ever applied to the provider it was typed for.
   */
  function configFrom(entry: ProviderEntry, adapter: ProviderAdapter, apiKey: string | null): AdapterConfig {
    return {
      apiKey,
      baseUrl: entry.baseUrl ?? adapter.defaultBaseUrl,
      fetch: options.fetch,
    };
  }

  /**
   * What stops a provider being used, in the words a person is shown, or
   * `null` when its key and address are both there. The key and the address
   * come before the model on purpose: the list of models is fetched *from* the
   * provider, so telling a user to choose one before they can see any is an
   * instruction they cannot follow.
   */
  function missing(adapter: ProviderAdapter, config: AdapterConfig): string | null {
    if (adapter.needs.apiKey === 'required' && !hasValue(config.apiKey)) {
      return `An API key is required for ${adapter.label}.`;
    }
    if (adapter.needs.baseUrl === 'required' && !hasValue(config.baseUrl)) {
      return `A server address is required for ${adapter.label}.`;
    }
    return null;
  }

  const registry: Registry = {
    adapters: options.adapters,

    adapter: (id) => byId.get(id) ?? null,

    activeProvider: () => options.settingsStore.read().active,

    configFor(adapter) {
      // Each provider's own entry, so the fault this once had cannot come
      // back: an address typed for Ollama applied to Anthropic told the user
      // that Anthropic runs on their computer. No key either: whether a
      // provider stays on this machine is a property of the address, and the
      // answer must not depend on what is stored.
      return configFrom(entryOf(options.settingsStore.read(), adapter), adapter, null);
    },

    async currentConfig() {
      const settings = options.settingsStore.read();
      if (settings.active === null) return null;
      return registry.configOf(settings.active);
    },

    async configOf(providerId) {
      const settings = options.settingsStore.read();
      const adapter = byId.get(providerId);
      if (adapter === undefined || !isEnabled(settings, providerId)) return null;
      const apiKey = await keyFor(settings, adapter.id);
      return { adapter, config: configFrom(entryOf(settings, adapter), adapter, apiKey) };
    },

    async resolve(override) {
      const settings = options.settingsStore.read();
      // First even for a reference naming another provider: a launcher with
      // nothing set up is not set up.
      if (settings.active === null) throw publicError.unavailable(NOT_SET_UP);
      const ref = override?.modelId === undefined ? null : parseModelRef(override.modelId, ids);
      const providerId = ref?.provider ?? settings.active;
      const adapter = byId.get(providerId);
      if (adapter === undefined) {
        throw publicError.unavailable('The configured AI provider is not available in this build.');
      }
      // Before the key is read and before anything is sent: a line in a tier
      // file must not reach a provider the person never turned on.
      if (!isEnabled(settings, providerId)) {
        throw publicError.unavailable(`${adapter.label} is not turned on in Settings.`);
      }
      const entry = entryOf(settings, adapter);
      const config = configFrom(entry, adapter, await keyFor(settings, adapter.id));
      const problem = missing(adapter, config);
      if (problem !== null) throw publicError.unavailable(problem);
      // Read after the provider, the key and the address, so a conversation
      // carrying its own model still hears "AI is not set up yet" first: the
      // model is the last thing missing, never the first.
      const modelId = ref?.modelId ?? entry.modelId;
      if (modelId === null) {
        // Distinct from "not set up": the user is looking at the settings panel
        // with a provider selected, and being told to choose a provider is an
        // instruction they have already followed.
        throw publicError.unavailable(`Choose a model for ${adapter.label}.`);
      }
      return { adapter, config, modelId };
    },

    async settings() {
      const settings = options.settingsStore.read();
      const providers: ProviderSettings[] = [];
      for (const adapter of options.adapters) {
        const entry = entryOf(settings, adapter);
        const apiKey = await keyFor(settings, adapter.id);
        providers.push({
          id: adapter.id,
          baseUrl: entry.baseUrl,
          modelId: entry.modelId,
          enabled: isEnabled(settings, adapter.id),
          hasKey: hasValue(apiKey),
          keyHint: hint(apiKey),
          configured: missing(adapter, configFrom(entry, adapter, apiKey)) === null,
        });
      }
      // The top-level fields are the provider in use, so an application
      // written before there was more than one reads what it always read.
      const active = providers.find((element) => element.id === settings.active) ??
        (settings.active === null ? undefined : settings.providers[settings.active]);
      const apiKey = settings.active === null ? null : await keyFor(settings, settings.active);
      let configured = true;
      try {
        await registry.resolve();
      } catch (cause) {
        // Anything that is not a deliberate "not configured" is a real fault
        // and must not be reported as merely unconfigured.
        if (!isPublicError(cause)) throw cause;
        configured = false;
      }
      return {
        provider: settings.active,
        modelId: active?.modelId ?? null,
        baseUrl: active?.baseUrl ?? null,
        hasKey: hasValue(apiKey),
        keyHint: hint(apiKey),
        remember: settings.remember,
        configured,
        providers,
      };
    },

    async update(patch) {
      const before = options.settingsStore.read();
      const next: StoredSettings = {
        ...before,
        providers: Object.fromEntries(
          Object.entries(before.providers).map(([id, entry]) => [id, { ...entry }]),
        ),
      };
      /** A provider's entry in `next`, made from its defaults the first time it is touched. */
      const entry = (adapter: ProviderAdapter): ProviderEntry =>
        (next.providers[adapter.id] ??= { ...entryOf(before, adapter) });

      if (patch.target !== undefined && !byId.has(patch.target)) {
        throw publicError.invalidInput('Unknown provider.');
      }
      if (patch.provider !== undefined) {
        const chosen = byId.get(patch.provider);
        if (chosen === undefined) throw publicError.invalidInput('Unknown provider.');
        if (patch.target !== undefined && patch.target !== patch.provider) {
          throw publicError.invalidInput('A provider can be made the one in use only by naming it as the target too.');
        }
        // Each provider keeps its own address and model, so changing provider
        // restores the one chosen's rather than clearing both: a model id
        // belongs to the provider that offers it, and it stays with that
        // provider instead of being carried to another or thrown away.
        next.active = patch.provider;
        entry(chosen).enabled = true;
      }

      const targetId = patch.target ?? next.active;
      const target = targetId === null ? undefined : byId.get(targetId);
      if (target !== undefined) {
        if (patch.modelId !== undefined) entry(target).modelId = patch.modelId;
        if (patch.baseUrl !== undefined) entry(target).baseUrl = patch.baseUrl;
        if (patch.enabled !== undefined) {
          if (!patch.enabled && target.id === next.active) {
            throw publicError.invalidInput('The provider in use cannot be turned off. Choose another first.');
          }
          entry(target).enabled = patch.enabled;
        }
      }

      if (patch.remember !== undefined && patch.remember !== before.remember) {
        next.remember = patch.remember;
        await moveKeys(before, next);
      }

      if (patch.apiKey !== undefined && target !== undefined) {
        const name = apiKeySecretName(target.id);
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
   * layer does not keep. Every provider's key, not only the one in use.
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
