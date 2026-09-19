/**
 * A model reference: one string that names a model and, optionally, the
 * provider that runs it.
 *
 * Written `<providerId>:<modelId>` — `ollama:qwen3:27b`,
 * `openrouter:anthropic/claude-opus-5` — and split on the **first** colon,
 * the convention the AI SDK's provider registry uses. The part before it
 * qualifies the reference only when it is the id of a provider this build
 * has; anything else is the whole string, a model of the provider in use,
 * exactly as a bare id always was. So `qwen3:27b` with Ollama in use is still
 * Ollama's `qwen3:27b`, and nothing stored before references existed changes
 * meaning.
 *
 * One consequence, stated rather than hidden: a model of the provider in use
 * whose own id begins with another provider's id and a colon cannot be reached
 * by its bare id, because the prefix is read as that other provider. Written
 * qualified — `<its own provider>:<id>` — it is reached, since only the first
 * colon splits.
 *
 * Shared code, importing nothing, so the browser's pickers and the host's
 * resolver read a reference the same way.
 */

/** A reference, split. `provider` is null when the reference names none. */
export interface ModelRef {
  provider: string | null;
  modelId: string;
}

/**
 * Split a reference into the provider it names and the provider's own model
 * id. `providerIds` are the ids of the providers this build has; a prefix that
 * is not one of them, or an empty half on either side of the colon, leaves the
 * reference unqualified and whole.
 */
export function parseModelRef(ref: string, providerIds: readonly string[]): ModelRef {
  const colon = ref.indexOf(':');
  if (colon <= 0 || colon === ref.length - 1) return { provider: null, modelId: ref };
  const provider = ref.slice(0, colon);
  if (!providerIds.includes(provider)) return { provider: null, modelId: ref };
  return { provider, modelId: ref.slice(colon + 1) };
}

/** Write a reference that names its provider. `parseModelRef` reads it back. */
export function formatModelRef(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** What {@link findModel} found for a reference. */
export interface FoundModel<M> {
  /** The provider the reference runs on: the one it names, else the one in use. */
  provider: string | null;
  /** The provider's own id for the model. */
  modelId: string;
  /** The listed model, or `null` when the list does not offer it. */
  model: M | null;
}

/**
 * Find a stored reference in a model list.
 *
 * Qualified, it matches that provider's model; bare, it matches the provider
 * in use — the one in use *now*, so a bare id stored while another provider
 * was in use never matches that other provider's model by accident. Every
 * place that shows a stored reference goes through here, so a picker, a tier
 * row and a task row cannot disagree about what it names.
 *
 * `providerIds` are every provider in the build, so a reference to one that is
 * off (and so absent from the list) still reads as naming it. Without them,
 * the providers the list and the one in use name are all that is known.
 */
export function findModel<M extends { provider: string; modelId: string }>(
  ref: string,
  models: readonly M[],
  activeProvider: string | null,
  providerIds: readonly string[] = [],
): FoundModel<M> {
  const known = new Set(providerIds);
  for (const model of models) known.add(model.provider);
  if (activeProvider !== null) known.add(activeProvider);
  const parsed = parseModelRef(ref, [...known]);
  const provider = parsed.provider ?? activeProvider;
  const model = models.find((entry) => entry.provider === provider && entry.modelId === parsed.modelId) ?? null;
  return { provider, modelId: parsed.modelId, model };
}

/** Where a provider runs, as the browser learns it from `ai.providersList`. */
export interface ProviderPlace {
  id: string;
  label: string;
  local: boolean;
}

/**
 * The words that say where a provider runs: `on this computer`, or
 * `sent to <label>`. Words, not a colour or an icon alone, wherever a model is
 * chosen or named.
 */
export function whereItRuns(provider: Pick<ProviderPlace, 'label' | 'local'>): string {
  return provider.local ? 'on this computer' : `sent to ${provider.label}`;
}

/** A stored reference, described for a person. */
export interface ModelDescription {
  /** The model's name when the list has it, else the reference's own model id. */
  name: string;
  /** `on this computer` or `sent to <label>`, or `null` when the provider is not known. */
  where: string | null;
  /** Said after the name when it cannot run: `not offered`, or `<label> is off`. */
  problem: string | null;
}

/**
 * Describe a stored reference: its name, where it runs, and what is wrong with
 * it, if anything. `enabled` lists the providers turned on in Settings.
 */
export function describeModel<M extends { provider: string; modelId: string; label: string }>(
  ref: string,
  context: {
    readonly models: readonly M[];
    readonly providers: readonly ProviderPlace[];
    readonly enabled: readonly string[];
    readonly activeProvider: string | null;
  },
): ModelDescription {
  const found = findModel(
    ref,
    context.models,
    context.activeProvider,
    context.providers.map((provider) => provider.id),
  );
  const place = context.providers.find((provider) => provider.id === found.provider) ?? null;
  const name = found.model?.label ?? found.modelId;
  const where = place === null ? null : whereItRuns(place);
  if (place !== null && !context.enabled.includes(place.id)) {
    return { name, where, problem: `${place.label} is off` };
  }
  return { name, where, problem: found.model === null ? 'not offered' : null };
}
