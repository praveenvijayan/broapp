/**
 * Quit, at the bottom of the rail.
 *
 * Closing the launcher's tab stops nothing: the launcher and every application
 * it serves go on, which is meant, because an application is used with the
 * panel closed. Until this, the only way to stop it was the terminal it was
 * started from. One confirmation says what stopping does, because it takes the
 * applications and a backlog task with it.
 */
import { useEffect, useRef, useState } from 'react';
import { Power } from 'lucide-react';

/** What the confirmation says. */
export const QUIT_CONFIRMATION =
  'Stops the launcher and every application it is serving. A running backlog task is interrupted. Start it again with broapp-autoapp open.';

/** What the page says once the launcher has stopped. */
export const QUIT_DONE = 'The launcher has stopped. You can close this tab.';

/** The props of {@link QuitControl}. */
export interface QuitControlProps {
  /** Ask the launcher to stop. */
  readonly onQuit: () => void;
  /** While the request is on its way. */
  readonly pending: boolean;
  /** Why the launcher could not be asked, as a sentence; `null` when nothing failed. */
  readonly error: string | null;
  /** Start with the confirmation open, for a test that draws it. */
  readonly initiallyAsking?: boolean;
}

/** The rail button and its inline confirmation. */
export function QuitControl({ onQuit, pending, error, initiallyAsking = false }: QuitControlProps): React.ReactElement {
  const [asking, setAsking] = useState(initiallyAsking);
  const busy = pending;
  const confirm = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  // Focus goes to the confirming button on open, and back to Quit on cancel.
  useEffect(() => {
    if (!asking) return undefined;
    confirm.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAsking(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (opener.current?.isConnected === true) opener.current.focus();
    };
  }, [asking]);

  return (
    <div className="launcher__quit">
      <button
        aria-expanded={asking}
        aria-label="Quit the launcher"
        className="launcher__rail-button"
        onClick={() => setAsking((open) => !open)}
        ref={opener}
        title="Quit the launcher"
        type="button"
      >
        <Power aria-hidden="true" size={17} />
      </button>
      {asking ? (
        <div aria-label="Quit the launcher" className="launcher__quit-confirm" role="group">
          <p className="launcher__quit-text">{QUIT_CONFIRMATION}</p>
          {error === null ? null : (
            <p className="launcher__message launcher__message--error" role="alert">
              {error}
            </p>
          )}
          <div className="launcher__row-actions">
            <button
              className="launcher__button launcher__button--danger"
              disabled={busy}
              onClick={onQuit}
              ref={confirm}
              type="button"
            >
              {busy ? 'Stopping…' : 'Quit'}
            </button>
            <button className="launcher__button" disabled={busy} onClick={() => setAsking(false)} type="button">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** What the tab shows once the launcher has stopped: nothing to click, nothing polling. */
export function LauncherStopped(): React.ReactElement {
  return (
    <main className="launcher__stopped">
      <p role="status">{QUIT_DONE}</p>
    </main>
  );
}
