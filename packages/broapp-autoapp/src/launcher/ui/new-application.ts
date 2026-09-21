/**
 * What the New application form knows, and what Locate… on a row knows, as
 * plain objects rather than React state.
 *
 * Both talk to the launcher while a person waits — a folder window that may
 * sit open for minutes, a check that can answer after a newer one, a refusal
 * that has to be asked about before it can be placed — and the order those
 * answers arrive in is where the mistakes would be. Written here, with the
 * routes and the clock passed in, a test can play every order without a
 * browser, and `AppsTable` only draws what these say.
 *
 * Nothing here decides whether a folder will do. The host does, with the same
 * checks creation makes, and says so in 19a's words; the form shows them.
 */
import type { OperationInput, OperationOutput } from 'broapp/shared';

import { APP_ID_PATTERN } from '../../spec/types.ts';
import type { LauncherContract } from '../contract.ts';

export type CreateInput = OperationInput<LauncherContract, 'launcher.appCreate'>;
export type CreateOutput = OperationOutput<LauncherContract, 'launcher.appCreate'>;
export type CheckOutput = OperationOutput<LauncherContract, 'launcher.locationCheck'>;
export type ChooseOutput = OperationOutput<LauncherContract, 'launcher.folderChoose'>;
export type LocateOutput = OperationOutput<LauncherContract, 'launcher.appLocate'>;

/** A refusal as the page holds it: the code and the host's sentence, and nothing else. */
export interface FormError {
  readonly code: string;
  readonly message: string;
}

/** The routes the form calls. Each rejects as a bridge call does. */
export interface NewApplicationOps {
  create(input: CreateInput): Promise<CreateOutput>;
  check(input: { appId: string; location: string }): Promise<CheckOutput>;
  choose(input: { startAt?: string }): Promise<ChooseOutput>;
}

/** A clock a test can drive. */
export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Where the last folder a person created into is kept, for the next window's starting place. */
export interface LastLocation {
  read(): unknown;
  write(value: string): void;
}

/** The one key it is kept under. */
export const LAST_LOCATION_KEY = 'broapp-autoapp:last-location';

/** The longest folder the routes take. */
export const MAX_LOCATION = 1_024;

/** How long a typed path or id waits before it is checked. */
export const CHECK_DEBOUNCE_MS = 300;

export type TemplateChoice = 'starter' | 'blank';

/** Where the project goes, as the form's **Where it lives** group holds it. */
export interface WhereState {
  /** Whether this computer has a folder window. Once `unavailable`, it stays so for the life of the form. */
  readonly dialog: 'available' | 'unavailable';
  /** Whether the typed field is shown: always without a window, on request with one. */
  readonly typing: boolean;
  /** The folder as chosen or typed, before it is cleaned. Empty is the launcher's own folder. */
  readonly value: string;
  /** A folder window is open. */
  readonly choosing: boolean;
  /** A sentence the window's route answered with, such as a second press. */
  readonly status: string | null;
  /** Where the project would be made, from `locationCheck`, never joined here. */
  readonly target: string | null;
  /** Why it could not be made there: the live check's, or the refusal's after Create. */
  readonly problem: string | null;
}

/** Which control a change wants the keyboard on. `seq` changes every time, so a repeat still moves it. */
export interface FocusRequest {
  readonly on: 'choose' | 'field';
  readonly seq: number;
}

export interface NewApplicationState {
  readonly name: string;
  readonly appId: string;
  /** Whether the id was typed, so the name stops suggesting one. */
  readonly touchedId: boolean;
  readonly description: string;
  readonly template: TemplateChoice;
  readonly where: WhereState;
  /** A creation is running. */
  readonly pending: boolean;
  /** The last refusal, and which field it is about. */
  readonly error: FormError | null;
  readonly errorAbout: 'id' | 'location' | 'form' | null;
  /** A creation that ran and could not finish: the workspace is there, and these say what went wrong. */
  readonly failure: { readonly problems: CreateOutput['problems']; readonly notes: readonly string[] } | null;
  readonly focus: FocusRequest | null;
  /** A creation that finished, until the page has closed the form over it. */
  readonly done: { readonly appId: string; readonly opened: boolean; readonly notes: readonly string[]; readonly located: boolean } | null;
}

/**
 * A path as a person pasted it: trimmed, and without the quotes Finder's and
 * Explorer's "copy as path" put around it.
 */
export function cleanPath(text: string): string {
  const trimmed = text.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return quoted === null ? trimmed : (quoted[2] ?? '').trim();
}

/** Whether an id is one a folder could be named after. The same pattern the host holds every id to. */
export function legalId(appId: string): boolean {
  return APP_ID_PATTERN.test(appId);
}

/** The folder the form would send, or `undefined` for the launcher's own. */
export function locationOf(where: WhereState): string | undefined {
  const cleaned = cleanPath(where.value);
  return cleaned === '' ? undefined : cleaned;
}

/**
 * What Create posts. With nothing chosen it is exactly what the form posted
 * before 19b: no `location` key at all, not `undefined` and not `''`.
 */
export function createInput(state: Pick<NewApplicationState, 'appId' | 'name' | 'template' | 'description' | 'where'>): CreateInput {
  const location = locationOf(state.where);
  return {
    appId: state.appId,
    name: state.name,
    template: state.template,
    ...(state.description.trim() === '' ? {} : { description: state.description.trim() }),
    ...(location === undefined ? {} : { location }),
  };
}

/** A refusal from a bridge call, reduced to what the page may show. */
export function asFormError(cause: unknown): FormError {
  const code = (cause as { code?: unknown } | null)?.code;
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: typeof code === 'string' ? code : 'internal', message };
}

/** The remembered folder, when it is one: a string, not empty, not too long. */
function startFrom(last: LastLocation): string | undefined {
  let stored: unknown;
  try {
    stored = last.read();
  } catch {
    return undefined;
  }
  return typeof stored === 'string' && stored !== '' && stored.length <= MAX_LOCATION ? stored : undefined;
}

const EMPTY_WHERE: WhereState = {
  dialog: 'available',
  typing: false,
  value: '',
  choosing: false,
  status: null,
  target: null,
  problem: null,
};

const EMPTY: NewApplicationState = {
  name: '',
  appId: '',
  touchedId: false,
  description: '',
  template: 'starter',
  where: EMPTY_WHERE,
  pending: false,
  error: null,
  errorAbout: null,
  failure: null,
  focus: null,
  done: null,
};

/** An id from a name: lowercase, one hyphen between words, starting with a letter. */
export function idFromName(name: string, max = 40): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  if (slug === '') return '';
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`.slice(0, max);
}

export interface NewApplicationForm {
  get(): NewApplicationState;
  subscribe(listener: () => void): () => void;
  setName(name: string): void;
  setAppId(appId: string): void;
  setDescription(description: string): void;
  setTemplate(template: TemplateChoice): void;
  /** Open the system's folder window. */
  choose(): Promise<void>;
  /** Show the typed field while a window is available. */
  showTyping(): void;
  type(text: string): void;
  /** Back to the launcher's own folder. */
  useDefault(): void;
  submit(): Promise<void>;
  /** Start again from nothing, after a creation the page has taken note of. */
  reset(): void;
}

export interface NewApplicationOptions {
  readonly ops: NewApplicationOps;
  readonly last: LastLocation;
  readonly timers?: Timers;
  readonly debounceMs?: number;
}

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The New application form. */
export function createNewApplicationForm(options: NewApplicationOptions): NewApplicationForm {
  const { ops, last } = options;
  const timers = options.timers ?? realTimers;
  const debounceMs = options.debounceMs ?? CHECK_DEBOUNCE_MS;
  let state: NewApplicationState = EMPTY;
  const listeners = new Set<() => void>();
  let focusSeq = 0;
  /**
   * Every check asked, numbered. An answer is used only when it is the newest
   * — the same rule `use-ai-models.ts` keeps — so a slow answer about a path
   * the person has since changed cannot overwrite the one about the new path.
   */
  let checkGeneration = 0;
  /** Bumped by `reset`, so a window or a creation from before it cannot land on the new form. */
  let formGeneration = 0;
  let pendingCheck: unknown = null;

  const set = (next: Partial<NewApplicationState>): void => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const setWhere = (next: Partial<WhereState>, rest: Partial<NewApplicationState> = {}): void => {
    set({ ...rest, where: { ...state.where, ...next } });
  };
  const focus = (on: FocusRequest['on']): FocusRequest => ({ on, seq: (focusSeq += 1) });

  /** Ask where the project would be made, now. */
  const runCheck = async (): Promise<void> => {
    const location = locationOf(state.where);
    const appId = state.appId;
    const mine = (checkGeneration += 1);
    if (location === undefined || !legalId(appId)) {
      setWhere({ target: null, problem: null });
      return;
    }
    try {
      const answer = await ops.check({ appId, location });
      if (mine !== checkGeneration) return;
      setWhere({ target: answer.ok ? answer.target : null, problem: answer.ok ? null : answer.problem });
    } catch {
      // A check that failed to load says nothing: the host checks again at
      // Create, and a form stranded by its own question helps nobody.
      if (mine !== checkGeneration) return;
      setWhere({ target: null, problem: null });
    }
  };

  /** Ask again once the person has stopped typing. Nothing is asked while the id could not name a folder. */
  const scheduleCheck = (delay: number): void => {
    if (pendingCheck !== null) timers.clear(pendingCheck);
    pendingCheck = null;
    // Whatever was said was about the path or id as it was.
    checkGeneration += 1;
    setWhere({ target: null, problem: null });
    if (locationOf(state.where) === undefined || !legalId(state.appId)) return;
    if (delay === 0) {
      void runCheck();
      return;
    }
    pendingCheck = timers.set(() => {
      pendingCheck = null;
      void runCheck();
    }, delay);
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setName(name) {
      const suggested = state.touchedId ? state.appId : idFromName(name);
      const idChanged = suggested !== state.appId;
      set({ name, appId: suggested });
      if (idChanged && locationOf(state.where) !== undefined) scheduleCheck(debounceMs);
    },
    setAppId(appId) {
      set({ appId, touchedId: true });
      if (locationOf(state.where) !== undefined) scheduleCheck(debounceMs);
    },
    setDescription(description) {
      set({ description });
    },
    setTemplate(template) {
      set({ template });
    },
    async choose() {
      if (state.where.choosing || state.where.dialog === 'unavailable') return;
      const form = formGeneration;
      setWhere({ choosing: true, status: null });
      const startAt = startFrom(last);
      let answer: ChooseOutput;
      try {
        answer = await ops.choose(startAt === undefined ? {} : { startAt });
      } catch (cause) {
        if (form !== formGeneration) return;
        // A second press while a window is open, or the route failing: say
        // what it said and give the button back.
        setWhere({ choosing: false, status: asFormError(cause).message }, { focus: focus('choose') });
        return;
      }
      if (form !== formGeneration) return;
      if (!answer.available) {
        // No window here, for the rest of this form: the typed field takes its place.
        setWhere({ choosing: false, dialog: 'unavailable', typing: true }, { focus: focus('field') });
        return;
      }
      if (answer.chosen === null) {
        // Cancel: nothing changes, and nothing is said about it.
        setWhere({ choosing: false }, { focus: focus('choose') });
        return;
      }
      setWhere({ choosing: false, value: answer.chosen }, { focus: focus('choose') });
      scheduleCheck(0);
    },
    showTyping() {
      setWhere({ typing: true }, { focus: focus('field') });
    },
    type(text) {
      setWhere({ value: text });
      scheduleCheck(debounceMs);
    },
    useDefault() {
      setWhere({ value: '', status: null }, { focus: focus(state.where.dialog === 'available' ? 'choose' : 'field') });
      scheduleCheck(0);
    },
    async submit() {
      // One creation at a time. The button is disabled while one runs, and a
      // disabled default button stops Enter too; this is the same rule for
      // anything that calls here, because a second creation into the same
      // folder would fail with "already exists" and read like the person's
      // mistake.
      if (state.pending) return;
      const form = formGeneration;
      const input = createInput(state);
      set({ pending: true, error: null, errorAbout: null, failure: null });
      let created: CreateOutput;
      try {
        created = await ops.create(input);
      } catch (cause) {
        if (form !== formGeneration) return;
        const error = asFormError(cause);
        const fieldish = error.code === 'invalid_input' || error.code === 'conflict';
        if (!fieldish) {
          set({ pending: false, error, errorAbout: 'form' });
          return;
        }
        if (input.location === undefined) {
          set({ pending: false, error, errorAbout: 'id' });
          return;
        }
        // A sentence is not a discriminant, and a public error is a code and a
        // sentence. So the form asks the question it asked before: a problem
        // with the folder now means the refusal was the folder's.
        let problem: string | null = null;
        try {
          const again = await ops.check({ appId: input.appId, location: input.location });
          problem = again.ok ? null : again.problem;
        } catch {
          problem = null;
        }
        if (form !== formGeneration) return;
        // This answer is newer than any check still on its way or waiting.
        checkGeneration += 1;
        if (pendingCheck !== null) timers.clear(pendingCheck);
        pendingCheck = null;
        if (problem !== null) {
          setWhere({ problem, target: null }, { pending: false, error, errorAbout: 'location', focus: focus(state.where.typing ? 'field' : 'choose') });
        } else {
          set({ pending: false, error, errorAbout: 'id' });
        }
        return;
      }
      if (form !== formGeneration) return;
      if (!created.ok) {
        set({ pending: false, failure: { problems: created.problems, notes: created.notes } });
        return;
      }
      if (input.location !== undefined) {
        try {
          last.write(input.location);
        } catch {
          // Forgetting where the last one went costs a click next time, nothing more.
        }
      }
      set({
        pending: false,
        done: { appId: input.appId, opened: created.opened, notes: created.notes, located: input.location !== undefined },
      });
    },
    reset() {
      formGeneration += 1;
      checkGeneration += 1;
      if (pendingCheck !== null) timers.clear(pendingCheck);
      pendingCheck = null;
      // A window that proved there is none stays proved for this page.
      set({ ...EMPTY, where: { ...EMPTY_WHERE, dialog: state.where.dialog, typing: state.where.dialog === 'unavailable' } });
    },
  };
}

// ── Locate… on a row ────────────────────────────────────────────────────────

export interface LocateOps {
  choose(input: { startAt?: string }): Promise<ChooseOutput>;
  locate(input: { appId: string; sourceDir: string }): Promise<LocateOutput>;
}

export interface LocateState {
  /** The row whose Locate… is in progress, if any. */
  readonly appId: string | null;
  readonly choosing: boolean;
  readonly posting: boolean;
  /** The inline field, where there is no window. */
  readonly typing: boolean;
  readonly typed: string;
  /** The host's refusal, shown on the row. */
  readonly error: string | null;
  readonly dialog: 'available' | 'unavailable';
}

/**
 * The folder above a workspace that has gone, for the window's starting
 * place. The route drops one that is not there either, so this need only be
 * the parent, and the host lets it fall back.
 */
export function parentOf(dir: string): string | undefined {
  const trimmed = dir.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return undefined;
  if (cut === 0) return trimmed.slice(0, 1);
  const parent = trimmed.slice(0, cut);
  // `C:` alone is the current directory on that drive, not its root.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

export interface LocateControl {
  get(): LocateState;
  subscribe(listener: () => void): () => void;
  /** Press Locate… on a row whose workspace was at `dir`. */
  start(appId: string, dir: string | null): Promise<void>;
  type(text: string): void;
  /** Set, from the inline field. */
  submit(): Promise<void>;
  cancel(): void;
}

/** Locate… for the whole table: one row at a time, as one folder window at a time. */
export function createLocateControl(ops: LocateOps, onLocated: (appId: string) => void): LocateControl {
  let state: LocateState = { appId: null, choosing: false, posting: false, typing: false, typed: '', error: null, dialog: 'available' };
  const listeners = new Set<() => void>();
  const set = (next: Partial<LocateState>): void => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const post = async (appId: string, sourceDir: string): Promise<void> => {
    set({ posting: true, error: null });
    try {
      await ops.locate({ appId, sourceDir });
    } catch (cause) {
      // The row stays as it was, and says why.
      if (state.appId === appId) set({ posting: false, error: asFormError(cause).message });
      return;
    }
    set({ appId: null, posting: false, typing: false, typed: '', error: null });
    onLocated(appId);
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(appId, dir) {
      if (state.choosing || state.posting) return;
      if (state.dialog === 'unavailable') {
        set({ appId, typing: true, typed: '', error: null });
        return;
      }
      set({ appId, choosing: true, typing: false, error: null });
      const startAt = dir === null ? undefined : parentOf(dir);
      let answer: ChooseOutput;
      try {
        answer = await ops.choose(startAt === undefined ? {} : { startAt });
      } catch (cause) {
        set({ choosing: false, error: asFormError(cause).message });
        return;
      }
      if (!answer.available) {
        set({ choosing: false, dialog: 'unavailable', typing: true, typed: '' });
        return;
      }
      if (answer.chosen === null) {
        set({ appId: null, choosing: false });
        return;
      }
      set({ choosing: false });
      await post(appId, answer.chosen);
    },
    type(text) {
      set({ typed: text });
    },
    async submit() {
      const appId = state.appId;
      const sourceDir = cleanPath(state.typed);
      if (appId === null || sourceDir === '' || state.posting) return;
      await post(appId, sourceDir);
    },
    cancel() {
      set({ appId: null, typing: false, typed: '', error: null, choosing: false });
    },
  };
}
