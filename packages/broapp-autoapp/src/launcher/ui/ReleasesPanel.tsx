/** One application's releases, and what has been activated. */
import { useEffect } from 'react';
import type { ReactElement } from 'react';

import { useOperation } from 'broapp/react';

import type { LauncherContract } from '../contract.ts';

export interface ReleasesPanelProps {
  readonly appId: string;
  /** Changing this refetches, after something the engineer or the person did. */
  readonly reloadToken: number;
}

export function ReleasesPanel({ appId, reloadToken }: ReleasesPanelProps): ReactElement {
  const releases = useOperation<LauncherContract, 'launcher.releasesList'>('launcher.releasesList');
  const journal = useOperation<LauncherContract, 'launcher.journalList'>('launcher.journalList');

  const { run: listReleases } = releases;
  const { run: listJournal } = journal;
  useEffect(() => {
    void listReleases({ appId });
    void listJournal({ appId });
  }, [appId, listReleases, listJournal, reloadToken]);

  return (
    <section className="launcher__card" aria-labelledby="releases-heading">
      <h2 className="launcher__card-title" id="releases-heading">
        History
      </h2>

      <h3 className="launcher__subtitle">Releases</h3>
      <ul className="launcher__list">
        {(releases.data?.releases ?? []).map((release) => (
          <li key={release.releaseId}>
            <code>{release.releaseId.slice(0, 8)}</code> · schema {String(release.schemaVersion)} ·{' '}
            {new Date(release.createdAt).toLocaleString()}
            {release.current ? ' · running now' : ''}
          </li>
        ))}
        {(releases.data?.releases ?? []).length === 0 && (
          <li className="launcher__empty">Nothing built yet.</li>
        )}
      </ul>

      <h3 className="launcher__subtitle">Updates</h3>
      <ul className="launcher__list">
        {(journal.data?.activations ?? []).map((row) => (
          <li key={row.id}>
            {new Date(row.startedAt).toLocaleString()} ·{' '}
            <code>{row.fromRelease?.slice(0, 8) ?? 'none'}</code> to{' '}
            <code>{row.toRelease.slice(0, 8)}</code> · {row.phase}
            {row.error === null ? '' : ` — ${row.error}`}
          </li>
        ))}
        {(journal.data?.activations ?? []).length === 0 && (
          <li className="launcher__empty">Nothing activated yet.</li>
        )}
      </ul>
    </section>
  );
}
