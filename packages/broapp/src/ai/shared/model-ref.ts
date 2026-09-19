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
