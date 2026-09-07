/**
 * How long a person has left to answer a question.
 *
 * Shared rather than written twice because the same countdown appears wherever
 * an approval is shown — an approvals strip in an application's tab, a confirm
 * card in a chat panel — and two formatters would eventually disagree about
 * what "one minute left" looks like. It is pure arithmetic over a timestamp:
 * nothing here decides anything, and the gate's own timer is what actually
 * refuses a question nobody answered.
 */

/** Below this, a question is close enough to running out to say so loudly. */
export const URGENT_MS = 60_000;

/** Milliseconds until `expiresAt`, never negative. */
export function remainingMs(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, expiresAt - now);
}

/**
 * The time left as `m:ss`.
 *
 * Rounded up, so a question with 600 ms left reads `0:01` rather than `0:00`:
 * a countdown that says zero while the button still works is a countdown
 * people stop believing.
 */
export function countdown(expiresAt: number, now: number = Date.now()): string {
  const seconds = Math.ceil(remainingMs(expiresAt, now) / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/** True while a question is nearly out of time, and false once it is out. */
export function isUrgent(expiresAt: number, now: number = Date.now()): boolean {
  const left = remainingMs(expiresAt, now);
  return left > 0 && left < URGENT_MS;
}
