/**
 * The list of conversations.
 *
 * A thin hook over the seven `ai.threads*` routes. It deliberately does not
 * update optimistically: a write goes to the host and the list is read back,
 * so what a person sees is what is actually stored — including the title the
 * host derived, which the browser cannot predict.
 */
import * as React from 'react';

import type { Thread } from 'broapp/ai';
import { useAiContext } from 'broapp/ai/react';

/** What {@link useAiThreads} returns. */
export interface AiThreadsHook {
  /** Most recently changed first. */
  readonly threads: readonly Thread[];
  readonly loading: boolean;
  /** Set when the last call failed; cleared when the next one succeeds. */
  readonly error: Error | null;
  create(title?: string, modelId?: string | null): Promise<Thread | null>;
  rename(id: string, title: string): Promise<void>;
  /** Null puts the conversation back on whatever Settings says. */
  setModel(id: string, modelId: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  clearAll(): Promise<void>;
  refresh(): Promise<void>;
}

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

export function useAiThreads(): AiThreadsHook {
  const shared = useAiContext();
  const [threads, setThreads] = React.useState<readonly Thread[]>([]);
  // True from the first render, not from the first call: the hook always
  // reads the list in an effect below, and a consumer that decides "there are
  // no conversations, make one" on the render before that would make one for
  // every reload.
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  const client = React.useRef(shared.client);
  client.current = shared.client;

  // A slow listing must not replace one the person is already looking at.
  const generation = React.useRef(0);

  const refresh = React.useCallback(async (): Promise<void> => {
    const mine = (generation.current += 1);
    setLoading(true);
    try {
      const connected = await client.current();
      const result = await connected.call('ai.threadsList', undefined);
      if (generation.current !== mine) return;
      setThreads(result.threads);
      setError(null);
    } catch (cause) {
      if (generation.current !== mine) return;
      setError(asError(cause, 'The conversations could not be read.'));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Run a write, then read the list back. Failures land in `error`. */
  const write = React.useCallback(
    async <T>(action: () => Promise<T>, fallback: string): Promise<T | null> => {
      try {
        const result = await action();
        setError(null);
        await refresh();
        return result;
      } catch (cause) {
        setError(asError(cause, fallback));
        return null;
      }
    },
    [refresh],
  );

  const create = React.useCallback(
    (title?: string, modelId?: string | null): Promise<Thread | null> =>
      write(
        async () => {
          const connected = await client.current();
          return connected.call('ai.threadsCreate', {
            ...(title === undefined ? {} : { title }),
            ...(modelId === undefined ? {} : { modelId }),
          });
        },
        'That conversation could not be started.',
      ),
    [write],
  );

  const rename = React.useCallback(
    async (id: string, title: string): Promise<void> => {
      await write(
        async () => (await client.current()).call('ai.threadsUpdate', { id, title }),
        'That conversation could not be renamed.',
      );
    },
    [write],
  );

  const setModel = React.useCallback(
    async (id: string, modelId: string | null): Promise<void> => {
      await write(
        async () => (await client.current()).call('ai.threadsUpdate', { id, modelId }),
        'That model could not be set.',
      );
    },
    [write],
  );

  const remove = React.useCallback(
    async (id: string): Promise<void> => {
      await write(
        async () => (await client.current()).call('ai.threadsDelete', { id }),
        'That conversation could not be deleted.',
      );
    },
    [write],
  );

  const clearAll = React.useCallback(async (): Promise<void> => {
    await write(
      async () => (await client.current()).call('ai.threadsClear', undefined),
      'The conversations could not be deleted.',
    );
  }, [write]);

  return { threads, loading, error, create, rename, setModel, remove, clearAll, refresh };
}
