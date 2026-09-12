/**
 * The "still working" mark.
 *
 * The AI Elements registry at 1.9.0 has no `loader` component; its spinner is
 * the shadcn primitive, which is what this wraps, with the label a screen
 * reader needs.
 *
 * A turn that calls tools runs for minutes with nothing arriving as text, and
 * a panel that only spins until the first sentence looks dead for the rest of
 * it. So the mark stays for the whole turn and says what is known: the tool
 * that is running when one is, how long the turn has taken, and how many tool
 * calls it has made. Between tools, while the model is deciding, it shows one
 * of a handful of phrases, changed every few seconds, so a person can see the
 * turn is alive. The phrases are decoration, not status: the numbers are the
 * status.
 */
import * as React from 'react';

import { Spinner } from './components/ui/spinner.tsx';

/** Shown between tool calls while nothing is known but that the turn runs. */
export const DEFAULT_STATUS_LINES: readonly string[] = [
  'Thinking…',
  'Reading what it found…',
  'Weighing the options…',
  'Mocking up a plan…',
  'Working through it…',
  'Surviving the details…',
  'Putting it together…',
  'Still at it…',
];

/** How long one phrase stays before the next. */
export const STATUS_LINE_MS = 4_000;

export interface LoaderProps {
  /** The tool running right now, when one is; shown instead of a phrase. */
  readonly activity?: string | null;
  /** Milliseconds since the turn started, when known. */
  readonly elapsedMs?: number | null;
  /** When the turn started; picks where the phrases start from. */
  readonly startedAt?: number | null;
  /** Tool calls the turn has made so far. */
  readonly steps?: number;
  /** The phrases to rotate between tool calls. Default {@link DEFAULT_STATUS_LINES}. */
  readonly lines?: readonly string[];
}

/** "12s", "1m 05s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * The phrase for this moment of the turn.
 *
 * Steps through the list from a start chosen by the turn's own start time, so
 * two turns do not open with the same words, and every phrase gets its turn
 * before any repeats. Without a start time it is the first one.
 */
export function statusLine(lines: readonly string[], elapsedMs: number | null, startedAt: number | null): string {
  if (lines.length === 0) return '';
  const offset = startedAt === null ? 0 : Math.floor(startedAt / 1_000) % lines.length;
  const tick = elapsedMs === null ? 0 : Math.floor(elapsedMs / STATUS_LINE_MS);
  return lines[(offset + tick) % lines.length] ?? '';
}

export function Loader({
  activity = null,
  elapsedMs = null,
  startedAt = null,
  steps = 0,
  lines = DEFAULT_STATUS_LINES,
}: LoaderProps): React.ReactElement {
  const phrase = statusLine(lines, elapsedMs, startedAt);
  const meta: string[] = [];
  if (elapsedMs !== null && elapsedMs >= 1_000) meta.push(formatElapsed(elapsedMs));
  if (steps > 0) meta.push(`${String(steps)} tool ${steps === 1 ? 'call' : 'calls'}`);
  return (
    <p className="broapp-chat__loader" role="status">
      <Spinner aria-hidden="true" />
      {/* The rotating phrase is decoration; a reader hears one steady sentence. */}
      <span className="sr-only">Still working.</span>
      <span aria-hidden="true" className="broapp-chat__loader-line">
        {activity === null ? phrase : `Running ${activity}…`}
      </span>
      {meta.length === 0 ? null : <span className="broapp-chat__loader-meta">{meta.join(' · ')}</span>}
    </p>
  );
}
