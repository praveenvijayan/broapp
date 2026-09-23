/**
 * Alerts: notifications and sound, in Settings, where a person can turn each
 * on and off.
 *
 * Two switches, drawn as the standing one is. Turning Notifications on is the
 * click a browser needs before it will ask for permission, and the one place
 * permission is asked from. Turning it off stops the page raising any: a page
 * cannot give a permission back, so off is the launcher's own flag, kept in
 * the browser's storage like the sound switch.
 *
 * The launcher listens on a new port each time it starts, and a browser keeps
 * a permission per address. So after a restart the browser has no answer for
 * this address and asks again the next time the switch is turned on. The hint
 * says so, rather than leaving a switch that was on looking as if it broke.
 */
import * as React from 'react';

/** The browser's notification permission as the page reads it, or `unsupported`. */
export type AlertPermission = 'default' | 'granted' | 'denied' | 'unsupported' | (string & {});

/** Props for {@link AlertsSection}. */
export interface AlertsSectionProps {
  readonly permission: AlertPermission;
  /** The person's wish, remembered; shown on only while the browser also allows it. */
  readonly notifications: boolean;
  readonly sound: boolean;
  onNotifications(on: boolean): void;
  onSound(on: boolean): void;
  onTestSound(): void;
}

/** What the notifications row says under its switch, for the browser's answer and the person's. */
export function notificationsHint(permission: AlertPermission, notifications: boolean): string {
  switch (permission) {
    case 'denied':
      return 'Blocked in this browser’s settings for this page. Sound still works.';
    case 'unsupported':
      return 'This browser shows no notifications. Sound still works.';
    case 'granted':
      return notifications
        ? 'A notification when a question waits, a task fails or a run ends, even while this tab is behind another.'
        : 'Turn on for a notification when a question waits, a task fails or a run ends.';
    default:
      return 'The browser asks once when this is turned on. Each start of the launcher has its own address, so it asks again after a restart.';
  }
}

/** The Alerts section: two switches and a way to hear the tone. */
export function AlertsSection({ permission, notifications, sound, onNotifications, onSound, onTestSound }: AlertsSectionProps): React.ReactElement {
  const allowed = permission === 'granted';
  const askable = permission !== 'denied' && permission !== 'unsupported';
  return (
    <section aria-labelledby="launcher-alerts-title" className="launcher__section">
      <header className="launcher__section-header">
        <h2 className="launcher__section-title" id="launcher-alerts-title">
          Alerts
        </h2>
        <p className="launcher__section-lede">Hear about a question, a failed task or a finished run while you are elsewhere.</p>
      </header>
      <label className="launcher__switch-row" htmlFor="launcher-notifications">
        <span className="launcher__switch-label">Notifications</span>
        <input
          aria-describedby="launcher-notifications-hint"
          checked={allowed && notifications}
          className="launcher__switch"
          disabled={!askable}
          id="launcher-notifications"
          onChange={(event) => onNotifications(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
      </label>
      <p className="launcher__section-hint" id="launcher-notifications-hint">
        {notificationsHint(permission, notifications)}
      </p>
      <label className="launcher__switch-row" htmlFor="launcher-sound">
        <span className="launcher__switch-label">Sound</span>
        <input
          aria-describedby="launcher-sound-hint"
          checked={sound}
          className="launcher__switch"
          id="launcher-sound"
          onChange={(event) => onSound(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
      </label>
      <p className="launcher__section-hint" id="launcher-sound-hint">
        A short tone when something needs you and this tab is not in front.{' '}
        <button className="launcher__link" onClick={onTestSound} type="button">
          Test sound
        </button>
      </p>
    </section>
  );
}
