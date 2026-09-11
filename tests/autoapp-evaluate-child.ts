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
 *   bun run tests/autoapp-evaluate-child.ts <launcher root>
 *
 * The root's `launcher/` directory must already hold any lesson the test wants
 * the `learned` condition to carry. Prints `{ rows, markdown, runs }` as JSON.
 */
import { join } from 'node:path';

import { createAi, createFakeAdapter } from 'broapp/ai/host';
import { evaluate, openKnowledge } from 'broapp-autoapp/knowledge';
import { layout } from 'broapp-autoapp/spec';

import { LAUNCHER } from './autoapp-launcher.ts';
import { STARTER, STARTER_VERSIONS } from './autoapp-template.ts';

const noNetwork = Object.assign(() => Promise.reject(new Error('no network in tests')), {
  preconnect: () => undefined,
}) as typeof fetch;

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error('usage: autoapp-evaluate-child.ts <launcher root>');
  const dataDir = join(directory, 'launcher');
  const knowledge = openKnowledge(dataDir);
  try {
    await createAi({ dataDir, providers: [createFakeAdapter()], app: { name: 'test', purpose: 'test' }, fetch: noNetwork }).registry.update({
      provider: 'fake',
      modelId: 'fake-1',
    });
    const runs: string[] = [];
    const { rows, markdown } = await evaluate({
      layout: layout(directory),
      knowledge,
      runs: 1,
      model: () => Promise.resolve(createFakeAdapter().model({ apiKey: null, baseUrl: null, fetch: noNetwork }, 'fake-1')),
      // One edit per run, the same in every workspace: a file of its own under src/.
      providers: (run) => [
        createFakeAdapter({
          script: [
            {
              kind: 'tool',
              name: 'source.change',
              input: { appId: run.appId, message: 'A note', changes: [{ path: 'src/evaluation-note.ts', content: 'export const note = 1;\n' }] },
              then: [{ kind: 'text', chunks: ['done'] }],
            },
          ],
        }),
      ],
      aiDataDir: dataDir,
      execPath: LAUNCHER,
      logger: { warn: () => undefined, error: (line) => console.error(line) },
      notesDir: join(import.meta.dir, '..', 'examples', 'notes'),
      template: STARTER,
      versions: STARTER_VERSIONS,
      fetch: noNetwork,
      turnTimeoutMs: 60_000,
      onRun: (line) => runs.push(line),
    });
    process.stdout.write(JSON.stringify({ rows, markdown, runs }));
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
