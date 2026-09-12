/**
 * The applications on this computer, and what each is doing.
 *
 * The card also carries the one way in for somebody who has nothing: **New
 * application** writes one of the two starters the launcher carries inside its
 * binary, installs it, builds it and opens it. That is a route rather than
 * something this page does, because it starts a process and opens a browser tab
 * — and because the address it opens must never reach a page.
 *
 * And the way out. **Remove** opens a confirmation in the table itself rather
 * than a modal, and it does not enable until the person has typed the
 * application's id: a removal is the one action here that a mis-click on the
 * wrong row could make irreversible, and a dialog somebody dismisses by habit
 * is not a decision. Nothing is deleted — the directory moves to the launcher's
 * trash, and the notice afterwards says where.
 *
 * The form is deliberately patient about failure. A creation that could not
 * install stays on screen with what was typed still in it: the workspace is on
 * disk either way, and somebody who has just fixed their network should not
 * have to type the name again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { useOperation } from 'broapp/react';
import { Plus, Trash2 } from 'lucide-react';

import type { LauncherContract } from '../contract.ts';

/** One row, as `launcher.appsList` reports it. */
export interface AppRow {
  appId: string;
  name: string;
  currentRelease: string | null;
  serving: boolean;
  pid: number | null;
  schemaVersion: number | null;
  activationPending: boolean;
}

export interface AppsTableProps {
  readonly apps: readonly AppRow[];
  readonly selected: string | null;
  onSelect(appId: string): void;
  onOpen(appId: string): void;
  onStop(appId: string): void;
  /** A new application exists. The list is stale and the id should be selected. */
  onCreated(appId: string): void;
  /** One is gone. The list is stale and nothing is selected any more. */
  onRemoved(appId: string): void;
}

/** Which starter **New application** writes, and how each is described. */
const TEMPLATES = [
  { id: 'starter', label: 'Items list', hint: 'a table and a form to start from' },
  {
    id: 'blank',
    label: 'Blank',
    hint: 'one empty page; describe what it should do to the engineer',
  },
] as const;

/** One of the two. Kept narrow so the route's input is not widened by a cast. */
type TemplateChoice = (typeof TEMPLATES)[number]['id'];

/** The same bounds the contract puts on the route's input. */
const MAX_ID = 40;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 400;

/**
 * An id from a name: lowercase, one hyphen between words, starting with a
 * letter.
 *
 * Suggested rather than imposed — the field stays editable, and the host
 * validates whatever arrives against the same pattern every path uses.
 */
export function idFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID);
  if (slug === '') return '';
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`.slice(0, MAX_ID);
}

export function AppsTable({
  apps,
  selected,
  onSelect,
  onOpen,
  onStop,
  onCreated,
  onRemoved,
}: AppsTableProps): ReactElement {
  const create = useOperation<LauncherContract, 'launcher.appCreate'>('launcher.appCreate');
  const remove = useOperation<LauncherContract, 'launcher.appRemove'>('launcher.appRemove');

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [appId, setAppId] = useState('');
  const [touchedId, setTouchedId] = useState(false);
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<TemplateChoice>('starter');
  /** The application whose confirmation is open, if any, and what has been typed into it. */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [typedId, setTypedId] = useState('');
  /** What the last removal moved, so the notice outlives the call that returned it. */
  const [removed, setRemoved] = useState<{ appId: string; trashPath: string } | null>(null);
  // Remembered rather than read from `create.data`, which is cleared as soon
  // as a creation succeeds so that a second one starts from nothing.
  const [notOpened, setNotOpened] = useState(false);

  // The button that opened the form, so closing it can hand focus back — the
  // same shape `App.tsx` uses for Settings.
  const opener = useRef<HTMLButtonElement | null>(null);
  const nameField = useRef<HTMLInputElement | null>(null);
  /** The id the running call was made with, for when it comes back. */
  const submitted = useRef('');

  const close = useCallback((): void => {
    setFormOpen(false);
    const previous = opener.current;
    if (previous !== null && previous.isConnected) previous.focus();
  }, []);

  useEffect(() => {
    if (!formOpen) return undefined;
    nameField.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [formOpen, close]);

  const { data: created, reset: resetCreate } = create;
  useEffect(() => {
    if (created === null || !created.ok) return;
    const madeId = submitted.current;
    setNotOpened(!created.opened);
    resetCreate();
    setName('');
    setAppId('');
    setTouchedId(false);
    setDescription('');
    setFormOpen(false);
    onCreated(madeId);
  }, [created, resetCreate, onCreated]);

  const { data: receipt, reset: resetRemove } = remove;
  useEffect(() => {
    if (receipt === null) return;
    setRemoved({ appId: receipt.appId, trashPath: receipt.trashPath });
    resetRemove();
    setRemovingId(null);
    setTypedId('');
    onRemoved(receipt.appId);
  }, [receipt, resetRemove, onRemoved]);

  /** Open, close or move the confirmation, always with an empty field. */
  const confirmRemoval = (appId: string | null): void => {
    setRemovingId(appId);
    setTypedId('');
    remove.reset();
  };

  const chooseName = (value: string): void => {
    setName(value);
    if (!touchedId) setAppId(idFromName(value));
  };

  const submit = (): void => {
    submitted.current = appId;
    setNotOpened(false);
    void create.run({
      appId,
      name,
      template,
      ...(description.trim() === '' ? {} : { description: description.trim() }),
    });
  };

  // A refusal about the id belongs under the id field; anything else is about
  // the creation as a whole.
  const aboutId =
    create.error !== null && (create.error.code === 'conflict' || create.error.code === 'invalid_input')
      ? create.error.message
      : null;
  const failure = create.data !== null && !create.data.ok ? create.data : null;

  return (
    <section className="launcher__card" aria-labelledby="apps-heading">
      <div className="launcher__card-header">
        <h2 className="launcher__card-title" id="apps-heading">
          Applications
        </h2>
        <button
          aria-expanded={formOpen}
          className="launcher__button launcher__button--small"
          onClick={(event) => {
            opener.current = event.currentTarget;
            if (formOpen) close();
            else setFormOpen(true);
          }}
          type="button"
        >
          <Plus aria-hidden="true" size={14} /> New application
        </button>
      </div>

      {formOpen && (
        <form
          className="launcher__form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset className="launcher__choice">
            <legend>Start from</legend>
            {TEMPLATES.map((option) => (
              <label className="launcher__choice-option" key={option.id}>
                <input
                  checked={template === option.id}
                  name="template"
                  onChange={() => setTemplate(option.id)}
                  type="radio"
                  value={option.id}
                />
                <span>
                  <strong>{option.label}</strong> — {option.hint}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="launcher__field">
            <span>Name</span>
            <input
              className="launcher__input"
              maxLength={MAX_NAME}
              onChange={(event) => chooseName(event.target.value)}
              ref={nameField}
              required
              type="text"
              value={name}
            />
          </label>
          <label className="launcher__field">
            <span>Id</span>
            <input
              className="launcher__input"
              maxLength={MAX_ID}
              onChange={(event) => {
                setTouchedId(true);
                setAppId(event.target.value);
              }}
              required
              type="text"
              value={appId}
            />
          </label>
          {aboutId !== null && (
            <p className="launcher__message launcher__message--error" role="alert">
              {aboutId}
            </p>
          )}
          <label className="launcher__field">
            <span>Description</span>
            <input
              className="launcher__input"
              maxLength={MAX_DESCRIPTION}
              onChange={(event) => setDescription(event.target.value)}
              type="text"
              value={description}
            />
          </label>
          <div className="launcher__row-actions">
            <button className="launcher__button" disabled={create.pending} type="submit">
              {create.pending ? 'Creating…' : 'Create'}
            </button>
            <button
              className="launcher__button launcher__button--small"
              onClick={close}
              type="button"
            >
              Cancel
            </button>
          </div>
          {create.pending && (
            <p className="launcher__lede">
              Installing dependencies and building. This can take a minute the first time.
            </p>
          )}
          {create.error !== null && aboutId === null && (
            <p className="launcher__message launcher__message--error" role="alert">
              {create.error.message}
            </p>
          )}
          {failure !== null && (
            <div className="launcher__message launcher__message--error" role="alert">
              {failure.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <ul>
                {failure.problems.map((problem) => (
                  <li key={`${problem.stage}:${problem.message}`}>
                    <strong>{problem.stage}</strong>: {problem.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
      )}

      {notOpened && (
        <p className="launcher__message launcher__message--error" role="alert">
          The application is running, but no browser could be opened. Its address is printed in
          the terminal the launcher runs in.
        </p>
      )}

      {removed !== null && (
        <p className="launcher__message" role="status">
          {removed.appId} was moved to <code>{removed.trashPath}</code> inside the launcher’s
          directory. Nothing was deleted.
        </p>
      )}

      <table className="launcher__table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Release</th>
            <th>Running</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {apps.length === 0 ? (
            <tr>
              <td className="launcher__empty" colSpan={4}>
                No applications yet. Create one above, or import a workspace with{' '}
                <code>broapp-autoapp import</code>.
              </td>
            </tr>
          ) : (
            apps.flatMap((app) => [
              <tr
                key={app.appId}
                className={app.appId === selected ? 'launcher__row launcher__row--selected' : 'launcher__row'}
                onClick={() => onSelect(app.appId)}
              >
                <td>
                  {app.name}
                  {app.activationPending && (
                    <span className="launcher__badge" title="An update was interrupted">
                      unfinished update
                    </span>
                  )}
                </td>
                <td>
                  <code>{app.currentRelease?.slice(0, 8) ?? 'none'}</code>
                  {app.schemaVersion === null ? '' : ` · schema ${String(app.schemaVersion)}`}
                </td>
                <td>{app.serving ? `yes (pid ${String(app.pid ?? 0)})` : 'no'}</td>
                <td className="launcher__row-actions">
                  <button
                    className="launcher__button"
                    type="button"
                    disabled={app.currentRelease === null}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(app.appId);
                    }}
                  >
                    Open
                  </button>
                  <button
                    className="launcher__button launcher__button--small"
                    type="button"
                    disabled={!app.serving}
                    onClick={(event) => {
                      event.stopPropagation();
                      onStop(app.appId);
                    }}
                  >
                    Stop
                  </button>
                  <button
                    aria-expanded={removingId === app.appId}
                    className="launcher__button launcher__button--small"
                    type="button"
                    // Disabled with the reason on it rather than hidden: a
                    // person looking for this needs to be told why it is not
                    // available, not left wondering where it went.
                    disabled={app.serving}
                    title={app.serving ? 'Stop it first' : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      confirmRemoval(removingId === app.appId ? null : app.appId);
                    }}
                  >
                    <Trash2 aria-hidden="true" size={13} /> Remove
                  </button>
                </td>
              </tr>,
              ...(removingId === app.appId
                ? [
                    <tr key={`${app.appId}-confirm`}>
                      <td colSpan={4}>
                        <form
                          className="launcher__form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void remove.run({ appId: app.appId, confirm: typedId });
                          }}
                        >
                          <p className="launcher__lede">
                            Everything belonging to <strong>{app.name}</strong> — its releases,
                            its source workspace, its data and its snapshots — moves to the
                            launcher’s trash. Nothing is deleted, and the launcher never empties
                            the trash. A running preview is stopped.
                          </p>
                          <label className="launcher__field">
                            <span>
                              Type <code>{app.appId}</code> to confirm
                            </span>
                            <input
                              autoFocus
                              className="launcher__input"
                              maxLength={MAX_ID}
                              onChange={(event) => setTypedId(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              type="text"
                              value={typedId}
                            />
                          </label>
                          <div className="launcher__row-actions">
                            <button
                              className="launcher__button launcher__button--danger"
                              // Enabled only by the id itself: this is the
                              // whole confirmation, and a button that could be
                              // reached without typing it would not be one.
                              disabled={typedId !== app.appId || remove.pending}
                              type="submit"
                            >
                              {remove.pending ? 'Removing…' : 'Remove'}
                            </button>
                            <button
                              className="launcher__button launcher__button--small"
                              onClick={(event) => {
                                event.stopPropagation();
                                confirmRemoval(null);
                              }}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                          {remove.error !== null && (
                            <p className="launcher__message launcher__message--error" role="alert">
                              {remove.error.message}
                            </p>
                          )}
                        </form>
                      </td>
                    </tr>,
                  ]
                : []),
            ])
          )}
        </tbody>
      </table>
    </section>
  );
}
