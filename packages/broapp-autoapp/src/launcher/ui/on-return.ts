/**
 * Something to do when the person comes back to the launcher's tab.
 *
 * The applications list is read when the page connects and after anything
 * the page itself does, and not otherwise. A workspace folder renamed back in
 * Finder, or a drive plugged in again, changes nothing the page did, so the
 * list is read again when the window regains focus or the tab is shown again.
 * No timer: a read nobody is looking at is a read for nobody.
 */

/** The two things listened to, as a test can fake them. */
export interface ReturnSurface {
  readonly window: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { readonly visibilityState: string };
}

/** Call `back` whenever the tab is focused or shown again. Returns the way to stop. */
export function onReturn(surface: ReturnSurface, back: () => void): () => void {
  // A window that has just been given focus is being looked at, whatever its
  // document reports; a tab that changed visibility is only when it is shown.
  const focused = (): void => back();
  const shown = (): void => {
    if (surface.document.visibilityState === 'visible') back();
  };
  surface.window.addEventListener('focus', focused);
  surface.document.addEventListener('visibilitychange', shown);
  return () => {
    surface.window.removeEventListener('focus', focused);
    surface.document.removeEventListener('visibilitychange', shown);
  };
}
