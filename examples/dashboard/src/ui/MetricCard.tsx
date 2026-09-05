/**
 * One metric, one stream, its own start/stop.
 *
 * Each card owns a subscription. Independence is the point: stopping one does
 * nothing to the others, and after a reconnect each resumes on its own.
 */
import { useEffect, useId, type ReactNode } from 'react';
import { useStream } from 'broapp/react';

import type { StreamEvent, StreamName } from 'broapp/shared';

import type { AppContract } from '../shared/types.ts';

export interface MetricCardProps<K extends StreamName<AppContract>> {
  readonly name: K;
  readonly title: string;
  readonly description: string;
  readonly intervalMs: number;
  /** False when the platform does not provide this metric. */
  readonly supported: boolean;
  /** Start as soon as the card mounts. */
  readonly autoStart?: boolean;
  readonly render: (event: StreamEvent<AppContract, K>) => ReactNode;
}

export function MetricCard<K extends StreamName<AppContract>>({
  name,
  title,
  description,
  intervalMs,
  supported,
  autoStart = true,
  render,
}: MetricCardProps<K>): React.ReactElement {
  const stream = useStream<AppContract, K>(name);
  const headingId = useId();
  const { start } = stream;

  useEffect(() => {
    if (!supported || !autoStart) return;
    void start({ intervalMs } as never);
  }, [supported, autoStart, intervalMs, start]);

  return (
    <section className="card" aria-labelledby={headingId}>
      <header className="card__head">
        <div>
          <h2 className="card__title" id={headingId}>
            {title}
          </h2>
          <p className="card__lede">{description}</p>
        </div>
        {supported && (
          <button
            className={stream.running ? 'button button--danger' : 'button'}
            type="button"
            onClick={() =>
              stream.running ? stream.cancel() : void stream.start({ intervalMs } as never)
            }
          >
            {stream.running ? 'Pause' : 'Resume'}
          </button>
        )}
      </header>

      <div className="metric" role="status" aria-live="off">
        {!supported ? (
          // Saying so is better than drawing a flat line that looks like data.
          <p className="message">Not available on this platform.</p>
        ) : stream.error !== null ? (
          <p className="message message--error">{stream.error.message}</p>
        ) : stream.last === null ? (
          <p className="message">{stream.running ? 'Waiting for the first reading…' : 'Paused.'}</p>
        ) : (
          render(stream.last)
        )}
      </div>
    </section>
  );
}
