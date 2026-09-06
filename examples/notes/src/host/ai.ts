/**
 * The AI layer for this application.
 *
 * Three decisions are on display here, and they are the three every
 * application has to make.
 *
 * *What the model is told.* A description of the application, plus the notes
 * the user is actually looking at, plus whatever a search of their own
 * database turns up. Nothing else.
 *
 * *What the model may do.* Reading the list is a read tool and runs when the
 * model asks. Creating, changing and deleting a note are confirm tools: the
 * user is shown what is about to happen and says yes. The tools come from the
 * contract, so they validate exactly like a call from the browser.
 *
 * *Which providers exist.* Four are compiled in. None is chosen until the user
 * chooses one, and nothing is sent anywhere until they do.
 */
import { anthropic } from 'broapp-ai-anthropic';
import { customServer, ollama, openai } from 'broapp-ai-compatible';
import { createAi, fromContract } from 'broapp/ai/host';
import type { Ai, ContextDocument, ContextRef } from 'broapp/ai/host';
import type { HostApp } from 'broapp/host';

import { contract } from '../shared/contract.ts';
import type { StoreState } from './operations.ts';

/** How much of a note's body a search result shows. */
const SNIPPET_CHARS = 160;

/** `note:12` → `12`. Anything else is not a note reference. */
function noteId(ref: string): number | null {
  const match = /^note:(\d+)$/.exec(ref);
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/** What the model is shown for one note. */
function render(note: {
  title: string;
  body: string;
  done: boolean;
  updatedAt: number;
}): string {
  const status = note.done ? 'done' : 'to do';
  return `Title: ${note.title}\nStatus: ${status}\nUpdated: ${new Date(note.updatedAt).toISOString()}\n\n${note.body}`;
}

/** Build the AI layer for the notes application. */
export function createNotesAi(
  app: HostApp<typeof contract>,
  state: StoreState,
  dataDir: string,
): Ai {
  return createAi({
    dataDir,
    providers: [anthropic(), ollama(), openai(), customServer()],
    app: {
      name: 'Notes',
      purpose:
        "Keeps the user's personal notes in a SQLite database on this computer. Each note has a title, a body, a done flag and timestamps.",
      terminology: ['note', 'done', 'pinned'],
    },
    context: {
      search: (query): Promise<ContextRef[]> => {
        // An unusable database is not an error worth failing a chat turn over:
        // the model simply has nothing to read, and `notes.status` is where the
        // user is told why.
        if (!state.ok) return Promise.resolve([]);
        return Promise.resolve(
          state.store.search(query.text, query.limit).map((note) => ({
            ref: `note:${String(note.id)}`,
            title: note.title,
            snippet: note.body.slice(0, SNIPPET_CHARS),
          })),
        );
      },
      resolve: (refs): Promise<ContextDocument[]> => {
        if (!state.ok) return Promise.resolve([]);
        // A ref the browser sent for a note that has since been deleted, or a
        // ref in a shape this application does not use, is skipped rather than
        // failing the turn.
        const ids = refs.map(noteId).filter((id): id is number => id !== null);
        return Promise.resolve(
          state.store.byIds(ids).map((note) => ({
            ref: `note:${String(note.id)}`,
            title: note.title,
            content: render(note),
          })),
        );
      },
    },
    tools: fromContract(contract, app, {
      read: ['notes.list'],
      // Everything that changes the user's data asks first.
      confirm: ['notes.create', 'notes.update', 'notes.remove'],
    }),
  });
}
