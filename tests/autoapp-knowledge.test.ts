/**
 * Knowledge: what the engineer did, written down with the identity it had.
 *
 * Three properties run through the file. Every row carries the run, call and
 * source revision it had when it was written, or `NULL` — nothing is attributed
 * afterwards. A failure and its repair are a case the store refuses to change
 * once it is resolved. And a candidate survives a restart, saying which of its
 * checks still hold.
 *
 * Store-only cases use a fresh directory under the system's temporary
 * directory. Cases that build a workspace put it under `tests/.autoapp-run/`
 * instead, inside the repository, for the reason `autoapp-engineer.test.ts`
 * gives: a copied workspace has no `node_modules` of its own and resolves
 * `broapp` by walking up to this checkout's.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiContract } from 'broapp/ai';
import { createFakeAdapter } from 'broapp/ai/host';
import { createGate, createPendingApprovals } from 'broapp/host';
import type { Envelope, Gate, HostLogger } from 'broapp/host';
import { mergeContracts } from 'broapp/shared';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import {
  ENGINEER_INSTRUCTIONS,
  INSTRUCTION_SECTIONS,
  createCandidateStates,
  engineerTools,
  searchWorkspace,
  type CandidateStates,
  type TurnRecord,
} from 'broapp-autoapp/engineer';
import {
  AUTOAPP_VERSION,
  KNOWLEDGE_FILE,
  SEED_LESSONS,
  createDistiller,
  createEventLog,
  createEvidence,
  createServe,
  ftsQuery,
  indexWorkspace,
  instructionsHash,
  openKnowledge,
  recordContext,
  reviewFlags,
  seedLessons,
  openSession,
  orientation,
  problemSignature,
  sanitise,
  scoreCheck,
  scoreRunEnd,
  signature,
  taskEvidence,
  tokens,
  type Distiller,
  type EventLog,
  type Evidence,
  type FullOrigin,
  type Knowledge,
  type Serve,
  type Session,
} from 'broapp-autoapp/knowledge';
import {
  BUILD_STAGES,
  LAUNCHER_MAX_STEPS,
  SOURCE,
  STAGE_NAMES,
  buildCandidate,
  createApplication,
  createLauncherApp,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  listApps,
  openJournal,
  type Journal,
  type LauncherTab,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout, setCurrent, type Layout } from 'broapp-autoapp/spec';

import { ensureLauncher, LAUNCHER } from './autoapp-launcher.ts';
import { STARTER, STARTER_VERSIONS } from './autoapp-template.ts';
import { harness, until, type Harness } from './harness.ts';

const fixture = join(import.meta.dir, 'fixtures', 'autoapp-app');
const runRoot = join(import.meta.dir, '.autoapp-run');

const failure = await ensureLauncher();
if (failure !== null) {
  console.warn(`[autoapp-knowledge] children skipped: the launcher would not build\n${failure}`);
}
const available = failure === null;

const quiet: HostLogger = { warn: () => undefined, error: () => undefined };

/** Directories and handles one test made, all released in `afterEach`. */
const scratch: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
let live: Harness | null = null;

afterEach(async () => {
  await live?.stop();
  live = null;
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Cleanup carries on; the next close may be the one that matters.
    }
  }
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (existsSync(runRoot) && readdirSync(runRoot).length === 0) {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

/** A fresh temporary directory, removed after the test. */
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'autoapp-'));
  scratch.push(directory);
  return directory;
}

/** Run git in a directory with an identity, so a machine without one still commits. */
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** Every event of one kind, oldest first. */
interface EventRow {
  id: number;
  level: string;
  source: string;
  kind: string;
  app_id: string | null;
  run_id: string | null;
  call_id: string | null;
  release_id: string | null;
  source_rev: string | null;
  message: string;
  data: string | null;
}
function events(knowledge: Knowledge, kind: string): EventRow[] {
  return knowledge.db
    .query<EventRow, [string]>('SELECT * FROM events WHERE kind = ? ORDER BY id')
    .all(kind);
}

/** Everything one workspace test built. */
interface World {
  readonly root: Layout;
  readonly directory: string;
  readonly source: string;
  readonly journal: Journal;
  readonly supervisor: Supervisor;
  readonly store: RunStore;
  readonly gate: Gate;
  readonly states: CandidateStates;
  readonly knowledge: Knowledge;
  readonly log: EventLog;
  readonly evidence: Evidence;
  readonly tools: ReturnType<typeof engineerTools>;
  readonly session: Session;
  readonly serve: Serve | null;
}

/** A launcher root with the fixture as the `items` workspace, and knowledge beside it. */
function makeWorld(
  options: { git?: boolean; turn?: (runId: string) => TurnRecord | undefined; serve?: boolean } = {},
): World {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'knowledge-'));
  scratch.push(directory);
  const root = layout(directory);
  const app = root.app('items');
  mkdirSync(app.dir, { recursive: true });
  cpSync(fixture, app.source, { recursive: true });
  if (options.git === true) {
    git(app.source, 'init', '--quiet');
    git(app.source, 'add', '-A');
    git(app.source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'the fixture');
  }

  const dataDir = join(directory, 'launcher');
  const knowledge = openKnowledge(dataDir);
  const log = createEventLog(knowledge, { source: 'launcher', tee: quiet });
  const evidence = createEvidence(knowledge, log);
  const store = createRunStore(dataDir, quiet);
  const gate = createGate({
    appId: 'launcher',
    releaseId: 'launcher',
    confirmTimeoutMs: 5_000,
    recorder: store.recorder(),
    logger: quiet,
  });
  const journal = openJournal(root.journal);
  const supervisor = createSupervisor({ execPath: LAUNCHER, logger: quiet });
  const states = createCandidateStates(root, quiet);
  const session = openSession(dataDir, quiet);
  const serve =
    options.serve === true
      ? createServe({
          knowledge,
          log,
          layout: root,
          states,
          session,
          instructions: ENGINEER_INSTRUCTIONS,
          apps: () => listApps(root, supervisor, journal),
        })
      : null;
  const tools = engineerTools({
    layout: root,
    supervisor,
    journal,
    gate,
    states,
    logger: quiet,
    template: STARTER,
    versions: STARTER_VERSIONS,
    install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
    initGit: () => false,
    session,
    knowledge: {
      log,
      evidence,
      autoappVersion: AUTOAPP_VERSION,
      store: knowledge,
      ...(serve === null ? {} : { serve }),
      ...(options.turn === undefined ? {} : { turn: options.turn }),
    },
  });

  closers.push(
    () => supervisor.stopAll(5_000),
    () => journal.close(),
    () => store.close(),
    () => knowledge.close(),
  );
  return { root, directory, source: app.source, journal, supervisor, store, gate, states, knowledge, log, evidence, tools, session, serve };
}

/** Call one tool as the engineer, answering its question if it asks one. */
async function callTool(
  where: World,
  name: string,
  input: unknown,
  options: { approve?: boolean; id?: string } = {},
): Promise<unknown> {
  const approvals = createPendingApprovals(quiet);
  const tool = where.tools[name];
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  const envelope: Envelope = {
    requestId: options.id ?? `run-1:${name}-${String(Math.random()).slice(2, 8)}`,
    channel: 'ai',
    caller: 'ai:test',
    approver: approvals,
  };
  const running = tool.execute(input, envelope, new AbortController().signal);
  if (options.approve !== undefined) {
    while (approvals.pending.length === 0) await Bun.sleep(5);
    const question = approvals.pending[0];
    if (question === undefined) throw new Error('nothing to answer');
    approvals.answer({
      requestId: question.requestId,
      approved: options.approve,
      releaseId: question.releaseId,
      argumentsHash: question.argumentsHash,
    });
  }
  return await running;
}

/** Replace a line of a workspace file, whatever its line endings. */
function rewrite(path: string, find: RegExp, replace: string): void {
  const before = readFileSync(path, 'utf8');
  const after = before.replace(find, replace);
  if (after === before) throw new Error(`nothing matched ${String(find)} in ${path}`);
  writeFileSync(path, after);
}

/** An origin for a case opened by hand. */
function handOrigin(runId: string): FullOrigin {
  return { runId, callId: 'c0', appId: 'items', sourceRev: 'no-git' };
}

describe('the store', () => {
  test('FTS5 exists; every table is created; reopening changes nothing; close leaves no WAL', () => {
    const memory = new Database(':memory:');
    memory.exec("CREATE VIRTUAL TABLE probe USING fts5(summary, trigger, tokenize='unicode61')");
    memory.close();

    const directory = tempDir();
    const first = openKnowledge(directory);
    const tables = first.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of ['blobs', 'events', 'contexts', 'corpus_versions', 'episodes', 'lessons', 'lessons_fts', 'servings']) {
      expect(tables).toContain(table);
    }
    const version = first.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
    const hash = first.putBlob('the same words');
    expect(first.putBlob('the same words')).toBe(hash);
    expect(first.getBlob(hash)).toBe('the same words');
    first.close();

    const again = openKnowledge(directory);
    expect(again.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(version);
    expect(again.getBlob(hash)).toBe('the same words');
    again.close();
    again.close();
    expect(existsSync(join(directory, `${KNOWLEDGE_FILE}-wal`))).toBe(false);
  });

  test('retention drops old events and orphaned blobs, and keeps what a case refers to', () => {
    const directory = tempDir();
    const knowledge = openKnowledge(directory);
    const log = createEventLog(knowledge, { source: 'test' });
    const evidence = createEvidence(knowledge, log);
    log.event('log', 'an old line');
    const orphan = knowledge.putBlob('nobody refers to this');
    const id = evidence.open({
      appId: 'items',
      stage: 'host',
      problem: 'it broke',
      request: 'kept because a case refers to it',
      contextId: null,
      origin: handOrigin('r-keep'),
      releaseBefore: null,
      dataSnapshot: null,
      model: null,
      autoappVersion: AUTOAPP_VERSION,
    });
    const requestBlob = evidence.get(id ?? 0)?.requestBlob ?? '';
    knowledge.close();

    const later = openKnowledge(directory, { now: Date.now() + 31 * 86_400_000 });
    expect(later.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(0);
    expect(later.getBlob(orphan)).toBeNull();
    expect(later.getBlob(requestBlob)).toBe('kept because a case refers to it');
    expect(later.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM episodes').get()?.n).toBe(1);
    later.close();
  });

  test('a signature ignores path, line, quoted name and hash, and not the stage', () => {
    const one = signature(
      'contract',
      "/Users/somebody/root/apps/items/source/src/shared/contract.ts:12:5 route 'items.ping' has no effect (0123456789abcdef)",
    );
    const two = signature(
      'contract',
      "/tmp/elsewhere/apps/items/source/src/shared/contract.ts:40:1 route 'items.list' has no effect (fedcba9876543210)",
    );
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(two).toBe(one);
    expect(signature('views', "/tmp/x/apps/items/source/src/shared/contract.ts:1:1 route 'a' has no effect (01234567)")).not.toBe(one);
    // Which file inside the workspace is part of what went wrong.
    expect(signature('host', 'src/host/app.ts broke')).not.toBe(signature('host', 'src/host/db.ts broke'));
    // A build's temporary directory is random; its last segment is not.
    expect(signature('contract', 'at /var/folders/ab/T/autoapp-build-Xy12Ab/shared/contract.js: bad')).toBe(
      signature('contract', 'at /tmp/autoapp-build-Q9w8E7/shared/contract.js: bad'),
    );
  });

  test('tokens and the query drop the vocabulary, numbers and hashes, and OR what is left', () => {
    const message =
      "/Users/me/root/apps/items/source/src/host/app.ts:12:5 error: Cannot find module 'bun:sqlite' in handler 0123abcd4567ef89";
    const words = tokens(message);
    expect(words).not.toContain('src');
    expect(words).not.toContain('ts');
    expect(words).not.toContain('error');
    expect(words.some((word) => /^\d+$/.test(word))).toBe(false);
    expect(words).not.toContain('0123abcd4567ef89');
    expect(words).toContain('sqlite');

    const query = ftsQuery(message);
    expect(query).not.toBeNull();
    const parts = (query ?? '').split(' OR ');
    expect(parts.length).toBe(words.length);
    for (const part of parts) expect(part).toMatch(/^"[^"]+"$/);
    expect(ftsQuery('')).toBeNull();
    expect(ftsQuery('the and of 12 to')).toBeNull();

    // And FTS5 reads it as intended: any one word matches.
    const memory = new Database(':memory:');
    memory.exec("CREATE VIRTUAL TABLE t USING fts5(summary, trigger, tokenize='unicode61')");
    memory.query('INSERT INTO t (summary, trigger) VALUES (?, ?)').run('bundle bun:sqlite as external', 'module');
    expect(memory.query('SELECT COUNT(*) AS n FROM t WHERE t MATCH ?').get(query ?? '')).toEqual({ n: 1 });
    memory.close();
  });

  test('the sanitiser and the allow-lists; a write that fails is counted and nothing else', () => {
    const directory = tempDir();
    const knowledge = openKnowledge(directory);
    const reported: string[] = [];
    const log = createEventLog(knowledge, {
      source: 'test',
      tee: { warn: () => undefined, error: (message) => reported.push(message) },
    });

    const hex = 'a1'.repeat(20);
    const home = homedir();
    log.event(
      'log',
      `apiKey=abc123secret Authorization: Bearer tok.en.value token ${hex} in ${home}/project/file.ts via http://user:pw@127.0.0.1:4000/?bt=launch`,
    );
    const [line] = events(knowledge, 'log');
    for (const gone of ['abc123secret', 'tok.en.value', hex, home, 'user:pw', 'bt=launch']) {
      expect(line?.message).not.toContain(gone);
    }
    expect(line?.message).toContain('~/project/file.ts');
    expect(line?.message).toContain('http://127.0.0.1:4000/');
    expect(sanitise('Bearer abc.def')).toBe('Bearer <redacted>');
    expect(sanitise('sk-ant-0123456789abcdef')).toBe('<redacted>');
    // A release id is 32 hex characters and survives; a SHA-256 does not.
    const releaseLike = '9c1d'.repeat(8);
    expect(sanitise(`built ${releaseLike}`)).toBe(`built ${releaseLike}`);
    expect(sanitise(`digest ${'f0'.repeat(32)}`)).toBe('digest <redacted>');

    // Only the fields the list names; an identifier stays an identifier.
    log.event('build', 'a build', {
      ok: false,
      releaseId: 'f'.repeat(32),
      stagesRun: ['spec'],
      problems: [{ stage: 'spec', message: `bad token=${hex}`, stack: 'at somewhere' }],
      ms: 12,
      home,
      secretPath: '/etc/passwd',
    });
    const [build] = events(knowledge, 'build');
    const data = JSON.parse(build?.data ?? '{}') as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['ms', 'ok', 'problems', 'releaseId', 'stagesRun']);
    expect(data['releaseId']).toBe('f'.repeat(32));
    expect(data['problems']).toEqual([{ message: 'bad token=<redacted>', stage: 'spec' }]);

    // A table that refuses: counted, reported once, nothing written; the next
    // write that lands says how many were lost.
    knowledge.db.exec('ALTER TABLE events RENAME TO events_away');
    expect(() => log.event('log', 'lost one')).not.toThrow();
    log.event('log', 'lost two');
    expect(log.stats().dropped).toBe(2);
    expect(reported).toHaveLength(1);
    knowledge.db.exec('ALTER TABLE events_away RENAME TO events');
    log.event('log', 'back again');
    expect(events(knowledge, 'dropped').map((row) => row.message)).toEqual(['2 events could not be written']);
    expect(events(knowledge, 'log').some((row) => row.message.startsWith('lost'))).toBe(false);

    // After close, likewise.
    knowledge.close();
    const before = log.stats();
    expect(() => log.event('log', 'after close')).not.toThrow();
    expect(log.stats().dropped).toBe(before.dropped + 1);
    expect(log.stats().written).toBe(before.written);
    const reopened = openKnowledge(directory);
    expect(events(reopened, 'log').some((row) => row.message === 'after close')).toBe(false);
    reopened.close();
  });

  test('no bare execute under src/knowledge/, and the stage lists agree', () => {
    const directory = join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'knowledge');
    for (const name of readdirSync(directory)) {
      expect(readFileSync(join(directory, name), 'utf8')).not.toMatch(/\bexecute\s*[:(]/);
    }
    expect([...STAGE_NAMES]).toEqual([...BUILD_STAGES]);
  });
});

describe('identity and cases', () => {
  test('an edit carries the run, the call and the revision it produced', async () => {
    const where = makeWorld({ git: true });
    await callTool(
      where,
      'source.edit',
      {
        appId: 'items',
        message: 'rename a column',
        hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }],
      },
      { approve: true, id: 'r1:c1' },
    );
    const [edit] = events(where.knowledge, 'edit');
    expect(edit?.run_id).toBe('r1');
    expect(edit?.call_id).toBe('c1');
    expect(edit?.app_id).toBe('items');
    expect(edit?.source_rev).toBe(git(where.source, 'rev-parse', 'HEAD'));
    expect(JSON.parse(edit?.data ?? '{}')).toMatchObject({ paths: ['src/shared/views.ts'], hunks: 1, matchedBy: ['exact'] });
  }, 60_000);

  test('a failure and its repair are one case that does not change once resolved', async () => {
    const where = makeWorld({
      git: true,
      turn: (runId) =>
        runId === 'r-ask' ? { message: 'give ping an effect', contextId: null, model: { provider: 'fake', id: 'fake-1' } } : undefined,
    });
    const contract = join(where.source, 'src', 'shared', 'contract.ts');
    rewrite(contract, / {6}effect: 'external',\r?\n/, '');
    git(where.source, 'commit', '--quiet', '--no-gpg-sign', '-am', 'drop an effect');
    const broken = git(where.source, 'rev-parse', 'HEAD');

    const failed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'r-ask:b1' })) as {
      ok: boolean;
    };
    expect(failed.ok).toBe(false);
    const [open] = where.evidence.openCases('items');
    if (open === undefined) throw new Error('no case was opened');
    expect(open.stage).toBe('contract');
    expect(open.runId).toBe('r-ask');
    expect(open.callId).toBe('b1');
    expect(open.sourceRevBefore).toBe(broken);
    expect(where.knowledge.getBlob(open.requestBlob)).toBe('give ping an effect');
    expect(open.modelProvider).toBe('fake');
    expect(open.autoappVersion).toBe(AUTOAPP_VERSION);
    const [build] = events(where.knowledge, 'build');
    expect(JSON.parse(build?.data ?? '{}')).toMatchObject({ ok: false, stagesRun: ['contract', 'views', 'page', 'host'] });

    // The same failure again, while the case is open, is the same case.
    await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'r-ask:b2' });
    expect(where.evidence.openCases('items')).toHaveLength(1);

    await callTool(
      where,
      'source.edit',
      {
        appId: 'items',
        message: 'first edit',
        hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }],
      },
      { approve: true, id: 'r-ask:e1' },
    );
    await callTool(
      where,
      'source.edit',
      {
        appId: 'items',
        message: 'second edit',
        hunks: [
          {
            path: 'src/shared/contract.ts',
            find: "summary: 'Pretend to reach outside this machine.',",
            replace: "effect: 'external',\n      summary: 'Pretend to reach outside this machine.',",
          },
        ],
      },
      { approve: true, id: 'r-ask:e2' },
    );
    const edited = where.evidence.get(open.id);
    expect(edited?.edits).toContain('first edit');
    expect(edited?.edits).toContain('second edit');

    const fixed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'r-fix:b3' })) as {
      ok: boolean;
      releaseId: string;
    };
    expect(fixed.ok).toBe(true);
    const resolved = where.evidence.get(open.id);
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.resolvedRunId).toBe('r-fix');
    expect(resolved?.sourceRevAfter).toBe(git(where.source, 'rev-parse', 'HEAD'));
    expect(resolved?.sourceRevAfter).not.toBe(resolved?.sourceRevBefore);
    expect(resolved?.releaseAfter).toBe(fixed.releaseId);

    // Evidence: the store itself refuses, whoever asks.
    const update = (sql: string): void => {
      where.knowledge.db.query(sql).run(open.id);
    };
    expect(() => update("UPDATE episodes SET problem = 'something else' WHERE id = ?")).toThrow(/written once/);
    expect(() => update('UPDATE episodes SET resolved_at = 1 WHERE id = ?')).toThrow(/written once/);
    expect(() => update("UPDATE episodes SET edits = 'rewritten' WHERE id = ?")).toThrow();
    // What a later step owns about a resolved case is still writable.
    expect(() => update("UPDATE episodes SET distill_state = 'done' WHERE id = ?")).not.toThrow();
    // An edit after the repair is not part of this case.
    where.evidence.appendEdit('items', 'after the fact');
    expect(where.evidence.get(open.id)?.edits).not.toContain('after the fact');
  }, 120_000);

  test('a case waits for a build that ran its stage', async () => {
    const where = makeWorld();
    const manifest = join(where.source, 'autoapp.json');
    const good = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, '{ not json');
    const spec = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(spec.ok).toBe(false);
    expect(spec.stagesRun).toEqual(['spec']);
    writeFileSync(manifest, good);

    const views = where.evidence.open({
      appId: 'items',
      stage: 'views',
      problem: 'a view names a route that is not there',
      request: '',
      contextId: null,
      origin: handOrigin('r-views'),
      releaseBefore: null,
      dataSnapshot: null,
      model: null,
      autoappVersion: AUTOAPP_VERSION,
    });
    if (views === null) throw new Error('the case was not opened');

    // A shared layer that will not bundle stops at the contract: the views were
    // never read, so nothing is known about them.
    const contract = join(where.source, 'src', 'shared', 'contract.ts');
    const source = readFileSync(contract, 'utf8');
    writeFileSync(contract, `${source}\nexport const broken = {;\n`);
    const stopped = await buildCandidate({ layout: where.root, appId: 'items' });
    expect(stopped.stagesRun).toEqual(['contract']);
    await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true });
    expect(where.evidence.get(views)?.resolvedAt).toBeNull();

    writeFileSync(contract, source);
    const built = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as { ok: boolean };
    expect(built.ok).toBe(true);
    expect(where.evidence.get(views)?.resolvedAt).not.toBeNull();
    expect(where.evidence.openCases('items')).toHaveLength(0);
  }, 120_000);
});

describe.skipIf(!available)('with children', () => {
  /** Set the one acceptance example, build, preview and check. */
  async function checkWith(where: World, expected: unknown): Promise<{ releaseId: string; passed: boolean }> {
    const manifestPath = join(where.source, 'autoapp.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { acceptance: unknown[] };
    manifest.acceptance = [
      { id: 'count', title: 'The count is right', steps: [{ route: 'items.list', input: null, expect: expected }] },
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const built = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as {
      ok: boolean;
      releaseId: string;
    };
    if (!built.ok) throw new Error('the build failed');
    await callTool(where, 'candidate.preview', { appId: 'items', releaseId: built.releaseId }, { approve: true });
    const checked = (await callTool(where, 'candidate.check', { appId: 'items', releaseId: built.releaseId })) as {
      results: { passed: boolean }[];
    };
    return { releaseId: built.releaseId, passed: checked.results[0]?.passed === true };
  }

  test('a check case is the example’s content, and only a pass of that content resolves it', async () => {
    const where = makeWorld();
    const host = join(where.source, 'src', 'host', 'app.ts');
    const good = readFileSync(host, 'utf8');
    // A host that miscounts, so an example can fail and later pass unchanged.
    rewrite(host, /count: store\.count\(\) \}/, 'count: store.count() + 1 }');

    const first = { items: [], count: 5 };
    expect((await checkWith(where, first)).passed).toBe(false);
    const second = { items: [], count: 0 };
    expect((await checkWith(where, second)).passed).toBe(false);
    const open = where.evidence.openCases('items').filter((row) => row.stage === 'check');
    // The same failure, with an edited `expect`, is a second case.
    expect(open).toHaveLength(2);
    expect(open[0]?.signature).toBe(open[1]?.signature);
    expect(open[0]?.exampleHash).not.toBe(open[1]?.exampleHash);

    // A passing build resolves neither: a build says nothing about a check.
    writeFileSync(host, good);
    const built = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as {
      ok: boolean;
      releaseId: string;
    };
    expect(built.ok).toBe(true);
    expect(where.evidence.openCases('items').filter((row) => row.stage === 'check')).toHaveLength(2);

    await callTool(where, 'candidate.preview', { appId: 'items', releaseId: built.releaseId }, { approve: true });
    const checked = (await callTool(where, 'candidate.check', { appId: 'items', releaseId: built.releaseId })) as {
      results: { passed: boolean }[];
    };
    expect(checked.results[0]?.passed).toBe(true);
    const [older, newer] = open;
    expect(where.evidence.get(older?.id ?? 0)?.resolvedAt).toBeNull();
    const resolved = where.evidence.get(newer?.id ?? 0);
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.releaseAfter).toBe(built.releaseId);
    expect(JSON.parse(where.knowledge.getBlob(resolved?.exampleBlob ?? '') ?? 'null')).toEqual({
      id: 'count',
      title: 'The count is right',
      steps: [{ route: 'items.list', input: null, expect: second }],
    });
    await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });
  }, 240_000);

  test('a restart resumes the candidate and says what is no longer verified', async () => {
    const where = makeWorld({ git: true });
    const { releaseId, passed } = await checkWith(where, { items: [], count: 0 });
    expect(passed).toBe(true);
    const before = where.states.status('items');
    expect(before.checksVerified).toBe(true);
    expect(before.previewLost).toBe(false);

    // What restarting the launcher does: every child goes, the memory goes.
    await where.supervisor.stopAll(5_000);
    const resumed = createCandidateStates(where.root, quiet);
    const state = resumed.get('items');
    expect(state.releaseId).toBe(releaseId);
    expect(state.problems).toEqual([]);
    expect(state.stagesRun).toEqual([...BUILD_STAGES]);
    expect(state.builtFromRev).toBe(git(where.source, 'rev-parse', 'HEAD'));
    const status = resumed.status('items');
    expect(status.checks).toHaveLength(1);
    expect(status.checksVerified).toBe(false);
    expect(status.previewLost).toBe(true);
    expect(status.previewRunning).toBe(false);
    expect(status.editsSinceBuild).toBe(false);

    writeFileSync(join(where.source, 'src', 'note.ts'), '// later\n');
    git(where.source, 'add', '-A');
    git(where.source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'a later change');
    await Bun.sleep(1_100);
    expect(resumed.status('items').editsSinceBuild).toBe(true);

    // The person starts the preview again, from the tab.
    expect(launcherContract.operations['launcher.previewStart'].effect).toBe('write');
    const app = createLauncherApp({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      states: resumed,
      gate: where.gate,
      logger: quiet,
      log: where.log,
      template: STARTER,
      versions: STARTER_VERSIONS,
      openBrowser: () => Promise.resolve(true),
    });
    live = await harness((bridge) => app.mount(bridge));
    const client = await live.connect(launcherContract);
    expect(await client.call('launcher.previewStart', { appId: 'items' })).toEqual({ previewRunning: true });
    const after = await client.call('launcher.candidateStatus', { appId: 'items' });
    expect(after.previewRunning).toBe(true);
    expect(after.previewLost).toBe(false);
    // A new child: the checks on record were about another one.
    expect(after.checksVerified).toBe(false);
    await client.close();
  }, 240_000);

  test('a child’s stderr is the child’s, with no run', async () => {
    const where = makeWorld();
    rewrite(
      join(where.source, 'src', 'host', 'app.ts'),
      /export function start\(context: AppStartContext\): Promise<AppInstance> \{/,
      "export function start(context: AppStartContext): Promise<AppInstance> {\n  console.error('hello from the child');",
    );
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));

    const teed: string[] = [];
    const log = createEventLog(where.knowledge, {
      source: 'launcher',
      tee: { warn: (line) => teed.push(line), error: (line) => teed.push(line) },
    });
    const supervisor = createSupervisor({ execPath: LAUNCHER, logger: log });
    closers.push(() => supervisor.stopAll(5_000));
    const app = where.root.app('items');
    mkdirSync(app.data, { recursive: true });
    const child = await supervisor.start({
      appId: 'items',
      releaseDir: app.release(built.releaseId),
      releaseId: built.releaseId,
      dataDir: app.data,
      mode: 'live',
    });
    await until(() => events(where.knowledge, 'stderr').some((row) => row.message.includes('hello from the child')), 10_000, 'the line');
    const line = events(where.knowledge, 'stderr').find((row) => row.message.includes('hello from the child'));
    expect(line?.source).toBe('child:items');
    expect(line?.run_id).toBeNull();
    expect(line?.app_id).toBe('items');
    expect(JSON.parse(line?.data ?? '{}')).toEqual({ pid: child.pid });
    // And the terminal still sees it, as it did before.
    expect(teed).toContain('[child] hello from the child');
    await child.shutdown(5_000);
  }, 120_000);
});

describe('the launcher tab', () => {
  test('writes down what a turn was given, how long it ran and what it cost', async () => {
    const where = makeWorld();
    const adapter = createFakeAdapter({
      script: [
        {
          kind: 'tool',
          name: 'source.edit',
          input: {
            appId: 'items',
            message: 'rename the label column',
            hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }],
          },
          then: [{ kind: 'text', chunks: ['renamed it'] }],
        },
      ],
    });
    const tab = createLauncherTab({
      layout: where.root,
      supervisor: where.supervisor,
      journal: where.journal,
      gate: where.gate,
      dataDir: join(where.directory, 'launcher'),
      store: where.store,
      template: STARTER,
      versions: STARTER_VERSIONS,
      install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
      initGit: () => false,
      providers: [adapter],
      fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), {
        preconnect: () => undefined,
      }) as typeof fetch,
      logger: quiet,
      openBrowser: () => Promise.resolve(true),
      knowledge: { store: where.knowledge, log: where.log, evidence: where.evidence },
    });
    expect(tab.knowledge).toBe(where.knowledge);
    live = await harness((bridge) => tab.mount(bridge));
    const client = await live.connect(mergeContracts(launcherContract, aiContract));
    await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });

    const runId = 'run-ctxtest1';
    const seen: { type: string; callId?: string; inputTokens?: number; outputTokens?: number }[] = [];
    let finished = false;
    await client.subscribe(
      'ai.chat',
      { runId, message: 'rename the column', refs: [], history: [] },
      {
        onEvent: (event) => {
          seen.push(event as (typeof seen)[number]);
          if (event.type === 'done' || event.type === 'error') finished = true;
        },
        onError: () => {
          finished = true;
        },
      },
    );
    while (!seen.some((event) => event.type === 'confirm')) await Bun.sleep(10);
    const asked = seen.find((event) => event.type === 'confirm');
    await client.call('ai.chatConfirm', { runId, callId: asked?.callId ?? '', approve: true });
    while (!finished) await Bun.sleep(10);
    await until(() => events(where.knowledge, 'run').length > 0, 5_000, 'the run event');
    await client.close();

    const context = where.knowledge.db
      .query<{ system_blob: string; instructions_blob: string; included: string; requested: string }, [string]>(
        'SELECT system_blob, instructions_blob, included, requested FROM contexts WHERE run_id = ?',
      )
      .get(runId);
    if (context === null) throw new Error('no context was recorded');
    const prompt = adapter.calls[0] as { role: string; content: unknown }[];
    const system = prompt.find((message) => message.role === 'system')?.content;
    expect(typeof system).toBe('string');
    expect(where.knowledge.getBlob(context.system_blob)).toBe(system as string);
    expect(where.knowledge.getBlob(context.instructions_blob)).toContain('apps.list');
    // Since 12b the only application's orientation and evidence are served
    // first; a lesson the words match may follow them.
    expect((JSON.parse(context.included) as { ref: string }[]).map((entry) => entry.ref).slice(0, 2)).toEqual([
      'digest:items',
      'evidence:items',
    ]);
    expect((JSON.parse(context.requested) as string[]).slice(0, 2)).toEqual(['digest:items', 'evidence:items']);

    // The edit carries the turn's own identity, from the real run loop.
    const [edit] = events(where.knowledge, 'edit');
    expect(edit?.run_id).toBe(runId);
    expect(edit?.call_id).toBe('call-0');

    const [run] = events(where.knowledge, 'run');
    expect(run?.run_id).toBe(runId);
    expect(JSON.parse(run?.data ?? '{}')).toMatchObject({ status: 'succeeded', steps: 1 });
    const usage = seen.find((event) => event.type === 'usage');
    const [cost] = events(where.knowledge, 'usage');
    expect(JSON.parse(cost?.data ?? '{}')).toEqual({
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
  }, 90_000);
});

// ── 12b: the knowledge path ────────────────────────────────────────────────

const signal = new AbortController().signal;

/** A world's serving, which these tests asked for. */
function served(where: World): Serve {
  if (where.serve === null) throw new Error('this world was built without serving');
  return where.serve;
}

/** The 1-based number of the first line containing `needle`. */
function lineOf(path: string, needle: string): number {
  return readFileSync(path, 'utf8').split(/\r?\n/).findIndex((line) => line.includes(needle)) + 1;
}

/** A launcher root whose `items` application was created from the starter, as `apps.create` makes one. */
async function makeStarterWorld(): Promise<{ root: Layout; source: string }> {
  mkdirSync(runRoot, { recursive: true });
  const directory = mkdtempSync(join(runRoot, 'knowledge-starter-'));
  scratch.push(directory);
  const root = layout(directory);
  const created = await createApplication({
    layout: root,
    template: STARTER,
    versions: STARTER_VERSIONS,
    appId: 'items',
    name: 'Items',
    install: () => Promise.resolve({ ok: true, detail: '' }),
    initGit: () => false,
    logger: quiet,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.problems));
  return { root, source: root.app('items').source };
}

/** The launcher tab over a world, with a fake model and, optionally, a small budget. */
function makeTab(where: World, adapter: ReturnType<typeof createFakeAdapter>, contextBudgetChars?: number): LauncherTab {
  return createLauncherTab({
    layout: where.root,
    supervisor: where.supervisor,
    journal: where.journal,
    gate: where.gate,
    dataDir: join(where.directory, 'launcher'),
    store: where.store,
    template: STARTER,
    versions: STARTER_VERSIONS,
    install: () => Promise.resolve({ ok: false, detail: 'no network in tests' }),
    initGit: () => false,
    providers: [adapter],
    fetch: Object.assign(() => Promise.reject(new Error('no network in tests')), {
      preconnect: () => undefined,
    }) as typeof fetch,
    logger: quiet,
    openBrowser: () => Promise.resolve(true),
    knowledge: { store: where.knowledge, log: where.log, evidence: where.evidence },
    ...(contextBudgetChars === undefined ? {} : { contextBudgetChars }),
  });
}

/** One chat turn over the harness, to its end and its `run` event. */
async function chat(where: World, tab: LauncherTab, runId: string, message: string): Promise<void> {
  live = await harness((bridge) => tab.mount(bridge));
  const client = await live.connect(mergeContracts(launcherContract, aiContract));
  await client.call('ai.settingsUpdate', { provider: 'fake', modelId: 'fake-1' });
  let finished = false;
  await client.subscribe(
    'ai.chat',
    { runId, message, refs: [], history: [] },
    {
      onEvent: (event) => {
        if (event.type === 'done' || event.type === 'error') finished = true;
      },
      onError: () => {
        finished = true;
      },
    },
  );
  while (!finished) await Bun.sleep(10);
  await until(() => events(where.knowledge, 'run').some((row) => row.run_id === runId), 5_000, 'the run event');
  await client.close();
}

/** The system prompt the fake model was sent first. */
function systemOf(adapter: ReturnType<typeof createFakeAdapter>): string {
  const prompt = adapter.calls[0] as { role: string; content: unknown }[];
  const system = prompt.find((message) => message.role === 'system')?.content;
  if (typeof system !== 'string') throw new Error('no system prompt was sent');
  return system;
}

/** The id of the seed with this summary. */
function seedId(knowledge: Knowledge, index: number): number {
  const summary = SEED_LESSONS[index]?.summary ?? '';
  const row = knowledge.db.query<{ id: number }, [string]>('SELECT id FROM lessons WHERE summary = ?').get(summary);
  if (row === null) throw new Error(`seed ${String(index)} is not stored`);
  return row.id;
}

describe('the knowledge path: documents', () => {
  test('the orientation says where the application stands, line by line', async () => {
    const where = makeWorld({ git: true });
    const first = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!first.ok) throw new Error(JSON.stringify(first.problems));
    setCurrent(where.root, 'items', first.releaseId);
    rewrite(join(where.source, 'src', 'shared', 'views.ts'), /header: 'Label'/, "header: 'What it is'");
    git(where.source, 'commit', '--quiet', '--no-gpg-sign', '-am', 'rename a column');
    const second = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!second.ok) throw new Error(JSON.stringify(second.problems));
    const rev = git(where.source, 'rev-parse', 'HEAD');
    // A built candidate, checks from a preview that is gone, and a preview the
    // launcher was running when it stopped.
    where.states.update('items', {
      releaseId: second.releaseId,
      builtFromRev: rev,
      builtAt: Date.now() - 180_000,
      problems: [],
      stagesRun: [...BUILD_STAGES],
      checks: {
        releaseId: second.releaseId,
        previewId: `${second.releaseId}:1`,
        examples: [{ id: 'list-works', hash: 'a'.repeat(32) }],
        results: [{ id: 'list-works', title: 'The list can be read', passed: true }],
        at: Date.now() - 60_000,
      },
      previewWasRunning: true,
    });
    const apps = listApps(where.root, where.supervisor, where.journal);
    const told = orientation({ layout: where.root, appId: 'items', states: where.states, apps });
    expect(told.text.split('\n')).toEqual([
      '## Items (items)',
      `Current release ${first.releaseId.slice(0, 8)} · schema v3 · serving: no`,
      `Candidate: ${second.releaseId.slice(0, 8)} built 3 minutes ago from ${rev.slice(0, 7)}`,
      'Edits since build: none',
      'Last build: ok',
      'Checks: passed 1/1 for an earlier preview — run again',
      'Preview: stopped when the launcher restarted — launcher.previewStart',
      'Next: launcher.previewStart (the person’s Start preview), or candidate.preview',
    ]);
    expect(told.hash).toMatch(/^[0-9a-f]{32}$/);

    // The workspace moves on: a fresh reading names the file and says build.
    writeFileSync(join(where.source, 'src', 'note.ts'), '// later\n');
    git(where.source, 'add', '-A');
    git(where.source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'a later change');
    const later = orientation({ layout: where.root, appId: 'items', states: createCandidateStates(where.root, quiet), apps });
    expect(later.text).toContain('Edits since build: 1 file (src/note.ts)');
    expect(later.text).toContain('Next: candidate.build');
  }, 120_000);

  test('the index finds the starter’s functions, operations and ids, and not an alias', async () => {
    const { root, source } = await makeStarterWorld();
    const host = join(source, 'src', 'host', 'app.ts');
    const index = indexWorkspace(source, 'no-git');
    const find = (kind: string, name: string) =>
      index.symbols.find((symbol) => symbol.kind === kind && symbol.name === name);
    expect(find('function', 'start')).toEqual({
      file: 'src/host/app.ts',
      line: lineOf(host, 'export function start('),
      kind: 'function',
      name: 'start',
    });
    expect(find('function', 'migrate')?.line).toBe(lineOf(host, 'export function migrate('));
    for (const route of ['items.list', 'items.add', 'items.update', 'items.remove', 'items.status']) {
      expect(find('operation', route)).toEqual({
        file: 'src/host/app.ts',
        line: lineOf(host, `app.operation('${route}'`),
        kind: 'operation',
        name: route,
      });
    }
    for (const id of ['items', 'add-item', 'items-table', 'counts']) {
      expect(find('component', id)?.file).toBe('src/shared/views.ts');
    }
    expect(find('migration', '001-create-items')?.file).toBe('autoapp.json');

    // Registered through an alias: the patterns do not follow it, and the
    // evidence says so rather than guessing.
    rewrite(host, /app\.operation\('items\.remove',/, "const register = app.operation.bind(app);\n  register('items.remove',");
    const aliased = indexWorkspace(source, 'no-git');
    expect(aliased.symbols.some((symbol) => symbol.kind === 'operation' && symbol.name === 'items.remove')).toBe(false);
    const evidence = taskEvidence({ layout: root, appId: 'items', tokens: ['remove'], index: aliased });
    expect(evidence.text).toContain('items.remove (write) — Remove one item. · handler: unknown — use source.search');
    expect(evidence.entries).toContainEqual({
      kind: 'symbol',
      name: 'items.remove',
      confidence: 'unknown',
      note: 'handler: use source.search',
    });
  }, 120_000);

  test('task evidence names the route, its handler and its example, or says nothing matched', async () => {
    const { root, source } = await makeStarterWorld();
    const index = indexWorkspace(source, 'no-git');
    const found = taskEvidence({ layout: root, appId: 'items', tokens: ['items', 'add'], index });
    const line = lineOf(join(source, 'src', 'host', 'app.ts'), "app.operation('items.add'");
    const lines = found.text.split('\n');
    expect(lines[0]).toBe('## Evidence for "items add" in items');
    expect(lines[1]).toBe(
      `Routes: items.add (write) — Add one item. · handler src/host/app.ts:${String(line)} [pattern] · shown by add-item [declared]`,
    );
    expect(found.text).toContain('list-works (touches items.list) [declared]');
    expect(found.text).toContain('Migrations: 1, last 001-create-items; next id 002-<slug>; append only [constraint]');
    // Every pattern entry is a file and a line; nothing is claimed without one.
    for (const entry of found.entries.filter((item) => item.confidence === 'pattern')) {
      expect(entry.file).toBeDefined();
      expect(entry.line).toBeGreaterThan(0);
    }

    const nothing = taskEvidence({ layout: root, appId: 'items', tokens: ['zebra'], index });
    expect(nothing.entries).toEqual([]);
    expect(nothing.text).toContain('Nothing in items matched these words.');
    for (const path of Object.values(SOURCE)) expect(nothing.text).toMatch(new RegExp(`${path.replace('.', '\\.')} \\d+ bytes`));
  }, 120_000);

  test('the application is the one named, else the one selected, else the only one', async () => {
    const where = makeWorld({ serve: true });
    const serve = served(where);
    mkdirSync(where.root.app('other').dir, { recursive: true });

    const named = await serve.search({ text: 'give other a tag column', limit: 8, runId: 'r-named' }, signal);
    expect(named.map((ref) => ref.ref).slice(0, 2)).toEqual(['digest:other', 'evidence:other']);

    where.session.select('items');
    const selected = await serve.search({ text: 'rename the label column', limit: 8, runId: 'r-selected' }, signal);
    expect(selected.map((ref) => ref.ref).slice(0, 2)).toEqual(['digest:items', 'evidence:items']);

    // Two applications, nothing selected, nothing named: nothing is served.
    const unselected = createServe({
      knowledge: where.knowledge,
      log: where.log,
      layout: where.root,
      states: where.states,
      session: openSession(tempDir(), quiet),
      instructions: ENGINEER_INSTRUCTIONS,
      apps: () => listApps(where.root, where.supervisor, where.journal),
    });
    expect(await unselected.search({ text: 'rename the label column', limit: 8, runId: 'r-none' }, signal)).toEqual([]);
    unselected.delivered('r-none', {
      system: '',
      documents: [],
      message: 'rename the label column',
      model: { provider: 'fake', id: 'fake-1' },
    });
    const last = events(where.knowledge, 'search').at(-1);
    expect(last?.run_id).toBe('r-none');
    expect(JSON.parse(last?.data ?? '{}')).toMatchObject({ hits: 0, requested: [], included: [] });
  }, 60_000);

  test('a turn is given its orientation, its evidence and a lesson its words match', async () => {
    const where = makeWorld();
    const adapter = createFakeAdapter({ script: [{ kind: 'text', chunks: ['ok'] }] });
    const runId = 'run-served1';
    await chat(where, makeTab(where, adapter), runId, 'add a button that goes back to the list page');

    const system = systemOf(adapter);
    expect(system).toContain('<document ref="digest:items"');
    expect(system).toContain('<document ref="evidence:items"');
    expect(system).toContain('<document ref="lessons:items"');
    // Nothing is built in this world, so the name is the id and the next step is a build.
    expect(system).toContain('## items (items)');
    expect(system).toContain('Next: candidate.build');

    const context = where.knowledge.db
      .query<{ included: string; app_id: string | null }, [string]>('SELECT included, app_id FROM contexts WHERE run_id = ?')
      .get(runId);
    expect(context?.app_id).toBe('items');
    expect((JSON.parse(context?.included ?? '[]') as { ref: string }[]).map((entry) => entry.ref)).toEqual([
      'digest:items',
      'evidence:items',
      'lessons:items',
    ]);
    const serving = where.knowledge.db
      .query<{ included: number; how: string; outcome: string | null }, [string, number]>(
        'SELECT included, how, outcome FROM servings WHERE run_id = ? AND lesson_id = ?',
      )
      .get(runId, seedId(where.knowledge, 0));
    // Delivered, and closed as `none` because the turn built nothing.
    expect(serving).toEqual({ included: 1, how: 'turn', outcome: 'none' });
  }, 90_000);

  test('a lesson the budget cut is recorded as not delivered, and never scored', async () => {
    const where = makeWorld();
    // A current release, so the evidence has routes and views to name and the
    // two documents before the lessons take most of a 1,000-character budget.
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    const adapter = createFakeAdapter({ script: [{ kind: 'text', chunks: ['ok'] }] });
    const runId = 'run-cut1';
    // Two lessons, each matched by two of the request's words (12c): the
    // navigation seed by "back", "button" and "page", the component-id seed by
    // "component" and "rename". Until 12c the second was the migration seed,
    // matched by "list" alone — the weak match 12c no longer serves.
    await chat(where, makeTab(where, adapter, 1_000), runId, 'add a back button to the page and rename its component');
    // The lessons document is cut: the first lesson's line arrived whole, the
    // second's did not.
    const system = systemOf(adapter);
    expect(system).toContain(`- ${SEED_LESSONS[0]?.summary ?? ''}\n`);
    expect(system).toContain('\n[truncated]');
    expect(system).not.toContain(SEED_LESSONS[4]?.summary ?? '');
    const servingOf = (index: number) =>
      where.knowledge.db
        .query<{ included: number; outcome: string | null }, [string, number]>(
          'SELECT included, outcome FROM servings WHERE run_id = ? AND lesson_id = ?',
        )
        .get(runId, seedId(where.knowledge, index));
    expect(servingOf(0)).toEqual({ included: 1, outcome: 'none' });
    // Resolved and then cut: recorded, never delivered, and never scored.
    expect(servingOf(4)).toEqual({ included: 0, outcome: null });
  }, 90_000);
});

describe('the knowledge path: hints, scoring and guidance', () => {
  test('a build failure returns the matching fact as a hint, recorded as a serving', async () => {
    const where = makeWorld({ serve: true });
    rewrite(join(where.source, 'src', 'shared', 'contract.ts'), / {6}effect: 'external',\r?\n/, '');
    const failed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'r-hint:b1' })) as {
      ok: boolean;
      hints?: { lessonId: number; status: string; text: string }[];
    };
    expect(failed.ok).toBe(false);
    const effect = failed.hints?.find((hint) => hint.lessonId === seedId(where.knowledge, 1));
    expect(effect).toEqual({ lessonId: seedId(where.knowledge, 1), status: 'confirmed', text: SEED_LESSONS[1]?.summary ?? '' });
    const row = where.knowledge.db
      .query<{ how: string; for_stage: string; for_signature: string; included: number; outcome: string | null }, [number]>(
        "SELECT how, for_stage, for_signature, included, outcome FROM servings WHERE lesson_id = ? AND run_id = 'r-hint'",
      )
      .get(effect?.lessonId ?? 0);
    expect(row).toMatchObject({ how: 'hint', for_stage: 'contract', included: 1, outcome: null });
    expect(row?.for_signature).toMatch(/^[0-9a-f]{32}$/);

    expect(served(where).hints('items', [{ stage: 'host', message: "Expected ';' but found '}'" }], handOrigin('r-host'))).toEqual([]);
  }, 120_000);

  test('servings are scored stage by stage, once, and a build never closes a check serving', async () => {
    const where = makeWorld({ serve: true });
    const { db } = where.knowledge;
    const contract = join(where.source, 'src', 'shared', 'contract.ts');
    const manifest = join(where.source, 'autoapp.json');
    const goodContract = readFileSync(contract, 'utf8');
    const goodManifest = readFileSync(manifest, 'utf8');
    const breakContract = (): void => rewrite(contract, / {6}effect: 'external',\r?\n/, '');
    interface Scored { outcome: string | null; attempt_call_id: string | null; attempt_kind: string | null; attempt_release: string | null }
    const of = (runId: string): Scored[] =>
      db
        .query<Scored, [string]>(
          'SELECT outcome, attempt_call_id, attempt_kind, attempt_release FROM servings WHERE run_id = ? ORDER BY id',
        )
        .all(runId);

    breakContract();
    await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'rA:b1' });
    expect(of('rA').length).toBeGreaterThan(0);
    expect(of('rA').every((row) => row.outcome === null)).toBe(true);

    // Stops at the manifest: the contract never ran, so nothing is known.
    writeFileSync(manifest, '{ not json');
    await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'rA:b2' });
    expect(of('rA').every((row) => row.outcome === null)).toBe(true);
    expect(
      events(where.knowledge, 'log').some(
        (row) => row.call_id === 'b2' && row.message.includes('waits: the build did not run contract'),
      ),
    ).toBe(true);

    writeFileSync(manifest, goodManifest);
    writeFileSync(contract, goodContract);
    const passed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'rA:b3' })) as {
      ok: boolean;
      releaseId: string;
    };
    expect(passed.ok).toBe(true);
    expect(of('rA').every((row) => row.outcome === 'resolved')).toBe(true);
    expect(of('rA')[0]).toEqual({ outcome: 'resolved', attempt_call_id: 'b3', attempt_kind: 'build', attempt_release: passed.releaseId });

    // The same failure, twice in a new run.
    breakContract();
    await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'rB:b4' });
    await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'rB:b5' });
    expect(of('rB').length).toBeGreaterThan(0);
    expect(of('rB').every((row) => row.outcome === 'recurred' && row.attempt_call_id === 'b5')).toBe(true);
    writeFileSync(contract, goodContract);

    // A check serving: no build closes it; only a check of its own example does.
    const hash = 'e'.repeat(32);
    db.query<null, [number, string, string, number]>(
      `INSERT INTO servings (lesson_id, run_id, app_id, how, for_signature, for_stage, for_example_hash, included, served_at)
       VALUES (?, 'rC', 'items', 'hint', ?, 'check', ?, 1, ?)`,
    ).run(seedId(where.knowledge, 0), problemSignature('check', 'items.list returned 1, not 0'), hash, Date.now());
    await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true, id: 'rC:b6' });
    expect(of('rC')[0]?.outcome).toBeNull();
    const results = [{ id: 'count', title: 'The count', passed: true }];
    scoreCheck(where.knowledge, 'items', results, [{ id: 'count', hash: 'f'.repeat(32) }], passed.releaseId, handOrigin('rC'));
    expect(of('rC')[0]?.outcome).toBeNull();
    scoreCheck(where.knowledge, 'items', results, [{ id: 'count', hash }], passed.releaseId, { ...handOrigin('rC'), callId: 'k1' });
    expect(of('rC')[0]).toEqual({ outcome: 'resolved', attempt_call_id: 'k1', attempt_kind: 'check', attempt_release: passed.releaseId });

    // A turn that ends with a serving nobody tested.
    served(where).hints(
      'items',
      [{ stage: 'contract', message: 'route "items.ping" must declare an effect before it can be part of an Autoapp release' }],
      handOrigin('rD'),
    );
    expect(of('rD').length).toBeGreaterThan(0);
    scoreRunEnd(where.knowledge, 'rD');
    expect(of('rD').every((row) => row.outcome === 'none')).toBe(true);
    // `blocked` is an event, never a stored outcome.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM servings WHERE outcome = 'blocked'").get()?.n).toBe(0);
  }, 240_000);

  test('the third unverified edit warns, and a build resets the count', async () => {
    const where = makeWorld();
    const edit = async (from: string, to: string): Promise<{ verification: unknown }> =>
      (await callTool(
        where,
        'source.edit',
        {
          appId: 'items',
          message: `${from} to ${to}`,
          hunks: [{ path: 'src/shared/views.ts', find: `header: '${from}'`, replace: `header: '${to}'` }],
        },
        { approve: true },
      )) as { verification: unknown };
    expect((await edit('Label', 'L1')).verification).toEqual({ editsSinceBuild: 1, lastBuild: 'none', next: 'candidate.build' });
    await edit('L1', 'L2');
    expect((await edit('L2', 'L3')).verification).toEqual({
      editsSinceBuild: 3,
      lastBuild: 'none',
      next: 'candidate.build',
      warning: 'three edits are unverified; build before editing more',
    });
    const built = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as { ok: boolean };
    expect(built.ok).toBe(true);
    expect((await edit('L3', 'L4')).verification).toEqual({ editsSinceBuild: 1, lastBuild: 'ok', next: 'candidate.build' });
  }, 120_000);

  test('source.search finds text and patterns in the workspace, and nothing outside it', async () => {
    const where = makeWorld();
    type Found = { hits: { path: string; line: number; text: string }[]; truncated: boolean };
    const literal = (await callTool(where, 'source.search', { appId: 'items', pattern: "header: 'Label'", literal: true })) as Found;
    expect(literal.truncated).toBe(false);
    expect(literal.hits.map((hit) => [hit.path, hit.line])).toEqual([
      ['src/shared/views.ts', lineOf(join(where.source, 'src', 'shared', 'views.ts'), "header: 'Label'")],
    ]);
    expect(literal.hits[0]?.text).toContain("header: 'Label'");

    const pattern = (await callTool(where, 'source.search', { appId: 'items', pattern: "app\\.operation\\('items\\.\\w+'" })) as Found;
    expect(pattern.hits).toHaveLength(3);
    expect(pattern.hits.every((hit) => hit.path === 'src/host/app.ts')).toBe(true);

    const many = (await callTool(where, 'source.search', { appId: 'items', pattern: '.' })) as Found;
    expect(many.hits).toHaveLength(50);
    expect(many.truncated).toBe(true);
    expect(many.hits.every((hit) => hit.path.startsWith('src/') && !hit.path.includes('..'))).toBe(true);
    expect(many.hits.every((hit) => hit.text.length <= 200)).toBe(true);

    await expect(callTool(where, 'source.search', { appId: 'items', pattern: '(' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const outside = (await callTool(where, 'source.search', { appId: 'items', pattern: '.', files: '../**' })) as Found;
    expect(outside.hits).toEqual([]);
  }, 60_000);
});

describe('the knowledge path: seeds and instructions', () => {
  test('the seeds are written once, a corpus version each, and repeat nothing the instructions say', () => {
    const directory = tempDir();
    const knowledge = openKnowledge(directory);
    closers.push(() => knowledge.close());
    const log = createEventLog(knowledge, { source: 'test', tee: quiet });
    const make = (): Serve =>
      createServe({
        knowledge,
        log,
        layout: layout(directory),
        states: createCandidateStates(undefined, quiet),
        session: openSession(directory, quiet),
        instructions: ENGINEER_INSTRUCTIONS,
        apps: () => [],
      });
    make();
    make();
    const count = (sql: string): number => knowledge.db.query<{ n: number }, []>(sql).get()?.n ?? -1;
    expect(SEED_LESSONS.length).toBeGreaterThanOrEqual(6);
    expect(SEED_LESSONS.length).toBeLessThanOrEqual(8);
    expect(count('SELECT COUNT(*) AS n FROM lessons')).toBe(SEED_LESSONS.length);
    expect(count('SELECT COUNT(*) AS n FROM lessons_fts')).toBe(SEED_LESSONS.length);
    expect(count('SELECT COUNT(DISTINCT lesson_id) AS n FROM corpus_versions')).toBe(SEED_LESSONS.length);
    expect(count('SELECT MAX(version) AS n FROM corpus_versions')).toBe(SEED_LESSONS.length);
    expect(
      count("SELECT COUNT(*) AS n FROM lessons WHERE origin = 'curated' AND status = 'confirmed' AND scope = 'global'"),
    ).toBe(SEED_LESSONS.length);

    const sentences = (text: string): string[] =>
      text
        .replace(/\s+/g, ' ')
        .split(/(?<=[.;:!?])\s+/)
        .map((sentence) => sentence.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').trim())
        .filter((sentence) => sentence !== '');
    const taught = new Set(sentences(ENGINEER_INSTRUCTIONS));
    for (const seed of SEED_LESSONS) {
      expect(seed.summary.length).toBeLessThan(300);
      for (const sentence of sentences(seed.summary)) expect(taught.has(sentence)).toBe(false);
    }
  });

  test('the instructions keep their sections and length, and say to read the documents first', () => {
    expect([...INSTRUCTION_SECTIONS]).toEqual([
      '# What you are',
      '# The workspace',
      '# How to work',
      '# What you may not do',
      '# How to describe a change',
    ]);
    expect(ENGINEER_INSTRUCTIONS.split('\n').length).toBeLessThanOrEqual(70);
    const flat = ENGINEER_INSTRUCTIONS.replace(/\s+/g, ' ');
    const first =
      'Each message comes with an orientation for the application and evidence for the request: read them before calling any tool. They say what is built, what is verified and what to do next.';
    expect(flat).toContain(first);
    expect(flat.indexOf(first)).toBeLessThan(flat.indexOf('1. Find the application'));
    expect(flat).toContain(
      'When a build fails, its `hints` are facts from earlier work; a hint marked provisional has not been confirmed.',
    );
  });
});

// ── 12c: step 0, carried over from the 12b review ─────────────────────────

/** The `code` a call refused with, or `'none'`. */
function refusedWith(call: () => unknown): string {
  try {
    call();
    return 'none';
  } catch (cause) {
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : 'not a PublicError';
  }
}

type Step = NonNullable<NonNullable<Parameters<typeof createFakeAdapter>[0]>['script']>[number];

describe('12c step 0: the carry-overs', () => {
  test("the launcher's turn may take forty steps, where the AI layer's default stops at eight", async () => {
    expect(LAUNCHER_MAX_STEPS).toBe(40);
    const where = makeWorld();
    // Nine read calls, one after another, then an answer: one more than eight.
    let script: Step[] = [{ kind: 'text', chunks: ['listed them'] }];
    for (let index = 0; index < 9; index += 1) script = [{ kind: 'tool', name: 'apps.list', input: {}, then: script }];
    const adapter = createFakeAdapter({ script });
    const runId = 'run-steps1';
    await chat(where, makeTab(where, adapter), runId, 'list the applications nine times');
    const run = events(where.knowledge, 'run').find((row) => row.run_id === runId);
    expect(JSON.parse(run?.data ?? '{}')).toMatchObject({ status: 'succeeded', steps: 9 });
  }, 90_000);

  test('a lesson is served on two shared words or a route the evidence names, not on one word; a hint needs one', async () => {
    const where = makeWorld({ serve: true });
    const built = await buildCandidate({ layout: where.root, appId: 'items' });
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    setCurrent(where.root, 'items', built.releaseId);
    const add = (summary: string, trigger: string, applies: Record<string, unknown>): number => {
      const id = Number(
        where.knowledge.db
          .query<null, [string, string, string]>(
            `INSERT INTO lessons (version, status, origin, scope, applies, summary, detail, trigger,
                                  instructions_hash, autoapp_version, created_at, updated_at)
             VALUES (99, 'confirmed', 'curated', 'global', ?, ?, 'detail', ?, 'h', '0.1.0', 0, 0)`,
          )
          .run(JSON.stringify(applies), summary, trigger).lastInsertRowid,
      );
      where.knowledge.db
        .query<null, [number, string, string]>('INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)')
        .run(id, summary, trigger);
      return id;
    };
    const weak = add('A colour is stored as plain text in the database.', 'palette shade', {});
    const strong = add('A tag reaches an item through a write route of its own.', 'label', {});
    const byRoute = add('Check the colour contrast before shipping.', 'contrast', { routes: ['items.add'] });

    const refs = (await served(where).search({ text: 'add an item with a colour tag', limit: 10, runId: 'r-weak' }, signal)).map(
      (ref) => ref.ref,
    );
    expect(refs).toContain(`lesson:${String(strong)}`);
    expect(refs).toContain(`lesson:${String(byRoute)}`);
    expect(refs).not.toContain(`lesson:${String(weak)}`);
    served(where).ended('r-weak');

    const hints = served(where).hints('items', [{ stage: 'views', message: 'the colour is wrong' }], handOrigin('r-weak-hint'));
    expect(hints.map((hint) => hint.lessonId)).toContain(weak);
  }, 120_000);

  test('the seventh seed says where saved workflows live', () => {
    expect(SEED_LESSONS).toHaveLength(7);
    const seed = SEED_LESSONS[6];
    expect(seed?.summary).toContain('Saved workflows and their promotion to a view action live in the application');
    expect(seed?.applies.stage).toBe('views');
  });

  test('the symbol index reads nothing through a symbolic link', () => {
    const where = makeWorld();
    const outside = tempDir();
    writeFileSync(join(outside, 'elsewhere.ts'), 'export function leakedElsewhere() {}\n');
    mkdirSync(join(outside, 'dir'));
    writeFileSync(join(outside, 'dir', 'more.ts'), 'export const leakedDirectory = 1;\n');
    symlinkSync(join(outside, 'elsewhere.ts'), join(where.source, 'src', 'host', 'elsewhere.ts'));
    symlinkSync(join(outside, 'dir'), join(where.source, 'src', 'linked'));

    const index = indexWorkspace(where.source, 'no-git');
    const names = index.symbols.map((symbol) => symbol.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('leakedElsewhere');
    expect(names).not.toContain('leakedDirectory');
    expect(index.symbols.some((symbol) => symbol.file.includes('elsewhere') || symbol.file.includes('linked'))).toBe(false);
    const evidence = taskEvidence({ layout: where.root, appId: 'items', tokens: ['leaked', 'elsewhere', 'directory'], index });
    expect(evidence.text).not.toContain('elsewhere.ts');
    expect(evidence.text).not.toContain('src/linked');
  });

  test('source.search refuses a nested quantifier and a long pattern, and still finds a literal', async () => {
    const where = makeWorld();
    expect(refusedWith(() => searchWorkspace(where.source, '(a+)+b'))).toBe('invalid_input');
    expect(refusedWith(() => searchWorkspace(where.source, 'x'.repeat(300)))).toBe('invalid_input');
    expect(searchWorkspace(where.source, "header: 'Label'", { literal: true }).hits).toHaveLength(1);
    // A literal is escaped before it is compiled, so its brackets are only text.
    expect(refusedWith(() => searchWorkspace(where.source, '(a+)+b', { literal: true }))).toBe('none');
    await expect(callTool(where, 'source.search', { appId: 'items', pattern: '(a+)+b' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  }, 60_000);

  test('a turn that never delivers is forgotten when it ends', async () => {
    const where = makeWorld({ serve: true });
    await served(where).search({ text: 'rename the label column', limit: 10, runId: 'r-never' }, signal);
    expect(served(where).inFlight()).toBe(1);
    // What the tab does in `onRunEnd`, beside `scoreRunEnd`.
    served(where).ended('r-never');
    scoreRunEnd(where.knowledge, 'r-never');
    expect(served(where).inFlight()).toBe(0);
  });
});

// ── 12c: distillation ──────────────────────────────────────────────────────

type Model = ReturnType<ReturnType<typeof createFakeAdapter>['model']>;

/** A `fetch` that refuses, for a fake adapter's configuration. */
const refuse = Object.assign(() => Promise.reject(new Error('no network in tests')), {
  preconnect: () => undefined,
}) as unknown as typeof fetch;

/** A fake model that answers each question in turn with one of these objects, as JSON text. */
function answering(
  answers: readonly unknown[],
  chunkDelayMs?: number,
): { adapter: ReturnType<typeof createFakeAdapter>; model: () => Promise<Model> } {
  const adapter = createFakeAdapter({
    script: answers.map((answer): Step => ({ kind: 'text', chunks: [JSON.stringify(answer)] })),
    ...(chunkDelayMs === undefined ? {} : { chunkDelayMs }),
  });
  return { adapter, model: () => Promise.resolve(adapter.model({ apiKey: null, baseUrl: null, fetch: refuse }, 'fake-1')) };
}

/** A case opened during a recorded turn and resolved by a later build, the way a turn leaves one. */
function resolvedCase(where: World, problem = 'route "items.tag" must declare an effect before it can be part of an Autoapp release'): number {
  const runId = `r-case-${String(Math.random()).slice(2, 8)}`;
  const contextId = recordContext(where.knowledge, {
    runId,
    appId: 'items',
    instructions: ENGINEER_INSTRUCTIONS,
    delivered: {
      system: 'the system prompt',
      documents: [{ ref: 'digest:items', title: 'Where items stands', content: '## Items (items)\nNext: candidate.build' }],
      message: 'add tags to items',
      model: { provider: 'fake', id: 'fake-1' },
    },
    requested: ['digest:items'],
    resolved: ['digest:items'],
  });
  const id = where.evidence.open({
    appId: 'items',
    stage: 'contract',
    problem,
    request: 'add tags to items',
    contextId,
    origin: handOrigin(runId),
    releaseBefore: null,
    dataSnapshot: null,
    model: { provider: 'fake', id: 'fake-1' },
    autoappVersion: AUTOAPP_VERSION,
  });
  if (id === null) throw new Error('that case is already open');
  where.evidence.appendEdit('items', 'declare the effect\n~ src/shared/contract.ts');
  where.evidence.resolveBuild('items', ['spec', 'contract'], { ...handOrigin(runId), sourceRev: 'b'.repeat(40) }, 'f'.repeat(32));
  return id;
}

function distillerOver(where: World, model: () => Promise<Model>): Distiller {
  const distiller = createDistiller({
    knowledge: where.knowledge,
    log: where.log,
    model,
    instructions: ENGINEER_INSTRUCTIONS,
    autoappVersion: AUTOAPP_VERSION,
  });
  closers.push(() => distiller.close());
  return distiller;
}

interface CaseState { diagnosis: string | null; distill_state: string; distill_attempts: number; signature: string }
function caseOf(knowledge: Knowledge, id: number): CaseState | null {
  return knowledge.db
    .query<CaseState, [number]>('SELECT diagnosis, distill_state, distill_attempts, signature FROM episodes WHERE id = ?')
    .get(id);
}

interface LessonState {
  id: number; version: number; status: string; review: string | null; origin: string; supersedes: number | null;
  diagnosis: string | null; scope: string; applies: string; summary: string; instructions_hash: string; autoapp_version: string;
}
function lessonFrom(knowledge: Knowledge, episodeId: number): LessonState | null {
  return knowledge.db.query<LessonState, [number]>('SELECT * FROM lessons WHERE episode_id = ?').get(episodeId);
}
function lessonById(knowledge: Knowledge, id: number): LessonState | null {
  return knowledge.db.query<LessonState, [number]>('SELECT * FROM lessons WHERE id = ?').get(id);
}
function inIndex(knowledge: Knowledge, id: number): boolean {
  return knowledge.db.query<{ rowid: number }, [number]>('SELECT rowid FROM lessons_fts WHERE rowid = ?').get(id) !== null;
}

const MISSING = {
  diagnosis: 'knowledge_missing',
  reasoning: 'Nothing the engineer was given said a new route needs an effect.',
  sameCauseAs: null,
  lesson: {
    scope: 'app',
    applies: { stage: 'contract', routes: ['items.tag'] },
    summary: 'A route added to contract.ts for tags must declare its effect as well as its summary before the build accepts it.',
    detail: 'The build refused items.tag at the contract stage until the route declared effect: write.',
    trigger: ['effect', 'tags', 'contract', 'route'],
  },
};

describe('12c: distillation', () => {
  test('knowledge_missing becomes a provisional lesson with its provenance, from what was recorded', async () => {
    const where = makeWorld();
    const id = resolvedCase(where);
    const { adapter, model } = answering([MISSING]);
    const distiller = distillerOver(where, model);
    distiller.enqueue([id]);
    await distiller.idle();

    const state = caseOf(where.knowledge, id);
    expect(state?.distill_state).toBe('done');
    expect(JSON.parse(state?.diagnosis ?? '{}')).toEqual({ diagnosis: 'knowledge_missing', reasoning: MISSING.reasoning });
    const lesson = lessonFrom(where.knowledge, id);
    expect(lesson).toMatchObject({
      status: 'provisional',
      review: null,
      origin: 'distilled',
      diagnosis: 'knowledge_missing',
      scope: 'app:items',
      supersedes: null,
      instructions_hash: instructionsHash(ENGINEER_INSTRUCTIONS),
      autoapp_version: AUTOAPP_VERSION,
    });
    expect(JSON.parse(lesson?.applies ?? '{}')).toEqual({ stage: 'contract', routes: ['items.tag'], signature: state?.signature });
    const latest = where.knowledge.db.query<{ v: number }, []>('SELECT MAX(version) AS v FROM corpus_versions').get()?.v;
    expect(lesson?.version).toBe(latest ?? -1);
    expect(inIndex(where.knowledge, lesson?.id ?? 0)).toBe(true);

    // The question was built from the blobs: the request, the instructions as
    // delivered, the problem, under the fixed system text.
    expect(adapter.calls).toHaveLength(1);
    const sent = JSON.stringify(adapter.calls[0]);
    expect(sent).toContain('add tags to items');
    expect(sent).toContain('You are the engineer for the applications on this computer.');
    expect(sent).toContain('must declare an effect');
    expect(sent).toContain('You are reviewing one failure the engineer hit');
  });

  test('insufficient_evidence is kept as a diagnosis and writes no lesson', async () => {
    const where = makeWorld();
    const id = resolvedCase(where);
    const distiller = distillerOver(
      where,
      answering([{ diagnosis: 'insufficient_evidence', reasoning: 'The edits do not say.', sameCauseAs: null, lesson: null }]).model,
    );
    distiller.enqueue([id]);
    await distiller.idle();
    expect(caseOf(where.knowledge, id)).toMatchObject({ distill_state: 'done' });
    expect(JSON.parse(caseOf(where.knowledge, id)?.diagnosis ?? '{}')).toMatchObject({ diagnosis: 'insufficient_evidence' });
    expect(lessonFrom(where.knowledge, id)).toBeNull();
  });

  test('a method_unclear lesson is stored, global, and never served or hinted', async () => {
    const where = makeWorld({ serve: true });
    const id = resolvedCase(where);
    const method = {
      diagnosis: 'method_unclear',
      reasoning: 'The instructions say to build, but not when.',
      sameCauseAs: null,
      lesson: {
        scope: 'app',
        applies: {},
        summary: 'Build after each coherent edit set, before planning the next file, so a failure names one change.',
        detail: 'The engineer made three edits and planned a fourth before any build.',
        trigger: ['build', 'edit', 'set', 'planning'],
      },
    };
    const distiller = distillerOver(where, answering([method]).model);
    distiller.enqueue([id]);
    await distiller.idle();
    const lesson = lessonFrom(where.knowledge, id);
    expect(lesson).toMatchObject({ status: 'provisional', diagnosis: 'method_unclear', scope: 'global' });
    const ref = `lesson:${String(lesson?.id ?? 0)}`;
    const refsFor = async (runId: string): Promise<string[]> => {
      const found = await served(where).search({ text: 'build after each edit set planning', limit: 10, runId }, signal);
      served(where).ended(runId);
      return found.map((entry) => entry.ref);
    };
    expect(await refsFor('r-m1')).not.toContain(ref);
    const hinted = served(where).hints('items', [{ stage: 'contract', message: 'build edit set planning' }], handOrigin('r-m2'));
    expect(hinted.map((hint) => hint.lessonId)).not.toContain(lesson?.id);
    // The same lesson under any other diagnosis is found by the same words, so
    // the refusal above is the filter and not a failure to match.
    where.knowledge.db.query<null, [number]>("UPDATE lessons SET diagnosis = 'knowledge_missing' WHERE id = ?").run(lesson?.id ?? 0);
    expect(await refsFor('r-m3')).toContain(ref);
  }, 60_000);

  test('knowledge_not_retrieved naming a seed records the miss', async () => {
    const where = makeWorld({ serve: true });
    const id = resolvedCase(where);
    const seed = seedId(where.knowledge, 1);
    const distiller = distillerOver(
      where,
      answering([{ diagnosis: 'knowledge_not_retrieved', reasoning: 'The effect seed says this.', sameCauseAs: seed, lesson: null }]).model,
    );
    distiller.enqueue([id]);
    await distiller.idle();
    const miss = events(where.knowledge, 'search').find((row) => JSON.parse(row.data ?? '{}').miss === 1);
    expect(JSON.parse(miss?.data ?? '{}')).toEqual({ miss: 1, lessonId: seed });
    expect(miss?.app_id).toBe('items');
    expect(lessonFrom(where.knowledge, id)).toBeNull();
    expect(lessonById(where.knowledge, seed)?.status).toBe('confirmed');
  });

  test('a case is distilled once, and a lesson naming a path on this machine is dropped', async () => {
    const where = makeWorld();
    const first = resolvedCase(where);
    const pathy = {
      ...MISSING,
      lesson: { ...MISSING.lesson, summary: 'Edit /Users/someone/project/src/shared/contract.ts before building the tags change.' },
    };
    const { adapter, model } = answering([MISSING, pathy]);
    const distiller = distillerOver(where, model);
    distiller.enqueue([first]);
    distiller.enqueue([first]);
    await distiller.idle();
    distiller.enqueue([first]);
    await distiller.idle();
    expect(adapter.calls).toHaveLength(1);
    expect(where.knowledge.db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM lessons WHERE episode_id = ?').get(first)?.n).toBe(1);

    const second = resolvedCase(where, 'route "items.colour" must declare a summary before it can be part of an Autoapp release');
    distiller.enqueue([second]);
    await distiller.idle();
    expect(caseOf(where.knowledge, second)).toMatchObject({ distill_state: 'done' });
    expect(JSON.parse(caseOf(where.knowledge, second)?.diagnosis ?? '{}')).toMatchObject({ diagnosis: 'knowledge_missing' });
    expect(lessonFrom(where.knowledge, second)).toBeNull();
    expect(events(where.knowledge, 'log').some((row) => row.message.includes('names a path on this machine'))).toBe(true);
  });

  test('sameCauseAs supersedes the old lesson and takes it out of the index', async () => {
    const where = makeWorld();
    const first = resolvedCase(where);
    const { model } = answering([
      MISSING,
      {
        ...MISSING,
        sameCauseAs: 1,
        lesson: {
          ...MISSING.lesson,
          summary: 'Every route added to contract.ts declares its effect and its summary together, or the build refuses it.',
        },
      },
    ]);
    const distiller = distillerOver(where, model);
    distiller.enqueue([first]);
    await distiller.idle();
    const old = lessonFrom(where.knowledge, first);
    expect(old?.id).toBe(1);
    const second = resolvedCase(where, 'route "items.colour" must declare an effect before it can be part of an Autoapp release');
    distiller.enqueue([second]);
    await distiller.idle();
    const replacement = lessonFrom(where.knowledge, second);
    expect(replacement).toMatchObject({ status: 'provisional', supersedes: 1 });
    expect(lessonById(where.knowledge, 1)?.status).toBe('superseded');
    expect(inIndex(where.knowledge, 1)).toBe(false);
    expect(inIndex(where.knowledge, replacement?.id ?? 0)).toBe(true);
  });

  test('a model that fails leaves the case pending, and the third failure gives up', async () => {
    const where = makeWorld();
    const id = resolvedCase(where);
    const distiller = distillerOver(where, () => Promise.reject(new Error('the model is unreachable')));
    distiller.enqueue([id]);
    await distiller.idle();
    expect(caseOf(where.knowledge, id)).toMatchObject({ distill_state: 'pending', distill_attempts: 1 });
    expect(
      events(where.knowledge, 'log').some(
        (row) => row.level === 'error' && row.message.includes(`could not distil case ${String(id)}`),
      ),
    ).toBe(true);
    distiller.enqueue([id]);
    await distiller.idle();
    distiller.enqueue([id]);
    await distiller.idle();
    expect(caseOf(where.knowledge, id)).toMatchObject({ distill_state: 'failed', distill_attempts: 3 });
    expect(caseOf(where.knowledge, id)?.diagnosis).toBeNull();
  });

  test('close() during a question returns within five seconds and leaves the case pending', async () => {
    const where = makeWorld();
    const id = resolvedCase(where);
    const { model } = answering([MISSING], 8_000);
    const distiller = distillerOver(where, model);
    distiller.enqueue([id]);
    await until(() => caseOf(where.knowledge, id)?.distill_attempts === 1, 5_000, 'the case to be claimed');
    const started = Date.now();
    await distiller.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(caseOf(where.knowledge, id)?.distill_state).toBe('pending');
    expect(lessonFrom(where.knowledge, id)).toBeNull();
  }, 30_000);
});

// ── 12c: freshness and review ──────────────────────────────────────────────

/** Insert a lesson by hand, with its index row. */
function handLesson(
  knowledge: Knowledge,
  fields: { origin: 'curated' | 'distilled'; hash: string; version: string; summary: string; status?: string },
): number {
  const id = Number(
    knowledge.db
      .query<null, [string, string, string, string, string]>(
        `INSERT INTO lessons (version, status, origin, scope, applies, summary, detail, trigger,
                              instructions_hash, autoapp_version, created_at, updated_at)
         VALUES (1, ?, ?, 'global', '{}', ?, 'detail', 'trigger words here', ?, ?, 0, 0)`,
      )
      .run(fields.status ?? 'provisional', fields.origin, fields.summary, fields.hash, fields.version).lastInsertRowid,
  );
  knowledge.db
    .query<null, [number, string]>("INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, 'trigger words here')")
    .run(id, fields.summary);
  return id;
}

/** `n` delivered servings of a lesson, closed with this outcome. */
function closedServings(knowledge: Knowledge, lessonId: number, outcome: string, n: number): void {
  for (let index = 0; index < n; index += 1) {
    knowledge.db
      .query<null, [number, string, number, string]>(
        `INSERT INTO servings (lesson_id, run_id, app_id, how, included, served_at, outcome)
         VALUES (?, ?, 'items', 'hint', 1, ?, ?)`,
      )
      .run(lessonId, `r-${outcome}-${String(index)}`, Date.now(), outcome);
  }
}

describe('12c: freshness', () => {
  test('recurring, rewritten instructions and an upgrade each flag a lesson, and none changes a status', () => {
    const directory = tempDir();
    const knowledge = openKnowledge(directory);
    closers.push(() => knowledge.close());
    const hash = instructionsHash(ENGINEER_INSTRUCTIONS);
    const recurring = handLesson(knowledge, { origin: 'distilled', hash, version: AUTOAPP_VERSION, summary: 'recurs every time' });
    closedServings(knowledge, recurring, 'recurred', 3);
    const helpedOnce = handLesson(knowledge, { origin: 'distilled', hash, version: AUTOAPP_VERSION, summary: 'recurs, and helped once' });
    closedServings(knowledge, helpedOnce, 'recurred', 3);
    closedServings(knowledge, helpedOnce, 'resolved', 1);
    const rewritten = handLesson(knowledge, { origin: 'distilled', hash: 'an-older-method', version: AUTOAPP_VERSION, summary: 'written for other instructions' });
    closedServings(knowledge, rewritten, 'recurred', 2);
    const confirmed = handLesson(knowledge, { origin: 'curated', hash, version: AUTOAPP_VERSION, summary: 'a confirmed one', status: 'confirmed' });
    closedServings(knowledge, confirmed, 'recurred', 3);

    reviewFlags(knowledge, { instructionsHash: hash, autoappVersion: AUTOAPP_VERSION });
    const review = (id: number): { status: string; review: string | null } | null =>
      knowledge.db.query<{ status: string; review: string | null }, [number]>('SELECT status, review FROM lessons WHERE id = ?').get(id);
    expect(review(recurring)).toEqual({ status: 'provisional', review: 'needs_review:recurring' });
    expect(review(helpedOnce)).toEqual({ status: 'provisional', review: null });
    expect(review(rewritten)).toEqual({ status: 'provisional', review: 'needs_review:instructions_changed' });
    expect(review(confirmed)).toEqual({ status: 'confirmed', review: 'needs_review:recurring' });

    // A minor version later, every distilled lesson nobody has reviewed is
    // flagged; a curated one is not.
    const fresh = handLesson(knowledge, { origin: 'distilled', hash, version: AUTOAPP_VERSION, summary: 'written by this launcher' });
    const curated = handLesson(knowledge, { origin: 'curated', hash, version: AUTOAPP_VERSION, summary: 'a curated fact', status: 'confirmed' });
    const [major, minor] = AUTOAPP_VERSION.split('.');
    reviewFlags(knowledge, { instructionsHash: hash, autoappVersion: `${major ?? '0'}.${String(Number(minor ?? '0') + 1)}.0` });
    expect(review(fresh)).toEqual({ status: 'provisional', review: 'needs_review:autoapp_upgraded' });
    expect(review(curated)).toEqual({ status: 'confirmed', review: null });
    expect(review(helpedOnce)).toEqual({ status: 'provisional', review: 'needs_review:autoapp_upgraded' });
  });

  test('a flagged lesson is labelled when it is served', async () => {
    const where = makeWorld({ serve: true });
    const lesson = handLesson(where.knowledge, {
      origin: 'distilled',
      hash: 'h',
      version: AUTOAPP_VERSION,
      summary: 'A colour tag is stored on the item row itself, as plain text.',
    });
    where.knowledge.db.query<null, [number]>("UPDATE lessons SET review = 'needs_review:recurring' WHERE id = ?").run(lesson);
    const runId = 'r-label';
    await served(where).search({ text: 'store a colour tag on each item', limit: 10, runId }, signal);
    const documents = await served(where).resolve([`lesson:${String(lesson)}`], signal);
    served(where).ended(runId);
    expect(documents[0]?.content).toContain(
      '- A colour tag is stored on the item row itself, as plain text. (provisional) (needs review: recurring)',
    );
  });
});

describe.skipIf(!available)('12c: the review command', () => {
  test('list, confirm and retire from the command line, and no change while a launcher is serving', async () => {
    const directory = tempDir();
    const dataDir = join(directory, 'autoapp', 'launcher');
    const setup = openKnowledge(dataDir);
    const hash = instructionsHash(ENGINEER_INSTRUCTIONS);
    const first = handLesson(setup, { origin: 'distilled', hash, version: AUTOAPP_VERSION, summary: 'The first provisional lesson, about effects.' });
    const second = handLesson(setup, { origin: 'distilled', hash, version: AUTOAPP_VERSION, summary: 'The second provisional lesson, about views.' });
    const third = handLesson(setup, { origin: 'distilled', hash, version: AUTOAPP_VERSION, summary: 'The third provisional lesson, about hosts.' });
    setup.close();

    const run = (...args: string[]): { code: number; out: string; err: string } => {
      const done = Bun.spawnSync({
        cmd: [LAUNCHER, 'knowledge', ...args],
        env: { ...process.env, BROAPP_DATA_DIR: directory },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        code: done.exitCode ?? -1,
        out: new TextDecoder().decode(done.stdout),
        err: new TextDecoder().decode(done.stderr),
      };
    };

    const listed = run('list', '--provisional');
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('The first provisional lesson, about effects.');
    expect(listed.out).toContain('provisional');

    expect(run('confirm', String(first), '--by', 'tester').code).toBe(0);
    expect(run('retire', String(second)).code).toBe(0);

    // A launcher that is alive: this test process stands in for one.
    const control = join(directory, 'autoapp', 'launcher.json');
    writeFileSync(control, JSON.stringify({ v: 1, port: 1, secret: 'not-a-secret', pid: process.pid }));
    const refused = run('confirm', String(third));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('is serving');
    rmSync(control);

    const after = openKnowledge(dataDir);
    closers.push(() => after.close());
    const row = (id: number): { status: string; reviewed_by: string | null; reviewed_at: number | null } | null =>
      after.db
        .query<{ status: string; reviewed_by: string | null; reviewed_at: number | null }, [number]>(
          'SELECT status, reviewed_by, reviewed_at FROM lessons WHERE id = ?',
        )
        .get(id);
    expect(row(first)).toMatchObject({ status: 'confirmed', reviewed_by: 'tester' });
    expect(row(first)?.reviewed_at).toBeGreaterThan(0);
    expect(row(second)?.status).toBe('retired');
    expect(inIndex(after, second)).toBe(false);
    expect(inIndex(after, first)).toBe(true);
    expect(row(third)).toMatchObject({ status: 'provisional', reviewed_at: null });
    const changes = after.db
      .query<{ lesson_id: number; change: string }, []>("SELECT lesson_id, change FROM corpus_versions WHERE change IN ('confirm', 'retire') ORDER BY version")
      .all();
    expect(changes).toEqual([
      { lesson_id: first, change: 'confirm' },
      { lesson_id: second, change: 'retire' },
    ]);
  }, 60_000);
});
