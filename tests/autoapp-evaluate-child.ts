/**
 * `evaluate()` on the fake adapter, in a process of its own.
 *
 * `tests/autoapp-knowledge.test.ts` runs this as a child rather than calling
 * `evaluate()` itself, because `bun test tests` — the filter form the gate and
 * CI use — resolves differently from `bun test ./tests/…` and from `bun run`.
 * Under a filter, a bundle of Notes' host cannot resolve the provider packages
 * its adapters import (the `@ai-sdk` packages, installed beside the `broapp-ai-`
 * packages rather than at the root), and
 * the same build passes in a path-mode test and in a plain process. Notes is
 * one of the evaluation's tasks, so the evaluation runs here and the test
 * reads the rows it prints.
 *
 *   bun run tests/autoapp-evaluate-child.ts <launcher root> [two-turn]
 *
 * Without a mode it runs the single-turn tasks under every condition, one edit
 * a run. `two-turn` runs the starter's two-turn task under `baseline` and the
 * restart condition, with a script whose second turn re-reads what the first
 * read and re-applies the first's hunk under text history, and only re-applies
 * it under structured history.
 *
 * The root's `launcher/` directory must already hold any lesson the test wants
 * the `learned` condition to carry. Prints `{ rows, markdown, runs, prompts }`
 * as JSON; `prompts` holds every prompt each fake model was given, by run label.
 */
import { join } from 'node:path';

import { createAi, createFakeAdapter } from 'broapp/ai/host';
import type { FakeStep } from 'broapp/ai/host';
import { CONDITIONS, EVALUATION_TASKS, evaluate, openKnowledge, RESTART_CONDITION } from 'broapp-autoapp/knowledge';
import { layout } from 'broapp-autoapp/spec';

import { LAUNCHER } from './autoapp-launcher.ts';
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';

const noNetwork = Object.assign(() => Promise.reject(new Error('no network in tests')), {
  preconnect: () => undefined,
}) as typeof fetch;

/** The hunk turn one applies, and turn two applies again: its `replace` keeps its `find`, so both match. */
const HUNK = {
  path: 'src/host/app.ts',
  find: "app.operation('items.remove', ({ id }) => ({ removed: store.remove(id) }));",
  replace: "app.operation('items.remove', ({ id }) => ({ removed: store.remove(id) })); // kept",
};

/** A step that calls one tool, then carries on with `then`. */
function call(name: string, input: unknown, then: readonly FakeStep[]): FakeStep {
  return { kind: 'tool', name, input, then };
}

/** The two-turn script: turn one reads and edits (and is stopped there), then turn two. */
function twoTurnScript(appId: string, history: string | undefined, turn: 1 | 2 | undefined): FakeStep[] {
  const edit = (then: readonly FakeStep[]): FakeStep => call('source.edit', { appId, message: 'Keep remove', hunks: [HUNK] }, then);
  const done: FakeStep = { kind: 'text', chunks: ['done'] };
  const second: FakeStep[] =
    history === 'text'
      ? [call('source.read', { appId, path: 'src/shared/contract.ts' }, [edit([done])])]
      : [edit([done])];
  // A restarted launcher opens a fresh tab for turn two, so its model starts at turn two.
  if (turn === 2) return second;
  return [call('source.read', { appId, path: 'src/shared/contract.ts' }, [edit(second)])];
}

async function main(): Promise<void> {
  const directory = process.argv[2];
  const mode = process.argv[3];
  if (directory === undefined) throw new Error('usage: autoapp-evaluate-child.ts <launcher root> [two-turn]');
  const dataDir = join(directory, 'launcher');
  const knowledge = openKnowledge(dataDir);
  try {
    await createAi({ dataDir, providers: [createFakeAdapter()], app: { name: 'test', purpose: 'test' }, fetch: noNetwork }).registry.update({
      provider: 'fake',
      modelId: 'fake-1',
    });
    const runs: string[] = [];
    const prompts: Record<string, unknown[]> = {};
    const twoTurn = mode === 'two-turn';
    const { rows, markdown } = await evaluate({
      layout: layout(directory),
      knowledge,
      runs: 1,
      tasks: twoTurn
        ? EVALUATION_TASKS.filter((task) => task.id === 'starter-priority')
        : EVALUATION_TASKS.filter((task) => task.turns !== 2),
      conditions: twoTurn ? ['baseline', RESTART_CONDITION] : CONDITIONS,
      model: () => Promise.resolve(createFakeAdapter().model({ apiKey: null, baseUrl: null, fetch: noNetwork }, 'fake-1')),
      providers: (run) => {
        const adapter = createFakeAdapter({
          script: twoTurn
            ? twoTurnScript(run.appId, run.history, run.restart === true ? run.turn : undefined)
            : [
                // One edit per run, the same in every workspace: a file of its own under src/.
                {
                  kind: 'tool',
                  name: 'source.change',
                  input: { appId: run.appId, message: 'A note', changes: [{ path: 'src/evaluation-note.ts', content: 'export const note = 1;\n' }] },
                  then: [{ kind: 'text', chunks: ['done'] }],
                },
              ],
        });
        prompts[`${run.label}/${run.history ?? '-'}${run.restart === true ? '/restart' : ''}/${String(run.turn ?? '-')}`] = adapter.calls as unknown[];
        return [adapter];
      },
      aiDataDir: dataDir,
      execPath: LAUNCHER,
      logger: { warn: () => undefined, error: (line) => console.error(line) },
      notesDir: join(import.meta.dir, '..', 'examples', 'notes'),
      templates: TEMPLATES,
      versions: STARTER_VERSIONS,
      fetch: noNetwork,
      turnTimeoutMs: 60_000,
      onRun: (line) => runs.push(line),
    });
    process.stdout.write(JSON.stringify({ rows, markdown, runs, prompts }));
  } finally {
    knowledge.close();
  }
}

main().then(
  () => process.exit(0),
  (cause: unknown) => {
    console.error(String(cause instanceof Error ? (cause.stack ?? cause.message) : cause));
    process.exit(1);
  },
);
