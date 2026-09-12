/**
 * The launcher's own log, for a person working out what happened.
 *
 * Reads `launcher.eventsList`: the same rows the knowledge store keeps for
 * the learning loop, newest first, already sanitised at write. Nothing here
 * is a new record; it is a window on one that exists. Refreshes itself every
 * few seconds while open, so a turn that is running can be watched, and
 * copies what is shown as plain lines for a bug report.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useOperation } from 'broapp/react';

import type { LauncherContract } from '../contract.ts';

type Level = 'all' | 'warn' | 'error';

/** How often the list is read again while it is open and following. */
const FOLLOW_MS = 5_000;

/** Rows asked for on each read. */
const ROWS = 300;

export interface LogsPanelProps {
  /** Applications to offer as a filter. */
  readonly apps: readonly string[];
  onClose(): void;
}

/** `13:04:09`, local time. */
function clock(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** One event as one line, for the clipboard. */
function line(event: { at: number; level: string; source: string; kind: string; appId: string | null; message: string; data?: unknown }): string {
  const head = `${new Date(event.at).toISOString()} ${event.level.padEnd(5)} ${event.source}/${event.kind}${event.appId === null ? '' : ` [${event.appId}]`}`;
  return event.data === null || event.data === undefined ? `${head} ${event.message}` : `${head} ${event.message} ${JSON.stringify(event.data)}`;
}

export function LogsPanel({ apps, onClose }: LogsPanelProps): React.ReactElement {
  const list = useOperation<LauncherContract, 'launcher.eventsList'>('launcher.eventsList');
  const { run } = list;
  const [level, setLevel] = useState<Level>('all');
  const [appId, setAppId] = useState('');
  const [text, setText] = useState('');
  const [following, setFollowing] = useState(true);
  const [opened, setOpened] = useState<number | null>(null);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);

  const refresh = useCallback((): void => {
    void run({
      limit: ROWS,
      ...(level === 'all' ? {} : { level }),
      ...(appId === '' ? {} : { appId }),
    });
  }, [run, level, appId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!following) return undefined;
    const timer = setInterval(refresh, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [following, refresh]);

  const needle = text.trim().toLowerCase();
  const rows = useMemo(() => {
    const events = list.data?.events ?? [];
    if (needle === '') return events;
    return events.filter((event) =>
      `${event.message} ${event.source} ${event.kind} ${event.appId ?? ''} ${event.runId ?? ''}`.toLowerCase().includes(needle),
    );
  }, [list.data, needle]);

  const copy = (): void => {
    const body = rows.map(line).join('\n');
    navigator.clipboard
      .writeText(body)
      .then(() => setCopied('done'))
      .catch(() => setCopied('failed'));
    setTimeout(() => setCopied(null), 2_000);
  };

  return (
    <aside aria-label="Log" className="launcher__logs">
      <div className="launcher__settings-header">
        <h2 className="launcher__card-title">Log</h2>
        <button className="launcher__button launcher__button--small" onClick={onClose} type="button">
          Close
        </button>
      </div>

      <div className="launcher__log-controls">
        <label className="launcher__log-control">
          Level
          <select className="launcher__input" onChange={(event) => setLevel(event.target.value as Level)} value={level}>
            <option value="all">Everything</option>
            <option value="warn">Warnings and errors</option>
            <option value="error">Errors</option>
          </select>
        </label>
        <label className="launcher__log-control">
          Application
          <select className="launcher__input" onChange={(event) => setAppId(event.target.value)} value={appId}>
            <option value="">Any</option>
            {apps.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="launcher__log-control launcher__log-control--grow">
          Contains
          <input
            className="launcher__input"
            onChange={(event) => setText(event.target.value)}
            placeholder="a word in the message, source or kind"
            type="search"
            value={text}
          />
        </label>
        <label className="launcher__log-follow">
          <input checked={following} onChange={(event) => setFollowing(event.target.checked)} type="checkbox" />
          Follow
        </label>
        <button className="launcher__button launcher__button--small" onClick={refresh} type="button">
          Refresh
        </button>
        <button className="launcher__button launcher__button--small" disabled={rows.length === 0} onClick={copy} type="button">
          {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy'}
        </button>
      </div>

      {list.error !== null ? (
        <p className="launcher__message launcher__message--error" role="alert">
          {list.error.message}
        </p>
      ) : null}
      {list.data !== null && list.data.dropped > 0 ? (
        <p className="launcher__message launcher__message--error">
          {String(list.data.dropped)} events could not be written since the launcher started; this log is missing them.
        </p>
      ) : null}
      {list.data !== null && rows.length === 0 ? (
        <p className="launcher__lede">Nothing matches. The newest {String(ROWS)} events are searched; widen the filters for more.</p>
      ) : null}

      <ol className="launcher__log-list">
        {rows.map((event) => {
          const open = opened === event.id;
          const hasData = event.data !== null && event.data !== undefined;
          return (
            <li className={`launcher__log-row launcher__log-row--${event.level}`} key={event.id}>
              <button
                aria-expanded={hasData ? open : undefined}
                className="launcher__log-line"
                disabled={!hasData}
                onClick={() => setOpened(open ? null : event.id)}
                type="button"
              >
                <span className="launcher__log-time">{clock(event.at)}</span>
                <span className={`launcher__log-level launcher__log-level--${event.level}`}>{event.level}</span>
                <span className="launcher__log-where">
                  {event.source}/{event.kind}
                  {event.appId === null ? '' : ` · ${event.appId}`}
                </span>
                <span className="launcher__log-message">{event.message}</span>
              </button>
              {open && hasData ? <pre className="launcher__log-data">{JSON.stringify(event.data, null, 2)}</pre> : null}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
