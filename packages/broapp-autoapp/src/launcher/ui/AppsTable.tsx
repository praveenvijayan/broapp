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
 *
 * Where a project lives (19b) is one quiet group in that form: the launcher's
 * own folder unless the person chooses one, with the system's folder window or
 * a typed path. What the form knows is kept in `new-application.ts`, where the
 * order answers arrive in can be tested; this file draws it. Every sentence
 * about a folder comes from `location-words.ts`, the module the host, the
 * command line and the engineer's tools say them from.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement, RefObject } from 'react';

import { useBroapp, useBroappReady, useOperation } from 'broapp/react';
import type { BroappClient } from 'broapp/client';
import { Plus, Trash2 } from 'lucide-react';

import type { LauncherContract } from '../contract.ts';
import { LOCATION_WORDS, workspaceSentence } from '../location-words.ts';
import type { WorkspaceState } from '../location-words.ts';

import { AppIcon } from './AppIcon.tsx';
import {
  createLocateControl,
  createNewApplicationForm,
  idFromName as suggestId,
  LAST_LOCATION_KEY,
  legalId,
  locationOf,
  MAX_LOCATION,
  type FocusRequest,
  type LocateControl,
  type LocateState,
  type NewApplicationForm,
  type NewApplicationState,
  type TemplateChoice,
  type WhereState,
} from './new-application.ts';
import { remember, rememberedText } from './storage.ts';

/** One row, as `launcher.appsList` reports it. */
export interface AppRow {
  appId: string;
  name: string;
  currentRelease: string | null;
  serving: boolean;
  pid: number | null;
  schemaVersion: number | null;
  activationPending: boolean;
  /** Where its workspace is. Absent from a list read before 19a, which is the launcher's own folder. */
  workspace?: { chosen: boolean; dir: string | null; state: WorkspaceState };
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
  /** A workspace was said to be somewhere else. The list is stale. */
  onLocated?(appId: string): void;
}

/** Which starter **New application** writes, and how each is described. */
const TEMPLATES = [
  { id: 'starter', label: 'Items list', hint: 'a table and a form to start from' },
  {
    id: 'blank',
    label: 'Blank',
    hint: 'one empty page; describe what it should do to the engineer',
  },
] as const satisfies readonly { id: TemplateChoice; label: string; hint: string }[];

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
  return suggestId(name, MAX_ID);
}

/** Whether the person is on Windows, for the example path under the typed field. */
function onWindows(): boolean {
  return typeof navigator !== 'undefined' && /^win/i.test(navigator.platform);
}

/** The client, whenever the call is made: a click during the first second of startup should run, not fail. */
function useClient(): () => Promise<BroappClient<LauncherContract>> {
  const client = useBroapp<LauncherContract>();
  const ready = useBroappReady<LauncherContract>();
  const latest = useRef({ client, ready });
  latest.current = { client, ready };
  return useCallback(async () => latest.current.client ?? (await latest.current.ready), []);
}

/** Move the keyboard where a change asked for it, once per request. */
function useFocus(request: FocusRequest | null, targets: { choose: RefObject<HTMLButtonElement | null>; field: RefObject<HTMLInputElement | null> }): void {
  const { choose, field } = targets;
  useEffect(() => {
    if (request === null) return undefined;
    const move = (): void => {
      const element = request.on === 'choose' ? choose.current : field.current;
      element?.focus();
    };
    move();
    // The system's folder window takes the focus away from the page. When it
    // closes, the browser puts focus back where it was when the page lost it —
    // the body, since the button was disabled — after this has run. So once
    // the page is given focus again, the request is carried out again.
    if (typeof document === 'undefined' || document.hasFocus()) return undefined;
    window.addEventListener('focus', move, { once: true });
    return () => window.removeEventListener('focus', move);
  }, [request, choose, field]);
}

export interface WhereItLivesProps {
  readonly where: WhereState;
  readonly appId: string;
  readonly windows: boolean;
  onChoose(): void;
  onShowTyping(): void;
  onType(text: string): void;
  onUseDefault(): void;
  readonly chooseRef?: RefObject<HTMLButtonElement | null>;
  readonly fieldRef?: RefObject<HTMLInputElement | null>;
}

/** Ids the group's parts are tied together by. One form is open at a time, so they are fixed. */
const WHERE_IDS = {
  status: 'new-app-where-status',
  hint: 'new-app-where-hint',
  problem: 'new-app-where-problem',
  field: 'new-app-where-field',
} as const;

/**
 * **Where it lives**: the launcher's own folder, said in words and never as a
 * path, until the person chooses or types one; then where the project will be
 * made, as the host resolved it.
 */
export function WhereItLives({
  where,
  appId,
  windows,
  onChoose,
  onShowTyping,
  onType,
  onUseDefault,
  chooseRef,
  fieldRef,
}: WhereItLivesProps): ReactElement {
  const location = locationOf(where);
  const withWindow = where.dialog === 'available';
  const describedBy = [where.typing ? WHERE_IDS.hint : '', where.problem === null ? '' : WHERE_IDS.problem]
    .filter((id) => id !== '')
    .join(' ');
  return (
    <fieldset className="launcher__choice launcher__where" {...(where.problem === null ? {} : { 'aria-describedby': WHERE_IDS.problem })}>
      <legend>Where it lives</legend>
      {location === undefined ? (
        <p className="launcher__where-place">{LOCATION_WORDS.defaultPlace()}</p>
      ) : where.target !== null && legalId(appId) ? (
        <p className="launcher__where-place">
          {LOCATION_WORDS.willBeMadeAt()} <code className="launcher__path">{where.target}</code>
        </p>
      ) : (
        <p className="launcher__where-place launcher__path">{LOCATION_WORDS.willBeMadeInside(location)}</p>
      )}
      {withWindow && (
        <div className="launcher__where-actions">
          <button
            className="launcher__button launcher__button--small"
            disabled={where.choosing}
            onClick={onChoose}
            ref={chooseRef}
            type="button"
            {...(where.problem === null || where.typing ? {} : { 'aria-describedby': WHERE_IDS.problem })}
          >
            Choose a folder…
          </button>
          <span aria-live="polite" className="launcher__where-status" id={WHERE_IDS.status}>
            {where.choosing ? LOCATION_WORDS.folderWindowStatus() : (where.status ?? '')}
          </span>
        </div>
      )}
      {withWindow && !where.typing && (
        <button className="launcher__k-link launcher__where-link" onClick={onShowTyping} type="button">
          Type a path instead
        </button>
      )}
      {where.typing && (
        <label className="launcher__field">
          <span>Folder</span>
          <input
            {...(describedBy === '' ? {} : { 'aria-describedby': describedBy })}
            aria-invalid={where.problem === null ? undefined : true}
            className="launcher__input"
            id={WHERE_IDS.field}
            maxLength={MAX_LOCATION}
            onChange={(event) => onType(event.target.value)}
            ref={fieldRef}
            spellCheck={false}
            type="text"
            value={where.value}
          />
        </label>
      )}
      {where.typing && (
        <p className="launcher__lede" id={WHERE_IDS.hint}>
          {LOCATION_WORDS.typedHint(windows)}
        </p>
      )}
      {where.problem !== null && (
        <p className="launcher__message launcher__message--error" id={WHERE_IDS.problem} role="alert">
          {where.problem}
        </p>
      )}
      {location !== undefined && (
        <div className="launcher__where-actions">
          <button className="launcher__button launcher__button--small" onClick={onUseDefault} type="button">
            Use the default
          </button>
        </div>
      )}
      {location === undefined && withWindow && <p className="launcher__lede">{LOCATION_WORDS.chooseHint()}</p>}
    </fieldset>
  );
}

export interface WorkspaceLineProps {
  readonly app: AppRow;
  readonly locate: LocateState;
  onLocate(): void;
  onType(text: string): void;
  onSet(): void;
  onCancel(): void;
  readonly windows: boolean;
}

/**
 * Under a row whose workspace the person chose: where it is, or — when it is
 * not there — what happened, in words, and **Locate…**. `null` for a workspace
 * in the launcher's own folder, whose row is exactly as it was.
 */
export function WorkspaceLine({ app, locate, onLocate, onType, onSet, onCancel, windows }: WorkspaceLineProps): ReactElement | null {
  const workspace = app.workspace;
  if (workspace === undefined || !workspace.chosen) return null;
  if (workspace.state === 'present' && workspace.dir !== null) {
    return (
      <p className="launcher__lede launcher__path" title={workspace.dir}>
        {workspace.dir}
      </p>
    );
  }
  const sentence = workspaceSentence({ state: workspace.state, appId: app.appId, name: app.name, dir: workspace.dir });
  const mine = locate.appId === app.appId;
  const fieldId = `locate-${app.appId}`;
  return (
    <div className="launcher__where-row">
      <p className="launcher__message launcher__message--warn launcher__path">{sentence}</p>
      {!(mine && locate.typing) && (
        <div className="launcher__where-actions">
          <button
            className="launcher__button launcher__button--small"
            disabled={mine && (locate.choosing || locate.posting)}
            onClick={(event) => {
              event.stopPropagation();
              onLocate();
            }}
            type="button"
          >
            Locate…
          </button>
          <span aria-live="polite" className="launcher__where-status">
            {mine && locate.choosing ? LOCATION_WORDS.folderWindowStatus() : ''}
          </span>
        </div>
      )}
      {mine && locate.typing && (
        <form
          className="launcher__where-locate"
          onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            onSet();
          }}
        >
          <label className="launcher__field" htmlFor={fieldId}>
            <span>Folder</span>
          </label>
          <input
            aria-describedby={`${fieldId}-hint`}
            autoFocus
            className="launcher__input"
            id={fieldId}
            maxLength={MAX_LOCATION}
            onChange={(event) => onType(event.target.value)}
            spellCheck={false}
            type="text"
            value={locate.typed}
          />
          <p className="launcher__lede" id={`${fieldId}-hint`}>
            {LOCATION_WORDS.typedHint(windows)}
          </p>
          <div className="launcher__row-actions">
            <button className="launcher__button launcher__button--small" disabled={locate.posting} type="submit">
              Set
            </button>
            <button className="launcher__button launcher__button--small" onClick={onCancel} type="button">
              Cancel
            </button>
          </div>
        </form>
      )}
      {mine && locate.error !== null && (
        <p className="launcher__message launcher__message--error" role="alert">
          {locate.error}
        </p>
      )}
    </div>
  );
}

/**
 * What the confirmation says will happen, before the id is typed. For a
 * workspace in the launcher's own folder it is word for word what it said
 * before 19b; a chosen one is said to stay where it is, because it does.
 */
export function RemovalWords({ app }: { readonly app: AppRow }): ReactElement {
  const workspace = app.workspace;
  if (workspace === undefined || !workspace.chosen) {
    return (
      <p className="launcher__lede">
        Everything belonging to <strong>{app.name}</strong> — its releases, its source workspace, its data and
        its snapshots — moves to the launcher’s trash. Nothing is deleted, and the launcher never empties the
        trash. A running preview is stopped.
      </p>
    );
  }
  const dir = workspace.dir ?? app.appId;
  return (
    <>
      <p className="launcher__lede">
        Everything belonging to <strong>{app.name}</strong> — its releases, its data and its snapshots — moves
        to the launcher’s trash. Nothing is deleted, and the launcher never empties the trash. A running preview
        is stopped.
      </p>
      <p className="launcher__lede launcher__path">
        {workspace.state === 'present' ? LOCATION_WORDS.removalWillLeave(dir) : LOCATION_WORDS.removalCannotFind(dir)}
      </p>
    </>
  );
}

/** What a removal left, as the receipt says. */
export interface RemovedReceipt {
  readonly appId: string;
  readonly trashPath: string;
  readonly hadSource: boolean;
  readonly workspaceLeftAt: string | null;
}

/** The line after a removal: where it went, and — for a workspace the person chose — that it stayed. */
export function RemovedNotice({ removed }: { readonly removed: RemovedReceipt }): ReactElement {
  const left = removed.workspaceLeftAt;
  return (
    <p className={left === null ? 'launcher__message' : 'launcher__message launcher__path'} role="status">
      {removed.appId} was moved to <code>{removed.trashPath}</code> inside the launcher’s directory. Nothing was
      deleted.
      {left === null ? null : ` ${removed.hadSource ? LOCATION_WORDS.removalLeft(left) : LOCATION_WORDS.removalMissing(left)}`}
    </p>
  );
}

/**
 * A creation that ran and could not finish. The workspace exists by then, so
 * the notes — the first of them saying where it was made, when a folder was
 * chosen — come first: they say where to look.
 */
export function CreationFailure({ failure }: { readonly failure: NonNullable<NewApplicationState['failure']> }): ReactElement {
  return (
    <div className="launcher__message launcher__message--error launcher__path" role="alert">
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
  );
}

/** One of the page's controllers, as React state. */
function useControlled<T>(control: { get(): T; subscribe(listener: () => void): () => void }): T {
  return useSyncExternalStore(control.subscribe, control.get, control.get);
}

export function AppsTable({
  apps,
  selected,
  onSelect,
  onOpen,
  onStop,
  onCreated,
  onRemoved,
  onLocated,
}: AppsTableProps): ReactElement {
  const remove = useOperation<LauncherContract, 'launcher.appRemove'>('launcher.appRemove');
  const connected = useClient();
  const windows = onWindows();

  // Made once. The routes are reached through `connected`, which always has
  // the newest client, so the controllers never hold a stale one.
  const formRef = useRef<NewApplicationForm | null>(null);
  formRef.current ??= createNewApplicationForm({
    ops: {
      create: async (input) => await (await connected()).call('launcher.appCreate', input),
      check: async (input) => await (await connected()).call('launcher.locationCheck', input),
      choose: async (input) => await (await connected()).call('launcher.folderChoose', input),
    },
    last: {
      read: () => rememberedText(LAST_LOCATION_KEY, MAX_LOCATION),
      write: (value) => remember(LAST_LOCATION_KEY, value),
    },
  });
  const form = formRef.current;
  const state: NewApplicationState = useControlled(form);

  const locatedRef = useRef(onLocated);
  locatedRef.current = onLocated;
  const locateRef = useRef<LocateControl | null>(null);
  locateRef.current ??= createLocateControl(
    {
      choose: async (input) => await (await connected()).call('launcher.folderChoose', input),
      locate: async (input) => await (await connected()).call('launcher.appLocate', input),
    },
    (appId) => locatedRef.current?.(appId),
  );
  const locate = locateRef.current;
  const locating = useControlled(locate);

  const [formOpen, setFormOpen] = useState(false);
  /** The application whose confirmation is open, if any, and what has been typed into it. */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [typedId, setTypedId] = useState('');
  /** What the last removal moved, so the notice outlives the call that returned it. */
  const [removed, setRemoved] = useState<RemovedReceipt | null>(null);
  // Remembered rather than read from the form, which starts again from nothing
  // as soon as a creation succeeds.
  const [notOpened, setNotOpened] = useState(false);
  /** Where a creation into a chosen folder put the workspace, once the form has closed over it. */
  const [madeAt, setMadeAt] = useState<{ appId: string; note: string } | null>(null);

  // The button that opened the form, so closing it can hand focus back — the
  // same shape `App.tsx` uses for Settings.
  const opener = useRef<HTMLButtonElement | null>(null);
  const nameField = useRef<HTMLInputElement | null>(null);
  const chooseButton = useRef<HTMLButtonElement | null>(null);
  const locationField = useRef<HTMLInputElement | null>(null);
  useFocus(state.focus, { choose: chooseButton, field: locationField });

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

  const done = state.done;
  useEffect(() => {
    if (done === null) return;
    setNotOpened(!done.opened);
    const note = done.located ? done.notes[0] : undefined;
    setMadeAt(note === undefined ? null : { appId: done.appId, note });
    form.reset();
    setFormOpen(false);
    onCreated(done.appId);
  }, [done, form, onCreated]);

  const { data: receipt, reset: resetRemove } = remove;
  useEffect(() => {
    if (receipt === null) return;
    setRemoved({
      appId: receipt.appId,
      trashPath: receipt.trashPath,
      hadSource: receipt.hadSource,
      workspaceLeftAt: receipt.workspaceLeftAt ?? null,
    });
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

  // A refusal about the id belongs under the id field, one about the folder
  // under the folder; anything else is about the creation as a whole.
  const aboutId = state.error !== null && state.errorAbout === 'id' ? state.error.message : null;
  const failure = state.failure;

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
            void form.submit();
          }}
        >
          <fieldset className="launcher__choice">
            <legend>Start from</legend>
            {TEMPLATES.map((option) => (
              <label className="launcher__choice-option" key={option.id}>
                <input
                  checked={state.template === option.id}
                  name="template"
                  onChange={() => form.setTemplate(option.id)}
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
              onChange={(event) => form.setName(event.target.value)}
              ref={nameField}
              required
              type="text"
              value={state.name}
            />
          </label>
          <label className="launcher__field">
            <span>Id</span>
            <input
              className="launcher__input"
              maxLength={MAX_ID}
              onChange={(event) => form.setAppId(event.target.value)}
              required
              type="text"
              value={state.appId}
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
              onChange={(event) => form.setDescription(event.target.value)}
              type="text"
              value={state.description}
            />
          </label>
          <WhereItLives
            appId={state.appId}
            chooseRef={chooseButton}
            fieldRef={locationField}
            onChoose={() => void form.choose()}
            onShowTyping={() => form.showTyping()}
            onType={(text) => form.type(text)}
            onUseDefault={() => form.useDefault()}
            where={state.where}
            windows={windows}
          />
          <div className="launcher__row-actions launcher__form-actions">
            <button className="launcher__button" disabled={state.pending} type="submit">
              {state.pending ? 'Creating…' : 'Create'}
            </button>
            <button
              className="launcher__button launcher__button--small"
              onClick={close}
              type="button"
            >
              Cancel
            </button>
          </div>
          {state.pending && (
            <p className="launcher__lede">
              Installing dependencies and building. This can take a minute the first time.
            </p>
          )}
          {state.error !== null && aboutId === null && (
            // A refusal about the folder is also under the folder, where the
            // alert is; said once here, where every other refusal is shown.
            <p
              className="launcher__message launcher__message--error"
              {...(state.errorAbout === 'location' ? {} : { role: 'alert' })}
            >
              {state.error.message}
            </p>
          )}
          {failure !== null && <CreationFailure failure={failure} />}
        </form>
      )}

      {notOpened && (
        <p className="launcher__message launcher__message--error" role="alert">
          The application is running, but no browser could be opened. Its address is printed in
          the terminal the launcher runs in.
        </p>
      )}

      {madeAt !== null && (
        <p className="launcher__message launcher__path" role="status">
          {madeAt.appId}: {madeAt.note}
        </p>
      )}

      {removed !== null && <RemovedNotice removed={removed} />}

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
            apps.flatMap((app) => {
              const rowClass = app.appId === selected ? 'launcher__row launcher__row--selected' : 'launcher__row';
              const line = (
                <WorkspaceLine
                  app={app}
                  locate={locating}
                  onCancel={() => locate.cancel()}
                  onLocate={() => void locate.start(app.appId, app.workspace?.dir ?? null)}
                  onSet={() => void locate.submit()}
                  onType={(text) => locate.type(text)}
                  windows={windows}
                />
              );
              return [
                <tr key={app.appId} className={rowClass} onClick={() => onSelect(app.appId)}>
                  <td>
                    <span className="launcher__app-named">
                      <AppIcon appId={app.appId} name={app.name} size="small" />
                      {app.name}
                    </span>
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
                      // Enabled whatever state its workspace is in: a release
                      // serves without its source, and the host's sentence,
                      // not a disabled button, is what explains the rest.
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
                // The workspace line spans the row, under the name: a path is
                // long, and the end of it is the part that differs.
                ...(app.workspace?.chosen === true
                  ? [
                      <tr key={`${app.appId}-workspace`} className={`${rowClass} launcher__row-detail`} onClick={() => onSelect(app.appId)}>
                        <td colSpan={4}>{line}</td>
                      </tr>,
                    ]
                  : []),
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
                            <RemovalWords app={app} />
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
              ];
            })
          )}
        </tbody>
      </table>
    </section>
  );
}
