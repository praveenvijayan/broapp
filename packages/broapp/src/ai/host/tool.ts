/**
 * What the AI layer can offer a model, and how a confirmation is answered.
 *
 * Kept apart from `create-ai.ts` so that `from-contract.ts` and `run.ts` can
 * share these without either importing the other's module graph.
 */
import type { JsonSchema } from '../../shared/schema.ts';
import type { ToolPermission } from '../shared/types.ts';

/** One thing a model may do. */
export interface AiTool {
  readonly description: string;
  /** JSON Schema for the input. Use `schema.toJsonSchema()` or write it by hand. */
  readonly inputSchema: JsonSchema;
  /** `read` runs immediately; `confirm` asks the user first. */
  readonly permission: ToolPermission;
  execute(input: unknown, signal: AbortSignal): Promise<unknown>;
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
  /** Records relevant to a query. Return refs and short snippets, not full content. */
  search?(query: { text: string; limit: number }, signal: AbortSignal): Promise<ContextRef[]>;
  /** Full content for named refs. Unknown refs are skipped, not errors. */
  resolve?(refs: readonly string[], signal: AbortSignal): Promise<ContextDocument[]>;
}

/**
 * The table a waiting tool call and `ai.chatConfirm` meet in.
 *
 * One per `Ai`, because a confirmation belongs to a run, and a run belongs to
 * a stream that may be one of several open at once.
 */
export interface Confirmations {
  wait(runId: string, callId: string, timeoutMs: number, signal: AbortSignal): Promise<boolean>;
  /** Called by `ai.chatConfirm`. Returns false when nobody is waiting. */
  answer(runId: string, callId: string, approve: boolean): boolean;
}

/** Build the confirmation table. */
export function createConfirmations(): Confirmations {
  const waiting = new Map<string, (approved: boolean) => void>();
  const key = (runId: string, callId: string): string => `${runId} ${callId}`;

  return {
    wait(runId, callId, timeoutMs, signal) {
      const id = key(runId, callId);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (approved: boolean): void => {
          if (settled) return;
          settled = true;
          waiting.delete(id);
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(approved);
        };
        // A question nobody answers is a denial, not a hung stream: the user
        // may have closed the tab, and the tool must not run unattended.
        const timer = setTimeout(() => finish(false), timeoutMs);
        const onAbort = (): void => finish(false);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) finish(false);
        else waiting.set(id, finish);
      });
    },

    answer(runId, callId, approve) {
      const resolve = waiting.get(key(runId, callId));
      if (resolve === undefined) return false;
      resolve(approve);
      return true;
    },
  };
}
