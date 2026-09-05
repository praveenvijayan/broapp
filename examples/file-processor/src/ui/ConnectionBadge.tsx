/**
 * The connection indicator.
 *
 * Every state it shows corresponds to something the transport actually
 * reported. There is no invented timeout and no "offline" guess: `lost` means
 * the client gave up reconnecting, which in a local application almost always
 * means the host process exited.
 */
import { useConnection } from 'broapp/react';

/**
 * Wording, and why it is worded this way.
 *
 * A client cannot tell a host that died from one that is briefly unreachable —
 * both look like a socket that will not open. So the reconnecting state never
 * claims the application has stopped. What it does do is change what it
 * *suggests* once a reconnect could no longer restore work in progress, which
 * is a fact the client does know: past the host's session retention window the
 * session has been reaped, so a reconnect starts fresh whatever happens.
 */
function describe(connection: ReturnType<typeof useConnection>): {
  text: string;
  tone: 'ok' | 'pending' | 'bad';
  detail: string;
} {
  switch (connection.phase) {
    case 'connecting':
      return { text: 'Connecting…', tone: 'pending', detail: 'Reaching the application on this computer.' };
    case 'ready':
      return { text: 'Connected', tone: 'ok', detail: 'The application is running and responding.' };
    case 'reconnecting':
      return connection.resumable
        ? {
            text: 'Reconnecting…',
            tone: 'pending',
            detail: 'The connection dropped. Work in progress will resume if it comes back shortly.',
          }
        : {
            text: 'Still reconnecting…',
            tone: 'bad',
            detail:
              'Nothing has answered for a while, and work in progress can no longer be resumed. If you closed the application, start it again.',
          };
    case 'lost':
      return {
        text: 'Stopped',
        tone: 'bad',
        detail: 'The application is no longer running. Start it again from your terminal.',
      };
    case 'failed':
      return { text: 'Not connected', tone: 'bad', detail: connection.error.message };
  }
}

export function ConnectionBadge(): React.ReactElement {
  const connection = useConnection();
  const label = describe(connection);
  const detail = label.detail;

  return (
    <div className="badge" data-tone={label.tone}>
      {/*
        `role="status"` with `aria-live="polite"` announces a change without
        interrupting whatever a screen-reader user is doing. The dot is
        decorative; the text carries the meaning.
      */}
      <span className="badge__dot" aria-hidden="true" />
      <span role="status" aria-live="polite" className="badge__text">
        {label.text}
      </span>
      <span className="badge__detail">{detail}</span>
    </div>
  );
}
