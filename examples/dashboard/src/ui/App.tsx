/**
 * Live Dashboard.
 *
 * Three streams running at once over one connection. Pause any of them and the
 * others keep going; drop the connection and each resumes independently.
 */
import { useEffect } from 'react';
import { useConnection, useOperation } from 'broapp/react';

import { ConnectionBadge } from './ConnectionBadge.tsx';
import { MetricCard } from './MetricCard.tsx';
import { Bars } from './Bars.tsx';
import type { AppContract } from '../shared/types.ts';

const INTERVAL_MS = 1_000;

export function App(): React.ReactElement {
  const connection = useConnection();
  const describe = useOperation<AppContract, 'system.describe'>('system.describe');
  const ready = connection.phase === 'ready';
  const { run, data, pending } = describe;

  useEffect(() => {
    if (ready && data === null && !pending) void run(undefined);
  }, [ready, data, pending, run]);

  const supports = data?.supports;

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">Live Dashboard</h1>
          <p className="app__lede">
            {data === null
              ? 'Reading this machine…'
              : `${data.cpuModel} · ${String(data.cpuCount)} cores · ${formatBytes(data.totalMemoryBytes)} memory`}
          </p>
        </div>
        <ConnectionBadge />
      </header>

      <main className="app__main">
        <MetricCard
          name="metrics.cpu"
          title="Processor"
          description="Busy fraction per core, sampled every second."
          intervalMs={INTERVAL_MS}
          supported={supports?.cpu === 'available'}
          render={(event) => (
            <>
              <p className="metric__value">
                {Math.round(event.overall * 100)}
                <span className="metric__unit">% overall</span>
              </p>
              <Bars values={event.cores} label="Per-core busy fraction" />
            </>
          )}
        />

        <MetricCard
          name="metrics.memory"
          title="Memory"
          description="Physical memory in use."
          intervalMs={INTERVAL_MS}
          supported={supports?.memory === 'available'}
          render={(event) => (
            <>
              <p className="metric__value">
                {Math.round(event.usedFraction * 100)}
                <span className="metric__unit">% used</span>
              </p>
              <p className="message">
                {formatBytes(event.totalBytes - event.freeBytes)} of {formatBytes(event.totalBytes)},{' '}
                {formatBytes(event.freeBytes)} free.
              </p>
            </>
          )}
        />

        <MetricCard
          name="metrics.load"
          title="Load average"
          description="Runnable processes averaged over one, five and fifteen minutes."
          intervalMs={INTERVAL_MS * 2}
          supported={supports?.load === 'available'}
          render={(event) =>
            event.one === null ? (
              <p className="message">This platform does not report a load average.</p>
            ) : (
              <dl className="facts facts--inline">
                <dt>1 min</dt>
                <dd>{event.one.toFixed(2)}</dd>
                <dt>5 min</dt>
                <dd>{event.five?.toFixed(2) ?? '—'}</dd>
                <dt>15 min</dt>
                <dd>{event.fifteen?.toFixed(2) ?? '—'}</dd>
              </dl>
            )
          }
        />
      </main>

      <footer className="app__footer">
        <details className="details">
          <summary className="details__summary">Technical details</summary>
          <div className="details__body">
            <p>
              Three streams share one WebSocket. Each is opened and cancelled independently, each
              has its own flow-control credit, and each is resumed from its own cursor after a
              reconnect. Pausing one does not disturb the others — that is what the multiplexing is
              for.
            </p>
            <p>
              Everything read here is aggregate: core counts, byte totals, load averages. No process
              list, no command lines, no environment.
            </p>
          </div>
        </details>
      </footer>
    </div>
  );
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}
