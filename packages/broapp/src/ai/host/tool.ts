/**
 * What the AI layer can offer a model, and how a confirmation is answered.
 *
 * Kept apart from `create-ai.ts` so that `from-contract.ts` and `run.ts` can
 * share these without either importing the other's module graph.
 */
import type { Envelope, Gate } from '../../host/gate.ts';
import type { Effect } from '../../shared/contract.ts';
import type { JsonSchema } from '../../shared/schema.ts';

/** One thing a model may do. */
export interface AiTool {
  readonly description: string;
  /** JSON Schema for the input. Use `schema.toJsonSchema()` or write it by hand. */
  readonly inputSchema: JsonSchema;
  /** What running it does to the world. The gate decides from this and the channel. */
  readonly effect: Effect;
  /**
   * Run it.
   *
   * The envelope comes from the run loop, which built it from what it knows
   * rather than from what the model said. An implementation passes it on; it
   * does not invent one.
   */
  execute(input: unknown, envelope: Envelope, signal: AbortSignal): Promise<unknown>;
}

/**
 * The brand that says a tool's `execute` reaches the gate.
 *
 * A hand-written tool is ordinary host code: nothing about its type says
 * whether it asked anybody before doing what it does. Rather than trust that
 * every application remembers, `createAi` refuses a tool without this symbol,
 * and the only way to get one is {@link guardedTool}, which does the asking.
 */
export const GUARDED: unique symbol = Symbol('broapp.guarded');

/** An {@link AiTool} whose calls are known to pass the gate. */
export interface GuardedTool extends AiTool {
  readonly [GUARDED]: true;
}

/** What {@link guardedTool} needs to know about the thing it is wrapping. */
export interface GuardedToolDefinition {
  /** The tool's name, which is also the route in the gate's records. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly effect: Effect;
  /** The envelope is the run loop's, never the model's; a tool may record it and must not act on its channel. */
  run(input: unknown, signal: AbortSignal, envelope?: Envelope): Promise<unknown>;
}

/**
 * Wrap a hand-written tool so its calls pass the gate.
 *
 * This is the supported way to give a model something an application's
 * contract does not describe — a search over a third-party index, a shell
 * command, a mail send. The wrapping is the whole point: the model's request
 * arrives with the run loop's envelope, the gate decides, and only then does
 * `run` happen.
 */
export function guardedTool(gate: Gate, tool: GuardedToolDefinition): GuardedTool {
  return {
    [GUARDED]: true,
    description: tool.description,
    inputSchema: tool.inputSchema,
    effect: tool.effect,
    execute: (input, envelope) =>
      gate.guard({ ...envelope, route: tool.name, effect: tool.effect, input }, (signal) =>
        tool.run(input, signal, envelope),
      ),
  };
}

/** A record the model may be shown, named but not loaded. */
export interface ContextRef {
  readonly ref: string;
  readonly title: string;
  readonly snippet?: string;
}

/** A record the model is shown in full. */
export interface ContextDocument {
  readonly ref: string;
  readonly title: string;
  readonly content: string;
}

/** Where the model's knowledge of the application's data comes from. */
export interface AiContextProviders {
  /**
   * Records relevant to a query. Return refs and short snippets, not full content.
   *
   * `runId` is the turn asking, so a provider can write down what it offered
   * to which run. It identifies; it grants nothing.
   */
  search?(query: { text: string; limit: number; runId?: string }, signal: AbortSignal): Promise<ContextRef[]>;
  /** Full content for named refs. Unknown refs are skipped, not errors. */
  resolve?(refs: readonly string[], signal: AbortSignal): Promise<ContextDocument[]>;
}
