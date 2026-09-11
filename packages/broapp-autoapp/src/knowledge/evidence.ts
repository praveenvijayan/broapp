/**
 * Cases: a failure, the edits after it, and the build or check that passed.
 *
 * A case is opened when the engineer meets a failure, with everything that was
 * true at that moment — the person's request, the context the turn was given,
 * the source revision, the release that was running, the model. Edits are
 * appended while it is open. It is resolved once, by the first build that ran
 * its stage without the failure, or the first passing run of its acceptance
 * example, with the revision and release that repaired it. After that it does
 * not change: a later step may learn from it or replay it, and neither is
 * worth anything if the thing learned from can move.
 *
 * The store refuses a change to a resolved case itself (see the triggers in
 * `store.ts`), so a caller cannot get this wrong by accident. A caller that
 * tries gets an `Error`, catches it, and logs it; a case is never a reason for
 * a tool to fail.
 */
import type { DeliveredContext } from 'broapp/ai/host';
import { canonicalJson } from 'broapp/host';

import { redact } from '../host/run-store.ts';
import type { AcceptanceExample } from '../spec/index.ts';

import type { FullOrigin } from './ids.ts';
import { sanitise, type EventLog } from './log.ts';
import { sha256, signature, type Knowledge } from './store.ts';

/** What a case is opened with. */
export interface OpenEpisode {
  readonly appId: string;
  readonly stage: 'contract' | 'views' | 'page' | 'host' | 'spec' | 'check';
  readonly problem: string;
  /** Check cases only: the acceptance example as it was when it failed. */
  readonly example?: { readonly id: string; readonly content: unknown };
  readonly request: string;
  readonly contextId: number | null;
  readonly origin: FullOrigin;
  readonly releaseBefore: string | null;
  readonly dataSnapshot: string | null;
  readonly model: { readonly provider: string; readonly id: string } | null;
  readonly autoappVersion: string;
}

/** One case, as stored. */
export interface EpisodeRow {
  readonly id: number;
  readonly appId: string;
  readonly stage: string;
  readonly signature: string;
  readonly problem: string;
  readonly exampleId: string;
  readonly exampleHash: string;
  readonly exampleBlob: string | null;
  readonly requestBlob: string;
  readonly contextId: number | null;
  readonly runId: string;
  readonly callId: string;
  readonly sourceRevBefore: string;
  readonly releaseBefore: string | null;
  readonly dataSnapshot: string | null;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly autoappVersion: string;
  readonly edits: string;
  readonly openedAt: number;
  readonly resolvedAt: number | null;
  readonly resolvedRunId: string | null;
  readonly sourceRevAfter: string | null;
  readonly releaseAfter: string | null;
  readonly diagnosis: string | null;
  readonly distillState: string;
  readonly distillAttempts: number;
}

/** Opening, appending to and resolving cases. */
export interface Evidence {
  /** The new case's id, or `null` when the same case is already open. */
  open(input: OpenEpisode): number | null;
  /** To every open case of the application, capped at 8,000 characters. */
  appendEdit(appId: string, summary: string): void;
  /** Resolve every open build case of the application whose stage ran. */
  resolveBuild(
    appId: string,
    stagesRun: readonly string[],
    origin: FullOrigin,
    releaseAfter: string | null,
  ): number[];
  /** Resolve the open check case for exactly this version of an example. */
  resolveCheck(appId: string, exampleHash: string, origin: FullOrigin, releaseAfter: string): number[];
  openCases(appId: string): readonly EpisodeRow[];
  get(id: number): EpisodeRow | null;
}

/** The most an episode's edit log may hold. */
const MAX_EDITS = 8_000;

/** The stages a build resolves; a check case is never resolved by a build. */
const BUILD_STAGE_NAMES: readonly string[] = ['spec', 'contract', 'views', 'page', 'host'];

/**
 * The identity of one acceptance example: the hash of its canonical JSON.
 *
 * Its content rather than its id, because an example whose `expect` was edited
 * is a different check even under the same name, and a pass of the new one
 * says nothing about the old.
 */
export function exampleHash(example: AcceptanceExample): string {
  return hashOf(example);
}

/** The first 32 hex characters of the `sha256` of a value's canonical JSON. */
function hashOf(value: unknown): string {
  return sha256(canonicalJson(value)).slice(0, 32);
}

interface Row {
  id: number;
  app_id: string;
  stage: string;
  signature: string;
  problem: string;
  example_id: string;
  example_hash: string;
  example_blob: string | null;
  request_blob: string;
  context_id: number | null;
  run_id: string;
  call_id: string;
  source_rev_before: string;
  release_before: string | null;
  data_snapshot: string | null;
  model_provider: string | null;
  model_id: string | null;
  autoapp_version: string;
  edits: string;
  opened_at: number;
  resolved_at: number | null;
  resolved_run_id: string | null;
  source_rev_after: string | null;
  release_after: string | null;
  diagnosis: string | null;
  distill_state: string;
  distill_attempts: number;
}

function toEpisode(row: Row): EpisodeRow {
  return {
    id: row.id,
    appId: row.app_id,
    stage: row.stage,
    signature: row.signature,
    problem: row.problem,
    exampleId: row.example_id,
    exampleHash: row.example_hash,
    exampleBlob: row.example_blob,
    requestBlob: row.request_blob,
    contextId: row.context_id,
    runId: row.run_id,
    callId: row.call_id,
    sourceRevBefore: row.source_rev_before,
    releaseBefore: row.release_before,
    dataSnapshot: row.data_snapshot,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    autoappVersion: row.autoapp_version,
    edits: row.edits,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    resolvedRunId: row.resolved_run_id,
    sourceRevAfter: row.source_rev_after,
    releaseAfter: row.release_after,
    diagnosis: row.diagnosis,
    distillState: row.distill_state,
    distillAttempts: row.distill_attempts,
  };
}

/** An empty run id is no run id. */
function nullable(value: string): string | null {
  return value === '' ? null : value;
}

/** Build the evidence writer over a knowledge store. */
export function createEvidence(knowledge: Knowledge, log: EventLog): Evidence {
  const { db } = knowledge;

  /** Resolve each id in one transaction; returns the ones that were still open. */
  function resolve(ids: readonly number[], origin: FullOrigin, releaseAfter: string | null): number[] {
    const done: number[] = [];
    db.transaction(() => {
      for (const id of ids) {
        const changes = db
          .query<null, [number, string | null, string, string | null, number]>(
            `UPDATE episodes SET resolved_at = ?, resolved_run_id = ?, source_rev_after = ?, release_after = ?
              WHERE id = ? AND resolved_at IS NULL`,
          )
          .run(Date.now(), nullable(origin.runId), origin.sourceRev, releaseAfter, id).changes;
        if (changes > 0) done.push(id);
      }
    })();
    if (done.length > 0) {
      log.event('log', `resolved ${String(done.length)} case(s)`, undefined, origin);
    }
    return done;
  }

  return {
    open(input) {
      const problem = sanitise(input.problem);
      const stamp = signature(input.stage, problem);
      const example = input.example;
      return db.transaction((): number | null => {
        const requestBlob = knowledge.putBlob(sanitise(input.request));
        const exampleBlob =
          example === undefined ? null : knowledge.putBlob(sanitise(canonicalJson(redact(example.content))));
        const inserted = db
          .query<
            null,
            [
              string,
              string,
              string,
              string,
              string,
              string,
              string | null,
              string,
              number | null,
              string,
              string,
              string,
              string | null,
              string | null,
              string | null,
              string | null,
              string,
              number,
            ]
          >(
            `INSERT OR IGNORE INTO episodes
               (app_id, stage, signature, problem, example_id, example_hash, example_blob,
                request_blob, context_id, run_id, call_id, source_rev_before, release_before,
                data_snapshot, model_provider, model_id, autoapp_version, opened_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.appId,
            input.stage,
            stamp,
            problem,
            example?.id ?? '',
            example === undefined ? '' : hashOf(example.content),
            exampleBlob,
            requestBlob,
            input.contextId,
            input.origin.runId,
            input.origin.callId,
            input.origin.sourceRev,
            input.releaseBefore,
            input.dataSnapshot,
            input.model?.provider ?? null,
            input.model?.id ?? null,
            input.autoappVersion,
            Date.now(),
          );
        // The partial unique index makes the same case, still open, a no-op.
        return inserted.changes === 0 ? null : Number(inserted.lastInsertRowid);
      })();
    },

    appendEdit(appId, summary) {
      // Appended, and cut at the cap from the end: what a case was opened with
      // and the first edits after it are the part worth keeping whole.
      db.query<null, [string, number, string]>(
        `UPDATE episodes
            SET edits = substr(edits || CASE WHEN edits = '' THEN '' ELSE char(10, 10) END || ?, 1, ?)
          WHERE app_id = ? AND resolved_at IS NULL AND length(edits) < ${String(MAX_EDITS)}`,
      ).run(sanitise(summary), MAX_EDITS, appId);
    },

    resolveBuild(appId, stagesRun, origin, releaseAfter) {
      const stages = stagesRun.filter((stage) => BUILD_STAGE_NAMES.includes(stage));
      if (stages.length === 0) return [];
      const marks = stages.map(() => '?').join(', ');
      const ids = db
        .query<{ id: number }, string[]>(
          `SELECT id FROM episodes WHERE app_id = ? AND resolved_at IS NULL AND stage IN (${marks}) ORDER BY id`,
        )
        .all(appId, ...stages)
        .map((row) => row.id);
      return resolve(ids, origin, releaseAfter);
    },

    resolveCheck(appId, hash, origin, releaseAfter) {
      const ids = db
        .query<{ id: number }, [string, string]>(
          `SELECT id FROM episodes
            WHERE app_id = ? AND stage = 'check' AND example_hash = ? AND resolved_at IS NULL ORDER BY id`,
        )
        .all(appId, hash)
        .map((row) => row.id);
      return resolve(ids, origin, releaseAfter);
    },

    openCases(appId) {
      return db
        .query<Row, [string]>('SELECT * FROM episodes WHERE app_id = ? AND resolved_at IS NULL ORDER BY id')
        .all(appId)
        .map(toEpisode);
    },

    get(id) {
      const row = db.query<Row, [number]>('SELECT * FROM episodes WHERE id = ?').get(id);
      return row === null ? null : toEpisode(row);
    },
  };
}

/** What {@link recordContext} writes. */
export interface ContextInput {
  readonly runId: string;
  readonly appId: string | null;
  readonly instructions: string;
  readonly delivered: DeliveredContext;
  readonly requested: readonly string[];
  readonly resolved: readonly string[];
}

/**
 * Write down exactly what one turn was given.
 *
 * Verbatim, not sanitised: this is the evidence of what a model saw, and a
 * record that differs from it by one substitution is a record of something
 * that did not happen. It is the launcher's own text — the instructions, the
 * system prompt it built — and whatever documents were delivered, which the
 * provider was already sent.
 */
export function recordContext(knowledge: Knowledge, input: ContextInput): number {
  const { db } = knowledge;
  return db.transaction((): number => {
    const instructionsBlob = knowledge.putBlob(input.instructions);
    const systemBlob = knowledge.putBlob(input.delivered.system);
    const included = input.delivered.documents.map((document) => ({
      ref: document.ref,
      blob: knowledge.putBlob(document.content),
      truncated: document.content.endsWith('\n[truncated]'),
    }));
    const corpusVersion =
      db.query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM corpus_versions').get()?.v ?? 0;
    db.query<null, [string, string | null, number, string, string, string, string, string, number]>(
      `INSERT INTO contexts
         (run_id, app_id, corpus_version, instructions_blob, system_blob, requested, resolved, included, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO NOTHING`,
    ).run(
      input.runId,
      input.appId,
      corpusVersion,
      instructionsBlob,
      systemBlob,
      JSON.stringify(input.requested),
      JSON.stringify(input.resolved),
      JSON.stringify(included),
      Date.now(),
    );
    return (
      db.query<{ id: number }, [string]>('SELECT id FROM contexts WHERE run_id = ?').get(input.runId)?.id ?? 0
    );
  })();
}
