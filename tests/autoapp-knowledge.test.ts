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
  createCandidateStates,
  engineerTools,
  type CandidateStates,
  type TurnRecord,
} from 'broapp-autoapp/engineer';
import {
  AUTOAPP_VERSION,
  KNOWLEDGE_FILE,
  createEventLog,
  createEvidence,
  ftsQuery,
  openKnowledge,
  sanitise,
  signature,
  tokens,
  type EventLog,
  type Evidence,
  type FullOrigin,
  type Knowledge,
} from 'broapp-autoapp/knowledge';
import {
  BUILD_STAGES,
  STAGE_NAMES,
  buildCandidate,
  createLauncherApp,
  createLauncherTab,
  createSupervisor,
  launcherContract,
  openJournal,
  type Journal,
  type Supervisor,
} from 'broapp-autoapp/launcher';
import { layout, type Layout } from 'broapp-autoapp/spec';

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
}

/** A launcher root with the fixture as the `items` workspace, and knowledge beside it. */
function makeWorld(options: { git?: boolean; turn?: (runId: string) => TurnRecord | undefined } = {}): World {
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
    knowledge: {
      log,
      evidence,
      autoappVersion: AUTOAPP_VERSION,
      ...(options.turn === undefined ? {} : { turn: options.turn }),
    },
  });

  closers.push(
    () => supervisor.stopAll(5_000),
    () => journal.close(),
    () => store.close(),
    () => knowledge.close(),
  );
  return { root, directory, source: app.source, journal, supervisor, store, gate, states, knowledge, log, evidence, tools };
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
    expect(JSON.parse(context.included)).toEqual([]);
    expect(JSON.parse(context.requested)).toEqual([]);

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
