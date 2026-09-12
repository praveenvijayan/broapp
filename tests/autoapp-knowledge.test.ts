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
import { createAi, createFakeAdapter } from 'broapp/ai/host';
import { canonicalJson, createGate, createPendingApprovals } from 'broapp/host';
import type { Envelope, Gate, HostLogger } from 'broapp/host';
import { mergeContracts } from 'broapp/shared';
import { createRunStore, type RunStore } from 'broapp-autoapp/host';
import {
  ENGINEER_INSTRUCTIONS,
  INSTRUCTION_SECTIONS,
  MAX_REPAIR_ATTEMPTS,
  contains,
  stepFailure,
  createCandidateStates,
  engineerTools,
  searchWorkspace,
  type CandidateStates,
  type TurnRecord,
} from 'broapp-autoapp/engineer';
import {
  AUTOAPP_VERSION,
  CONDITIONS,
  EVALUATION_TASKS,
  KNOWLEDGE_FILE,
  SEED_LESSONS,
  manifestFor,
  replay,
  runKnowledgeCommand,
  sha256,
  unrelatedHintCredit,
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
import { STARTER_VERSIONS, TEMPLATES } from './autoapp-template.ts';
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
    templates: TEMPLATES,
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

  test('a passing cycle asks for the patch, the build and the preview, and runs the checks', async () => {
    const where = makeWorld({ git: true });
    const { output, asked } = await callAnswering(
      where,
      'candidate.cycle',
      { appId: 'items', message: 'Rename a header', hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }] },
      () => true,
      'run-p:call-1',
    );
    // The check is a read, and asks nobody.
    expect(asked).toEqual([
      { route: 'candidate.cycle', requestId: 'run-p:call-1' },
      { route: 'candidate.build', requestId: 'run-p:call-1.build' },
      { route: 'candidate.preview', requestId: 'run-p:call-1.preview' },
    ]);
    const result = output as { build: { ok: boolean; releaseId: string }; preview: unknown; check: { passed: number; of: number; failed: unknown[] }; next: string };
    expect(result.build.ok).toBe(true);
    expect(result.preview).toEqual({ running: true });
    expect(result.check.of).toBeGreaterThan(0);
    expect(result.check).toMatchObject({ passed: result.check.of, failed: [] });
    expect(result.next).toContain('candidate.explain');
    expect(where.states.status('items').checksVerified).toBe(true);
    expect(where.states.get('items').cycle).toMatchObject({ step: 'checked', failures: [], attempts: 0 });

    // With nothing to apply, a cycle verifies the workspace as it is: how an
    // interrupted cycle is finished. No patch, so no patch is asked about.
    const resumed = await callAnswering(where, 'candidate.cycle', { appId: 'items', message: 'Verify again', hunks: [] }, () => true, 'run-p:call-2');
    expect(resumed.asked.map((question) => question.route)).toEqual(['candidate.cycle', 'candidate.build', 'candidate.preview']);
    expect(resumed.output).toMatchObject({ applied: { changed: [] }, build: { ok: true }, check: { failed: [] } });
    await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });
  }, 240_000);

  test('a check refuses a preview of another release', async () => {
    const where = makeWorld();
    const first = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as { ok: boolean; releaseId: string };
    expect(first.ok).toBe(true);
    await callTool(where, 'candidate.preview', { appId: 'items', releaseId: first.releaseId }, { approve: true });
    rewrite(join(where.source, 'src', 'shared', 'views.ts'), /header: 'Label'/, "header: 'What it is'");
    const second = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as { ok: boolean; releaseId: string };
    expect(second.ok).toBe(true);
    expect(second.releaseId).not.toBe(first.releaseId);
    // The preview is still the first release's: the second's examples must not be run against it.
    await expect(callTool(where, 'candidate.check', { appId: 'items', releaseId: second.releaseId })).rejects.toMatchObject({
      code: 'conflict',
    });
    const checked = (await callTool(where, 'candidate.check', { appId: 'items', releaseId: first.releaseId })) as {
      results: unknown[];
    };
    expect(checked.results.length).toBeGreaterThan(0);
    await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });
  }, 240_000);

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
      templates: TEMPLATES,
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
      templates: TEMPLATES,
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
    templates: TEMPLATES,
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
    templates: TEMPLATES,
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

    // The starter ships a PRODUCT.md, so the brief is named with its first line
    // rather than left for the engineer to find by listing files. DESIGN.md is
    // optional and absent here, and a file nobody wrote is not mentioned.
    expect(found.text).toMatch(/Context: PRODUCT\.md \(.+\)$/m);
    expect(found.text).not.toContain('DESIGN.md');
    expect(found.entries.some((entry) => entry.name === 'context')).toBe(true);

    writeFileSync(join(source, 'DESIGN.md'), '# Design\n\nOne accent, everything else grey.\n', 'utf8');
    const both = taskEvidence({ layout: root, appId: 'items', tokens: ['items', 'add'], index });
    expect(both.text).toContain('DESIGN.md (One accent, everything else grey.)');

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
      'When a build fails, its `hints` are facts from earlier work (provisional: unconfirmed); there is no list of lessons to walk.',
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
    // With a stage since 12d: a lesson that names none is never a hint.
    const weak = add('A colour is stored as plain text in the database.', 'palette shade', { stage: 'views' });
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

// ── 12d: replay and evaluation ─────────────────────────────────────────────

const noNetwork = Object.assign(() => Promise.reject(new Error('no network in tests')), {
  preconnect: () => undefined,
}) as typeof fetch;

/** The configured model, as a replay asks for it. */
const fakeModel = (): ReturnType<ReturnType<typeof createAi>['model']> =>
  Promise.resolve(createFakeAdapter().model({ apiKey: null, baseUrl: null, fetch: noNetwork }, 'fake-1'));

/** A launcher data directory whose AI settings choose the fake provider, as a person would in Settings. */
async function fakeSettings(dataDir: string): Promise<void> {
  const ai = createAi({ dataDir, providers: [createFakeAdapter()], app: { name: 'test', purpose: 'test' }, fetch: noNetwork });
  await ai.registry.update({ provider: 'fake', modelId: 'fake-1' });
}

/** What the person asked for in the turn the cases below were met in. */
const REQUEST = 'add a tag route to the items';
function recordedTurn(runId: string): TurnRecord | undefined {
  return runId === 'run-1' ? { message: REQUEST, contextId: null, model: { provider: 'fake', id: 'fake-1' } } : undefined;
}

/** Insert a lesson with its index row; distilled and provisional unless said otherwise. */
function storeLesson(
  knowledge: Knowledge,
  fields: {
    applies: Record<string, unknown>;
    summary: string;
    trigger: string;
    episodeId?: number;
    status?: string;
    origin?: string;
  },
): number {
  const id = Number(
    knowledge.db
      .query<null, [string, string, number | null, string, string, string]>(
        `INSERT INTO lessons (version, status, origin, episode_id, diagnosis, scope, applies, summary, detail, trigger,
                              instructions_hash, autoapp_version, created_at, updated_at)
         VALUES (1, ?, ?, ?, 'knowledge_missing', 'global', ?, ?, 'detail', ?, 'h', '0.1.0', 0, 0)`,
      )
      .run(
        fields.status ?? 'provisional',
        fields.origin ?? 'distilled',
        fields.episodeId ?? null,
        JSON.stringify(fields.applies),
        fields.summary,
        fields.trigger,
      ).lastInsertRowid,
  );
  knowledge.db
    .query<null, [number, string, string]>('INSERT INTO lessons_fts (rowid, summary, trigger) VALUES (?, ?, ?)')
    .run(id, fields.summary, fields.trigger);
  return id;
}

/** A route with no effect, added on one line's anchor so a CRLF checkout matches it too. */
const TAG_ROUTE =
  "'items.tag': {\n      summary: 'Tag an item.',\n      input: s.void(),\n      output: s.object({ ok: s.boolean() }),\n    },\n    'items.ping': {";
const DECLARE_EFFECT = {
  appId: 'items',
  message: 'Declare the effect of items.tag',
  hunks: [{ path: 'src/shared/contract.ts', find: "'items.tag': {", replace: "'items.tag': {\n      effect: 'write'," }],
};

/** A contract failure met through the tools, and its repair: one resolved build case. */
async function buildCase(where: World): Promise<{ episodeId: number; rev: string }> {
  await callTool(
    where,
    'source.edit',
    { appId: 'items', message: 'Add items.tag', hunks: [{ path: 'src/shared/contract.ts', find: "'items.ping': {", replace: TAG_ROUTE }] },
    { approve: true },
  );
  const rev = git(where.source, 'rev-parse', 'HEAD');
  const failed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as { ok: boolean };
  expect(failed.ok).toBe(false);
  await callTool(where, 'source.edit', DECLARE_EFFECT, { approve: true });
  const passed = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as { ok: boolean };
  expect(passed.ok).toBe(true);
  const row = where.knowledge.db
    .query<{ id: number }, []>("SELECT id FROM episodes WHERE stage = 'contract' AND resolved_at IS NOT NULL")
    .get();
  if (row === null) throw new Error('no resolved contract case');
  return { episodeId: row.id, rev };
}

/** A miscounting host met by a check, and its repair: one resolved check case. */
async function checkCase(where: World): Promise<{ episodeId: number }> {
  const host = join(where.source, 'src', 'host', 'app.ts');
  rewrite(host, /count: store\.count\(\) \}/, 'count: store.count() + 1 }');
  const manifestPath = join(where.source, 'autoapp.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { acceptance: unknown[] };
  manifest.acceptance = [
    { id: 'count', title: 'The count is right', steps: [{ route: 'items.list', input: null, expect: { items: [], count: 0 } }] },
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(where.source, 'add', '-A');
  git(where.source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'miscount');
  const check = async (): Promise<boolean> => {
    const built = (await callTool(where, 'candidate.build', { appId: 'items' }, { approve: true })) as { ok: boolean; releaseId: string };
    if (!built.ok) throw new Error('the build failed');
    await callTool(where, 'candidate.preview', { appId: 'items', releaseId: built.releaseId }, { approve: true });
    const checked = (await callTool(where, 'candidate.check', { appId: 'items', releaseId: built.releaseId })) as {
      results: { passed: boolean }[];
    };
    return checked.results[0]?.passed === true;
  };
  expect(await check()).toBe(false);
  rewrite(host, /count: store\.count\(\) \+ 1 \}/, 'count: store.count() }');
  git(where.source, 'add', '-A');
  git(where.source, 'commit', '--quiet', '--no-gpg-sign', '-m', 'count right');
  expect(await check()).toBe(true);
  await callTool(where, 'preview.stop', { appId: 'items' }, { approve: true });
  const row = where.knowledge.db
    .query<{ id: number }, []>("SELECT id FROM episodes WHERE stage = 'check' AND resolved_at IS NOT NULL")
    .get();
  if (row === null) throw new Error('no resolved check case');
  return { episodeId: row.id };
}

/** A turn that says something and changes nothing. */
const IDLE = [{ kind: 'text' as const, chunks: ['I would rather not change anything.'] }];

/** A turn whose one step is a `source.edit`. */
function editing(input: unknown): Parameters<typeof createFakeAdapter>[0] {
  return { script: [{ kind: 'tool', name: 'source.edit', input, then: [{ kind: 'text', chunks: ['done'] }] }] };
}

/** Call a tool as the engineer, answering every question it asks with `answer`, and say what was asked. */
async function callAnswering(
  where: World,
  name: string,
  input: unknown,
  answer: (route: string) => boolean,
  requestId: string,
): Promise<{ output: unknown; asked: { route: string; requestId: string }[] }> {
  const approvals = createPendingApprovals(quiet);
  const tool = where.tools[name];
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  const envelope: Envelope = { requestId, channel: 'ai', caller: 'ai:test', approver: approvals };
  const asked: { route: string; requestId: string }[] = [];
  let finished = false;
  const running = tool.execute(input, envelope, new AbortController().signal).finally(() => {
    finished = true;
  });
  // Handled now, awaited below: a call refused while the loop is still polling
  // would otherwise be an unhandled rejection that fails the test on the spot.
  running.catch(() => undefined);
  while (!finished) {
    const question = approvals.pending[0];
    if (question !== undefined) {
      asked.push({ route: question.route, requestId: question.requestId });
      approvals.answer({
        requestId: question.requestId,
        approved: answer(question.route),
        releaseId: question.releaseId,
        argumentsHash: question.argumentsHash,
      });
    }
    await Bun.sleep(5);
  }
  return { output: await running, asked };
}

describe('the host’s change cycle', () => {
  test('a failing cycle asks for the patch and the build, and returns each problem at its lines', async () => {
    const where = makeWorld({ git: true });
    const first = await callAnswering(
      where,
      'candidate.cycle',
      { appId: 'items', message: 'Add items.tag', hunks: [{ path: 'src/shared/contract.ts', find: "'items.ping': {", replace: TAG_ROUTE }] },
      () => true,
      'run-c:call-1',
    );
    // One question per action, each under its own request id.
    expect(first.asked).toEqual([
      { route: 'candidate.cycle', requestId: 'run-c:call-1' },
      { route: 'candidate.build', requestId: 'run-c:call-1.build' },
    ]);
    const result = first.output as {
      applied: { changed: string[] };
      build: { ok: boolean; sameAsLastBuild: boolean; problems: { stage: string; at?: { path: string; line: number; excerpt: string } }[] };
      preview?: unknown;
      next: string;
    };
    expect(result.applied.changed).toEqual(['src/shared/contract.ts']);
    expect(result.build.ok).toBe(false);
    expect(result.build.sameAsLastBuild).toBe(false);
    expect(result.preview).toBeUndefined();
    const problem = result.build.problems.find((entry) => entry.stage === 'contract');
    expect(problem?.at?.path).toBe('src/shared/contract.ts');
    expect(problem?.at?.excerpt).toContain("'items.tag'");
    expect(problem?.at?.line).toBe(lineOf(join(where.source, 'src', 'shared', 'contract.ts'), "'items.tag'"));
    // The build was written down as this call's own step, with the turn's run.
    const [build] = events(where.knowledge, 'build');
    expect(build?.run_id).toBe('run-c');
    expect(build?.call_id).toBe('call-1.build');

    // A change somewhere else leaves the same failure, and the cycle says so.
    const again = await callAnswering(
      where,
      'candidate.cycle',
      { appId: 'items', message: 'Rename a header', hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }] },
      () => true,
      'run-c:call-2',
    );
    expect(again.output).toMatchObject({ build: { ok: false, sameAsLastBuild: true } });
    expect((again.output as { next: string }).next).toContain('did not reach them');

    // A declined build: the patch stands, and nothing after it runs.
    const declined = await callAnswering(
      where,
      'candidate.cycle',
      { ...DECLARE_EFFECT },
      (route) => route !== 'candidate.build',
      'run-c:call-3',
    );
    expect(declined.asked.map((question) => question.route)).toEqual(['candidate.cycle', 'candidate.build']);
    expect(declined.output).toMatchObject({ applied: { changed: ['src/shared/contract.ts'] }, build: { declined: true } });
    expect(readFileSync(join(where.source, 'src', 'shared', 'contract.ts'), 'utf8')).toContain("effect: 'write'");
  }, 120_000);

  test('a cycle writes down where it stopped, and a restart and the next turn read it', async () => {
    const where = makeWorld({ git: true });
    await callAnswering(
      where,
      'candidate.cycle',
      { appId: 'items', message: 'Add items.tag', hunks: [{ path: 'src/shared/contract.ts', find: "'items.ping': {", replace: TAG_ROUTE }] },
      () => true,
      'run-s:call-1',
    );
    // What a restart reads back.
    const resumed = createCandidateStates(where.root, quiet);
    const cycle = resumed.get('items').cycle;
    expect(cycle).toMatchObject({ step: 'build-failed', attempts: 1, runId: 'run-s', rev: git(where.source, 'rev-parse', 'HEAD') });
    expect(cycle?.failures).toHaveLength(1);
    expect(cycle?.failures[0]?.summary).toMatch(/^contract: /);
    expect(cycle?.next).toContain('candidate.cycle');
    // What the next turn opens with.
    const told = orientation({ layout: where.root, appId: 'items', states: resumed, apps: listApps(where.root, where.supervisor, where.journal) });
    expect(told.text).toContain(`Last cycle: build failed at contract: `);
    expect(told.text).toContain(`(attempt 1 of ${String(MAX_REPAIR_ATTEMPTS)})`);
    expect(told.text).toContain('Next: fix what the last cycle reported, with another candidate.cycle');
  }, 120_000);

  test('three cycles in a turn that end with the same failure stall, and the fourth waits for the person', async () => {
    const where = makeWorld({ git: true });
    const cycle = (requestId: string, hunks: readonly { path: string; find: string; replace: string }[]) =>
      callAnswering(where, 'candidate.cycle', { appId: 'items', message: 'Try again', hunks }, () => true, requestId);
    const header = (from: string, to: string) => [{ path: 'src/shared/views.ts', find: `header: '${from}'`, replace: `header: '${to}'` }];

    expect((await cycle('run-b:call-1', [{ path: 'src/shared/contract.ts', find: "'items.ping': {", replace: TAG_ROUTE }])).output).toMatchObject({
      attempt: { n: 1, of: MAX_REPAIR_ATTEMPTS },
      stalled: false,
    });
    expect((await cycle('run-b:call-2', header('Label', 'One'))).output).toMatchObject({ attempt: { n: 2 }, stalled: false });
    const third = await cycle('run-b:call-3', header('One', 'Two'));
    expect(third.output).toMatchObject({ attempt: { n: 3 }, stalled: true });
    expect((third.output as { next: string }).next).toContain('ask how to go on');
    const stuck = orientation({ layout: where.root, appId: 'items', states: where.states, apps: listApps(where.root, where.supervisor, where.journal) });
    expect(stuck.text).toContain('Next: the last cycles ended with the same failure');

    // A fourth in the same turn is refused — as a conflict, not as the person saying no.
    await expect(cycle('run-b:call-4', header('Two', 'Three'))).rejects.toMatchObject({ code: 'conflict' });
    // The person's next message is a new turn, and the count starts again.
    expect((await cycle('run-b2:call-1', header('Two', 'Three'))).output).toMatchObject({ attempt: { n: 1 }, stalled: false });
  }, 180_000);

  test('a third identical read in a turn says so, and a change to the workspace starts the count again', async () => {
    const where = makeWorld({ git: true });
    const read = (requestId: string) =>
      callTool(where, 'source.read', { appId: 'items', path: 'src/shared/views.ts' }, { id: requestId }) as Promise<{ repeated?: { times: number } }>;
    expect((await read('run-r:c1')).repeated).toBeUndefined();
    expect((await read('run-r:c2')).repeated).toBeUndefined();
    expect((await read('run-r:c3')).repeated?.times).toBe(3);
    // Another turn has its own count.
    expect((await read('run-q:c1')).repeated).toBeUndefined();
    // After an edit in the turn the same read can return something new.
    await callTool(
      where,
      'source.edit',
      { appId: 'items', message: 'Rename a header', hunks: [{ path: 'src/shared/views.ts', find: "header: 'Label'", replace: "header: 'What it is'" }] },
      { approve: true, id: 'run-r:c4' },
    );
    expect((await read('run-r:c5')).repeated).toBeUndefined();
  }, 60_000);

  test('a progress record that will not read is dropped, and the candidate beside it is kept', () => {
    const where = makeWorld();
    writeFileSync(
      where.root.app('items').candidate,
      JSON.stringify({ releaseId: 'a'.repeat(32), problems: [], cycle: { step: 'somewhere else', attempts: 'many' } }),
    );
    const state = createCandidateStates(where.root, quiet).get('items');
    expect(state.releaseId).toBe('a'.repeat(32));
    expect(state.cycle).toBeNull();
  });

  test('the instructions send every change through the cycle', () => {
    const flat = ENGINEER_INSTRUCTIONS.replace(/\s+/g, ' ');
    expect(flat).toContain('make the change with `candidate.cycle`');
    expect(flat).toContain('fix them with another `candidate.cycle` until every check passes');
  });
});

describe('12d follow-up: one judge for every check', () => {
  test('expect is exact and blind to key order; match needs every named key and the same array length', () => {
    expect(stepFailure({ route: 'r.x', input: null, expect: { a: 1, b: [2] } }, { b: [2], a: 1 })).toBeNull();
    expect(stepFailure({ route: 'r.x', input: null, expect: { a: 1 } }, { a: 1, b: 2 })).toContain('not {"a":1}');
    const kept = { notes: [{ title: 'Keep me' }] };
    const step = { route: 'notes.list', input: {}, match: kept };
    expect(stepFailure(step, { notes: [{ id: 1, title: 'Keep me', updatedAt: 5 }] })).toBeNull();
    // A stubbed route that returns nothing fails, and so does one that archived nothing.
    expect(stepFailure(step, { notes: [] })).toContain('does not contain');
    expect(stepFailure(step, { notes: [{ title: 'Keep me' }, { title: 'Archive me' }] })).not.toBeNull();
    expect(contains({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toBe(true);
    expect(contains({ a: [1] }, { a: 1 })).toBe(false);
    expect(contains([{ a: 1 }], { 0: { a: 1 } })).toBe(false);
    expect(contains(null, {})).toBe(false);
  });
});

describe('12d: a carry-over the real distillation found', () => {
  test('a lesson detail within its own limit is kept; only a field over its own limit drops the lesson', async () => {
    const where = makeWorld();
    const long = 'The renderer refuses a row action on a write operation unless it carries confirmText. '.repeat(14).trim();
    expect(long.length).toBeGreaterThan(1_000);
    expect(long.length).toBeLessThanOrEqual(2_000);
    const kept = resolvedCase(where);
    const distiller = distillerOver(where, answering([{ ...MISSING, lesson: { ...MISSING.lesson, detail: long } }]).model);
    distiller.enqueue([kept]);
    await distiller.idle();
    // 12c measured every field against the summary's 400 and dropped this one.
    expect(lessonFrom(where.knowledge, kept)).not.toBeNull();

    // A trigger word past its own limit is refused by the schema the model was shown.
    const refused = resolvedCase(where, 'route "items.other" must declare an effect before it can be part of an Autoapp release');
    const again = distillerOver(
      where,
      answering([{ ...MISSING, lesson: { ...MISSING.lesson, trigger: ['effect', 'tags', 'x'.repeat(41)] } }]).model,
    );
    again.enqueue([refused]);
    await again.idle();
    expect(lessonFrom(where.knowledge, refused)).toBeNull();
  }, 30_000);
});

describe('12d step 0: hints and credit', () => {
  test('knowledge.show counts the lessons a turn reads in full, and a guessed id is told there is no list', async () => {
    const where = makeWorld({ serve: true });
    const first = storeLesson(where.knowledge, {
      applies: { stage: 'contract' },
      summary: 'A new route needs its effect before the contract stage exports it.',
      trigger: 'effect route declare',
      status: 'confirmed',
    });
    const second = storeLesson(where.knowledge, {
      applies: { stage: 'views' },
      summary: 'A table needs a source before the views stage accepts it.',
      trigger: 'table source views',
      status: 'confirmed',
    });
    const one = (await callTool(where, 'knowledge.show', { lessonId: first }, { id: 'run-show:c1' })) as Record<string, unknown>;
    expect(one.id).toBe(first);
    expect(one.repeated).toBeUndefined();
    const two = (await callTool(where, 'knowledge.show', { lessonId: second }, { id: 'run-show:c2' })) as {
      repeated?: { read: number; note: string };
    };
    expect(two.repeated?.read).toBe(2);
    expect(two.repeated?.note).toMatch(/whole of what is written down/);
    // Another turn starts its own count.
    const again = (await callTool(where, 'knowledge.show', { lessonId: first }, { id: 'run-other:c1' })) as Record<string, unknown>;
    expect(again.repeated).toBeUndefined();
    await expect(callTool(where, 'knowledge.show', { lessonId: 9_999 }, { id: 'run-show:c3' })).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringMatching(/no list to walk/),
    });
  });

  test('a lesson with no stage is never a hint; one of the failure’s stage is', () => {
    const where = makeWorld({ serve: true });
    const stageless = storeLesson(where.knowledge, {
      applies: {},
      summary: 'An effect is written once per route.',
      trigger: 'effect route declare',
      status: 'confirmed',
    });
    const staged = storeLesson(where.knowledge, {
      applies: { stage: 'contract' },
      summary: 'A new route needs its effect before the contract stage exports it.',
      trigger: 'effect route declare',
      status: 'confirmed',
    });
    const hints = served(where)
      .hints('items', [{ stage: 'contract', message: 'route "items.tag" must declare an effect' }], handOrigin('r-stage'))
      .map((hint) => hint.lessonId);
    expect(hints).toContain(staged);
    expect(hints).not.toContain(stageless);
    // The MCP seed, which 12c watched be hinted for a contract failure.
    expect(hints).not.toContain(seedId(where.knowledge, 5));
  });

  test('resolved credit to a hint of another stage or route is counted, and show says so', () => {
    const directory = tempDir();
    const root = layout(join(directory, 'autoapp'));
    const knowledge = openKnowledge(join(root.root, 'launcher'));
    const log = createEventLog(knowledge, { source: 'test', tee: quiet });
    const caseId = createEvidence(knowledge, log).open({
      appId: 'items',
      stage: 'contract',
      problem: 'route "items.other" must declare an effect',
      request: 'r',
      contextId: null,
      origin: handOrigin('r-credit'),
      releaseBefore: null,
      dataSnapshot: null,
      model: null,
      autoappVersion: AUTOAPP_VERSION,
    });
    const signatureOfCase =
      knowledge.db.query<{ signature: string }, [number]>('SELECT signature FROM episodes WHERE id = ?').get(caseId ?? 0)?.signature ?? '';
    const stageless = storeLesson(knowledge, { applies: {}, summary: 'An MCP fact.', trigger: 'mcp effect' });
    const staged = storeLesson(knowledge, { applies: { stage: 'contract' }, summary: 'A contract fact.', trigger: 'effect' });
    const routed = storeLesson(knowledge, {
      applies: { stage: 'contract', routes: ['items.tag'] },
      summary: 'A fact about items.tag.',
      trigger: 'effect tag',
    });
    for (const lessonId of [stageless, staged, routed]) {
      knowledge.db
        .query<null, [number, string, string]>(
          `INSERT INTO servings (lesson_id, run_id, app_id, how, for_signature, for_stage, included, served_at, outcome)
           VALUES (?, ?, 'items', 'hint', ?, 'contract', 1, 0, 'resolved')`,
        )
        .run(lessonId, `r-${String(lessonId)}`, signatureOfCase);
    }
    expect(unrelatedHintCredit(knowledge)).toEqual({ byStage: 1, byStageOrRoutes: 2 });
    expect(unrelatedHintCredit(knowledge, staged)).toEqual({ byStage: 0, byStageOrRoutes: 0 });
    knowledge.close();

    const lines: string[] = [];
    expect(runKnowledgeCommand({ root, argv: ['show', String(stageless)], out: (line) => lines.push(line) })).toBe(0);
    expect(lines.join('\n')).toContain('resolved 1 (of which unrelated by stage: 1)');
  });
});

describe('12d: replay', () => {
  test('a manifest names every field a replay depends on', async () => {
    const where = makeWorld({ git: true, turn: recordedTurn });
    const { episodeId, rev } = await buildCase(where);
    const lessonId = storeLesson(where.knowledge, {
      applies: { stage: 'contract' },
      summary: 'A new route needs its effect declared.',
      trigger: 'effect route',
      episodeId,
    });
    const aiDataDir = join(where.directory, 'launcher');
    const manifest = await manifestFor({
      knowledge: where.knowledge,
      layout: where.root,
      episodeId,
      lessonId,
      runs: 2,
      model: fakeModel,
      providers: [createFakeAdapter()],
      logger: quiet,
      aiDataDir,
    });
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'v', 'episodeId', 'appId', 'kind', 'stage', 'signature', 'sourceRevBefore', 'releaseBefore', 'dataSnapshot',
        'packageJsonHash', 'lockfileHash', 'requestBlob', 'instructionsBlob', 'caseInstructionsBlob', 'exampleBlob',
        'exampleHash', 'model', 'autoappVersion', 'lessonId', 'runs', 'maxSteps', 'turnTimeoutMs',
      ].sort(),
    );
    expect(manifest).toMatchObject({
      episodeId,
      appId: 'items',
      kind: 'build',
      stage: 'contract',
      sourceRevBefore: rev,
      dataSnapshot: null,
      model: { provider: 'fake', id: 'fake-1' },
      autoappVersion: AUTOAPP_VERSION,
      lessonId,
      runs: 2,
      maxSteps: LAUNCHER_MAX_STEPS,
      exampleBlob: null,
      exampleHash: null,
    });
    expect(where.knowledge.getBlob(manifest.requestBlob)).toBe(REQUEST);
    expect(where.knowledge.getBlob(manifest.instructionsBlob)).toBe(ENGINEER_INSTRUCTIONS);
    expect(manifest.signature).toMatch(/^[0-9a-f]{32}$/);
    expect(manifest.packageJsonHash === null || /^[0-9a-f]{32}$/.test(manifest.packageJsonHash)).toBe(true);

    // An open case, or one with no revision, is refused with a reason.
    await expect(
      manifestFor({ knowledge: where.knowledge, layout: where.root, episodeId: 999, lessonId: null, model: fakeModel, providers: [], logger: quiet, aiDataDir }),
    ).rejects.toMatchObject({ code: 'not_found' });
  }, 120_000);

  test('a build case replays into fresh checkouts with and without its lesson; the launcher’s store gains only the results', async () => {
    const where = makeWorld({ git: true, turn: recordedTurn });
    const { episodeId, rev } = await buildCase(where);
    const lessonId = storeLesson(where.knowledge, {
      applies: { stage: 'contract' },
      summary: 'A new route needs its effect declared.',
      trigger: 'effect route',
      episodeId,
    });
    const aiDataDir = join(where.directory, 'launcher');
    await fakeSettings(aiDataDir);
    const count = (table: string): number =>
      where.knowledge.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
    const before = { servings: count('servings'), episodes: count('episodes'), contexts: count('contexts') };

    const { manifest, results } = await replay({
      knowledge: where.knowledge,
      layout: where.root,
      episodeId,
      lessonId,
      runs: 2,
      model: fakeModel,
      // Scripted arms: with the lesson the engineer declares the effect; without it, it does nothing.
      providers: (run) => [createFakeAdapter(run.label === 'with' ? editing(DECLARE_EFFECT) : { script: IDLE })],
      logger: quiet,
      aiDataDir,
      execPath: LAUNCHER,
      fetch: noNetwork,
      turnTimeoutMs: 60_000,
    });
    expect(results.map((result) => `${result.arm}:${result.outcome}`)).toEqual([
      'with:passed',
      'without:failed',
      'with:passed',
      'without:failed',
    ]);

    // Four fresh checkouts of the case's revision.
    const base = join(where.root.root, 'replay', String(episodeId));
    for (const arm of ['with', 'without']) {
      expect(readdirSync(join(base, arm)).sort()).toEqual(['1', '2']);
      for (const n of ['1', '2']) {
        const source = join(base, arm, n, 'apps', 'items', 'source');
        const ancestor = Bun.spawnSync({ cmd: ['git', 'merge-base', '--is-ancestor', rev, 'HEAD'], cwd: source });
        expect(ancestor.exitCode).toBe(0);
      }
      const unchanged = git(join(base, 'without', '1', 'apps', 'items', 'source'), 'rev-parse', 'HEAD');
      expect(unchanged).toBe(rev);
    }

    // The replay's own store: the lesson reached only the `with` arm, and nothing curated reached either.
    const replayed = new Database(join(base, KNOWLEDGE_FILE), { readonly: true });
    closers.push(() => replayed.close());
    const contexts = replayed
      .query<{ run_id: string; resolved: string; included: string }, []>('SELECT run_id, resolved, included FROM contexts ORDER BY id')
      .all();
    const refs = (row: { included: string }): string[] => (JSON.parse(row.included) as { ref: string }[]).map((entry) => entry.ref);
    const withContexts = contexts.filter((row) => row.run_id.includes('-with-'));
    const withoutContexts = contexts.filter((row) => row.run_id.includes('-without-'));
    expect(withContexts).toHaveLength(2);
    expect(withoutContexts).toHaveLength(2);
    for (const row of withContexts) {
      expect(JSON.parse(row.resolved) as string[]).toContain(`lesson:${String(lessonId)}`);
      expect(refs(row)).toContain('lessons:items');
    }
    for (const row of withoutContexts) {
      expect(JSON.parse(row.resolved) as string[]).not.toContain(`lesson:${String(lessonId)}`);
      expect(refs(row)).not.toContain('lessons:items');
    }
    expect(replayed.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lessons WHERE origin = 'curated'").get()?.n).toBe(0);
    expect(replayed.query<{ lesson_id: number }, []>('SELECT DISTINCT lesson_id FROM servings').all()).toEqual([
      { lesson_id: lessonId },
    ]);

    // The launcher's store: four result rows, each naming the manifest's blob, and nothing else.
    expect(count('replays')).toBe(4);
    expect({ servings: count('servings'), episodes: count('episodes'), contexts: count('contexts') }).toEqual(before);
    const blob = sha256(canonicalJson(manifest));
    const rows = where.knowledge.db.query<{ manifest_blob: string; lesson_id: number }, []>('SELECT manifest_blob, lesson_id FROM replays').all();
    expect(rows.every((row) => row.manifest_blob === blob && row.lesson_id === lessonId)).toBe(true);
    expect(JSON.parse(where.knowledge.getBlob(blob) ?? 'null')).toEqual(manifest);
  }, 240_000);

  test('confirm shows the replay table and asks; without a replay it says so and still confirms', () => {
    const directory = tempDir();
    const root = layout(join(directory, 'autoapp'));
    const knowledge = openKnowledge(join(root.root, 'launcher'));
    const replayed = storeLesson(knowledge, { applies: { stage: 'contract' }, summary: 'A replayed lesson.', trigger: 'one' });
    const second = storeLesson(knowledge, { applies: { stage: 'contract' }, summary: 'Another replayed lesson.', trigger: 'two' });
    const unreplayed = storeLesson(knowledge, { applies: { stage: 'contract' }, summary: 'Nobody replayed this one.', trigger: 'three' });
    const blob = knowledge.putBlob('{"v":1}');
    const insert = (lessonId: number, arm: string, outcome: string, episodeId: number): void => {
      knowledge.db
        .query<null, [number, number, string, string, string]>(
          `INSERT INTO replays (episode_id, lesson_id, arm, n, outcome, steps, ms, input_tokens, output_tokens, build_reached, manifest_blob, at)
           VALUES (?, ?, ?, 1, ?, 3, 1000, 10, 5, 0, ?, 0)`,
        )
        .run(episodeId, lessonId, arm, outcome, blob);
    };
    for (const lessonId of [replayed, second]) {
      insert(lessonId, 'with', 'passed', 1);
      insert(lessonId, 'without', 'failed', 1);
      insert(lessonId, 'regression', 'failed', 2);
    }
    knowledge.close();

    const statusOf = (id: number): string | undefined => {
      const reader = openKnowledge(join(root.root, 'launcher'));
      try {
        return reader.db.query<{ status: string }, [number]>('SELECT status FROM lessons WHERE id = ?').get(id)?.status;
      } finally {
        reader.close();
      }
    };
    const never = (): string => {
      throw new Error('the person was asked');
    };
    let lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };

    const asked: string[] = [];
    expect(runKnowledgeCommand({ root, argv: ['confirm', String(replayed)], out, err: out, ask: (question) => (asked.push(question), 'n') })).toBe(1);
    expect(asked).toHaveLength(1);
    expect(lines.join('\n')).toContain('verdict: supports');
    expect(lines.join('\n')).toContain('case 2: failed');
    expect(statusOf(replayed)).toBe('provisional');

    expect(runKnowledgeCommand({ root, argv: ['confirm', String(replayed)], out, err: out, ask: () => 'y' })).toBe(0);
    expect(statusOf(replayed)).toBe('confirmed');
    expect(runKnowledgeCommand({ root, argv: ['confirm', String(second), '--yes'], out, err: out, ask: never })).toBe(0);
    expect(statusOf(second)).toBe('confirmed');

    lines = [];
    expect(runKnowledgeCommand({ root, argv: ['confirm', String(unreplayed)], out, err: out, ask: never })).toBe(0);
    expect(lines.join('\n')).toContain('no replay has been run');
    expect(statusOf(unreplayed)).toBe('confirmed');
  });
});

describe.skipIf(!available)('12d: replay with children, and the evaluation', () => {
  test('a check case runs on a copy of the data and is judged by its example, by hash', async () => {
    const where = makeWorld({ git: true, turn: recordedTurn });
    const { episodeId } = await checkCase(where);
    // Something in the live data only a copy of it would carry.
    const live = where.root.app('items').data;
    mkdirSync(live, { recursive: true });
    const marker = new Database(join(live, 'marker.sqlite'), { create: true });
    marker.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('from the live data')");
    marker.close();
    const lessonId = storeLesson(where.knowledge, {
      applies: { stage: 'check' },
      summary: 'The count is of items, not of items plus one.',
      trigger: 'count items',
      episodeId,
    });
    const aiDataDir = join(where.directory, 'launcher');
    await fakeSettings(aiDataDir);
    const fix = {
      appId: 'items',
      message: 'Count right',
      hunks: [{ path: 'src/host/app.ts', find: 'count: store.count() + 1 }', replace: 'count: store.count() }' }],
    };
    const { manifest, results } = await replay({
      knowledge: where.knowledge,
      layout: where.root,
      episodeId,
      lessonId,
      runs: 1,
      model: fakeModel,
      providers: (run) => [createFakeAdapter(run.label === 'with' ? editing(fix) : { script: IDLE })],
      logger: quiet,
      aiDataDir,
      execPath: LAUNCHER,
      fetch: noNetwork,
      turnTimeoutMs: 60_000,
    });
    expect(manifest.kind).toBe('check');
    expect(manifest.dataSnapshot).toEqual({ path: `replay/${String(episodeId)}/data`, from: 'live' });
    expect(manifest.exampleHash).toBe(where.evidence.get(episodeId)?.exampleHash ?? '');
    expect(results.map((result) => `${result.arm}:${result.outcome}`)).toEqual(['with:passed', 'without:failed']);
    const copied = new Database(join(where.root.root, 'replay', String(episodeId), 'with', '1', 'apps', 'items', 'data', 'marker.sqlite'), {
      readonly: true,
    });
    closers.push(() => copied.close());
    expect(copied.query<{ v: string }, []>('SELECT v FROM marker').get()?.v).toBe('from the live data');
  }, 300_000);

  test('a run whose child dies is inconclusive, not failed', async () => {
    const where = makeWorld({ git: true, turn: recordedTurn });
    const { episodeId } = await checkCase(where);
    const aiDataDir = join(where.directory, 'launcher');
    await fakeSettings(aiDataDir);
    const die = {
      appId: 'items',
      message: 'Stop on a list',
      hunks: [
        {
          path: 'src/host/app.ts',
          find: "app.operation('items.list', () => ({ items: store.list(), count: store.count() + 1 }));",
          replace: "app.operation('items.list', () => process.exit(3));",
        },
      ],
    };
    const { results } = await replay({
      knowledge: where.knowledge,
      layout: where.root,
      episodeId,
      lessonId: null,
      runs: 1,
      model: fakeModel,
      providers: () => [createFakeAdapter(editing(die))],
      logger: quiet,
      aiDataDir,
      execPath: LAUNCHER,
      fetch: noNetwork,
      turnTimeoutMs: 60_000,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ arm: 'without', outcome: 'inconclusive', detail: 'the preview child died' });
    const row = where.knowledge.db.query<{ outcome: string; lesson_id: number | null }, []>('SELECT outcome, lesson_id FROM replays').get();
    expect(row).toEqual({ outcome: 'inconclusive', lesson_id: null });
  }, 300_000);

  test('evaluate --runs 1 writes every column for every condition and task', async () => {
    mkdirSync(runRoot, { recursive: true });
    const directory = mkdtempSync(join(runRoot, 'knowledge-evaluate-'));
    scratch.push(directory);
    const setup = openKnowledge(join(directory, 'launcher'));
    const learned = storeLesson(setup, {
      applies: { stage: 'views' },
      summary: 'A distilled lesson the learned condition carries.',
      trigger: 'items table filter done',
    });
    setup.close();

    // In a child process, for the reason `autoapp-evaluate-child.ts` gives:
    // under `bun test tests`, a bundle of Notes cannot resolve its provider
    // packages in this process.
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', join(import.meta.dir, 'autoapp-evaluate-child.ts'), directory],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    closers.push(() => {
      child.kill();
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`the evaluation failed: ${stderr}`);
    const { rows, markdown, runs } = JSON.parse(stdout) as {
      rows: {
        condition: string;
        task: string;
        includedUsed: number;
        includedIgnored: number;
      }[];
      markdown: string;
      runs: string[];
    };
    expect(runs).toHaveLength(CONDITIONS.length * EVALUATION_TASKS.length);
    expect(rows).toHaveLength(CONDITIONS.length * EVALUATION_TASKS.length);
    for (const condition of CONDITIONS) {
      for (const task of EVALUATION_TASKS) {
        const row = rows.find((entry) => entry.condition === condition && entry.task === task.id);
        expect(row).toMatchObject({
          runs: 1,
          workingCode: 0,
          workflowCompleted: 0,
          callsToFirstEdit: { mean: 1, of: 1 },
          callsToFirstBuild: { mean: null, of: 0 },
          reachedBuild: 0,
          failedBuilds: 0,
          approvals: 1,
          recurringSignatures: 0,
          timedOut: 0,
        });
      }
    }
    // The baseline was given nothing; 12b as shipped names files.
    const offered = (condition: string): number =>
      rows
        .filter((row) => row.condition === condition)
        .reduce((total, row) => total + row.includedUsed + row.includedIgnored, 0);
    expect(offered('baseline')).toBe(0);
    expect(offered('orientation+facts')).toBeGreaterThan(0);

    const header = markdown.split('\n').find((line) => line.startsWith('| condition'));
    for (const column of [
      'condition', 'task', 'runs', 'working code', 'workflow completed', 'calls to first edit', 'calls to first build',
      'reached a build', 'failed builds', 'timed out', 'mean model time', 'mean tool time', 'approvals', 'mean tokens',
      'recurring signatures', 'included refs used', 'included refs ignored', 'reads not offered', 'unrelated hint credit',
    ]) {
      expect(header).toContain(` ${column} |`);
    }
    expect(markdown.split('\n').filter((line) => /^\| (baseline|orientation|learned)/.test(line))).toHaveLength(12);

    // Only the learned condition carried the distilled lesson.
    const stamp = readdirSync(join(directory, 'evaluate'))[0] ?? '';
    // And every run was written down as it ended, not only at the end.
    const saved = readFileSync(join(directory, 'evaluate', stamp, 'runs.jsonl'), 'utf8').trim().split('\n');
    expect(saved).toHaveLength(CONDITIONS.length * EVALUATION_TASKS.length);
    expect(JSON.parse(saved[0] ?? '{}')).toMatchObject({ condition: 'baseline', task: 'notes-archive', n: 1, workingCode: false });
    const lessonsIn = (condition: string): number[] => {
      const store = new Database(join(directory, 'evaluate', stamp, condition, 'starter-done-filter', '1', KNOWLEDGE_FILE), { readonly: true });
      try {
        return store.query<{ id: number }, []>("SELECT id FROM lessons WHERE origin = 'distilled'").all().map((row) => row.id);
      } finally {
        store.close();
      }
    };
    expect(lessonsIn('learned')).toEqual([learned]);
    expect(lessonsIn('orientation+facts')).toEqual([]);
  }, 600_000);
});
