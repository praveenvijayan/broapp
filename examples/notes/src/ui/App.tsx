/**
 * Notes.
 *
 * A list, a form, and a status panel. Every mutation refetches the list rather
 * than patching local state optimistically: this is a local application talking
 * to a process on the same machine, the round trip is sub-millisecond, and an
 * optimistic update that diverges from the database is a bug users cannot
 * explain.
 */
import { useCallback, useEffect, useState } from 'react';
import { useConnection, useOperation } from 'broapp/react';

import { ConnectionBadge } from './ConnectionBadge.tsx';
import { NoteEditor } from './NoteEditor.tsx';
import { StatusPanel } from './StatusPanel.tsx';
import type { AppContract } from '../shared/types.ts';

type Filter = 'all' | 'open' | 'done';

export function App(): React.ReactElement {
  const connection = useConnection();
  const ready = connection.phase === 'ready';

  const list = useOperation<AppContract, 'notes.list'>('notes.list');
  const create = useOperation<AppContract, 'notes.create'>('notes.create');
  const update = useOperation<AppContract, 'notes.update'>('notes.update');
  const remove = useOperation<AppContract, 'notes.remove'>('notes.remove');
  const status = useOperation<AppContract, 'notes.status'>('notes.status');

  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<number | null>(null);

  const { run: runList } = list;
  const { run: runStatus } = status;

  const refresh = useCallback(
    (next: Filter = filter) => {
      void runList({ done: next === 'all' ? null : next === 'done' });
      void runStatus(undefined);
    },
    [filter, runList, runStatus],
  );

  useEffect(() => {
    if (ready) refresh();
    // Refetch when the connection comes back, so a tab that was disconnected
    // does not sit on a stale list.
  }, [ready, refresh]);

  const notes = list.data?.notes ?? [];
  const unhealthy = status.data?.healthy === false;

  async function submit(input: { title: string; body: string }): Promise<void> {
    await create.run(input);
    refresh();
  }

  async function save(note: { id: number; title: string; body: string; done: boolean }): Promise<void> {
    await update.run(note);
    setEditing(null);
    refresh();
  }

  async function toggle(note: { id: number; title: string; body: string; done: boolean }): Promise<void> {
    await update.run({ ...note, done: !note.done });
    refresh();
  }

  async function destroy(id: number): Promise<void> {
    await remove.run({ id });
    refresh();
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">Notes</h1>
          <p className="app__lede">
            Kept in a SQLite database on this computer. Nothing leaves it.
          </p>
        </div>
        <ConnectionBadge />
      </header>

      <main className="app__main">
        {unhealthy && (
          <p className="message message--error" role="alert">
            The notes database could not be opened, so nothing can be saved. Its location is in the
            details below — move that file aside and restart to begin with an empty one.
          </p>
        )}

        <section className="card" aria-labelledby="new-heading">
          <h2 className="card__title" id="new-heading">
            New note
          </h2>
          <NoteEditor
            key="new"
            submitLabel="Add note"
            pending={create.pending}
            error={create.error?.message ?? null}
            onSubmit={submit}
          />
        </section>

        <section className="card" aria-labelledby="list-heading">
          <header className="card__head">
            <h2 className="card__title" id="list-heading">
              {notes.length === 0 ? 'No notes yet' : `${String(notes.length)} note${notes.length === 1 ? '' : 's'}`}
            </h2>
            <div className="segmented" role="group" aria-label="Filter notes">
              {(['all', 'open', 'done'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="segmented__button"
                  aria-pressed={filter === option}
                  onClick={() => {
                    setFilter(option);
                    refresh(option);
                  }}
                >
                  {option === 'all' ? 'All' : option === 'open' ? 'To do' : 'Done'}
                </button>
              ))}
            </div>
          </header>

          {list.error !== null && <p className="message message--error">{list.error.message}</p>}

          <ul className="notes">
            {notes.map((note) =>
              editing === note.id ? (
                <li className="notes__item notes__item--editing" key={note.id}>
                  <NoteEditor
                    submitLabel="Save"
                    initial={{ title: note.title, body: note.body }}
                    pending={update.pending}
                    error={update.error?.message ?? null}
                    onSubmit={(input) => save({ ...input, id: note.id, done: note.done })}
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <li className="notes__item" key={note.id}>
                  <label className="notes__check">
                    <input
                      type="checkbox"
                      checked={note.done}
                      onChange={() => void toggle(note)}
                      aria-label={`Mark "${note.title}" as ${note.done ? 'not done' : 'done'}`}
                    />
                  </label>
                  <div className="notes__content">
                    <h3 className={note.done ? 'notes__title notes__title--done' : 'notes__title'}>
                      {note.title}
                    </h3>
                    {note.body !== '' && <p className="notes__body">{note.body}</p>}
                    <p className="notes__meta">
                      Updated {new Date(note.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="notes__actions">
                    <button className="button button--small" type="button" onClick={() => setEditing(note.id)}>
                      Edit
                    </button>
                    <button
                      className="button button--small button--danger"
                      type="button"
                      onClick={() => void destroy(note.id)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        </section>
      </main>

      <footer className="app__footer">
        <StatusPanel status={status} onBackedUp={() => refresh()} />
      </footer>
    </div>
  );
}
