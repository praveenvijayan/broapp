/**
 * `broapp-autoapp/knowledge` — what the engineer did, written down.
 *
 * Host code only. It opens a SQLite file and spawns `git`; a browser bundle
 * that reached it would be a bug.
 */
export {
  BLOB_RETENTION_MS,
  EVENT_RETENTION_MS,
  KNOWLEDGE_FILE,
  MAX_EVENTS,
  ftsQuery,
  openKnowledge,
  sha256,
  signature,
  tokens,
} from './store.ts';
export type { Knowledge, OpenKnowledgeOptions } from './store.ts';

export { createEventLog, eventData, sanitise } from './log.ts';
export type { EventKind, EventLog, EventLogOptions, Origin } from './log.ts';

export { origin, sourceRevision } from './ids.ts';
export type { FullOrigin } from './ids.ts';

export { createEvidence, exampleHash, recordContext } from './evidence.ts';
export type { ContextInput, EpisodeRow, Evidence, OpenEpisode } from './evidence.ts';

export { AUTOAPP_VERSION } from './version.ts';
