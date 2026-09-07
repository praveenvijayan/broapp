/**
 * Telling a person a question is waiting for them, when they are not looking.
 *
 * The launcher's questions are not like an application's. An application asks
 * while somebody is using it; the engineer asks after ten minutes of a model
 * thinking, by which time the tab is behind something else. Report 08b lost
 * two of six edits to exactly that — a question that arrived, waited, and
 * expired unread.
 *
 * Two nudges, both quiet. The tab renames itself, which is the one thing a
 * background tab can still say. And a notification is raised only if the
 * person has *already* granted permission: asking for it is a dialogue nobody
 * invited, and a program that asks the moment it wants something is a program
 * people say no to.
 */

/** The prefix a title carries while something is waiting, e.g. `(1) `. */
const PREFIX = /^\(\d+\)\s/;

/** A title with the pending count on the front, and without it at zero. */
export function titleWithPending(title: string, pending: number): string {
  const bare = title.replace(PREFIX, '');
  return pending > 0 ? `(${String(pending)}) ${bare}` : bare;
}

/** What {@link announcePending} may touch. Injected so it can be tested. */
export interface PendingSurface {
  title: string;
  /** The browser's notification constructor, when there is one. */
  readonly notify?: {
    readonly permission: string;
    raise(title: string, body: string): void;
  };
}

/**
 * Rename the surface, and raise a notification the first time a question
 * appears.
 *
 * `previous` is what the count was a moment ago, so a strip that keeps
 * reporting the same waiting question does not raise a notification a second
 * time. Returns nothing: this is the edge of the program.
 */
export function announcePending(
  surface: PendingSurface,
  pending: number,
  previous: number,
): void {
  surface.title = titleWithPending(surface.title, pending);
  if (pending <= previous || pending === 0) return;
  const notify = surface.notify;
  // Never `requestPermission()`. A permission that was not already given is an
  // answer, and asking again is how a tab becomes something people mute.
  if (notify === undefined || notify.permission !== 'granted') return;
  notify.raise(
    'Autoapp needs an answer',
    pending === 1
      ? 'The engineer is waiting for you to allow something.'
      : `${String(pending)} things are waiting for you.`,
  );
}

/** The browser's own surface, or `null` when there is no document. */
export function browserSurface(): PendingSurface | null {
  if (typeof document === 'undefined') return null;
  const constructor = (globalThis as { Notification?: typeof Notification }).Notification;
  return {
    get title() {
      return document.title;
    },
    set title(value: string) {
      document.title = value;
    },
    ...(constructor === undefined
      ? {}
      : {
          notify: {
            permission: constructor.permission,
            raise: (title: string, body: string) => void new constructor(title, { body }),
          },
        }),
  };
}
