/**
 * Generator behaviour.
 *
 * These run the generator as a subprocess, the way a developer does, rather
 * than importing its internals — so what is tested is the command, including
 * its argument parsing and its exit codes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { checkAppName, checkDestination, suggestName } from '../packages/create-broapp/src/validate.ts';

const GENERATOR = resolve(import.meta.dir, '..', 'packages', 'create-broapp', 'src', 'main.ts');

let workspace = '';

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'broapp-generator-'));
});

afterAll(async () => {
  if (workspace !== '') await rm(workspace, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function generate(args: readonly string[], cwd = workspace): Promise<Run> {
  const child = Bun.spawn(['bun', GENERATOR, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // No TTY here, so the generator takes its non-interactive path.
    stdin: 'ignore',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

describe('name and path validation', () => {
  test('accepts ordinary names', () => {
    for (const name of ['my-app', 'notes', 'a1', 'my.app', 'my_app']) {
      expect(checkAppName(name).ok).toBe(true);
    }
  });

  test('rejects names that are illegal, unsafe, or platform-hostile', () => {
    for (const name of ['', 'My-App', 'my app', '.hidden', '_private', 'con', 'a/b', 'app-']) {
      expect(checkAppName(name).ok).toBe(false);
    }
  });

  test('rejects a destination that escapes the working directory', () => {
    expect(checkDestination('../elsewhere', '/home/dev/projects').ok).toBe(false);
    expect(checkDestination('nested/app', '/home/dev/projects').ok).toBe(true);
    // An absolute path is a deliberate act, so it is allowed.
    expect(checkDestination('/opt/things/app', '/home/dev/projects').ok).toBe(true);
  });

  test('derives a usable name from a path, or gives up honestly', () => {
    expect(suggestName('./my-app')).toBe('my-app');
    expect(suggestName('/a/b/My App/')).toBe('my-app');
    expect(suggestName('___')).toBeNull();
  });
});

describe('the generator command', () => {
  test('--help and --version exit 0', async () => {
    const help = await generate(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('create-broapp');

    const version = await generate(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('generates a complete project without a network', async () => {
    const run = await generate(['plain', '--yes', '--no-install']);
    expect(run.code).toBe(0);

    const project = join(workspace, 'plain');
    for (const file of [
      'package.json',
      'tsconfig.json',
      'broapp.config.ts',
      'README.md',
      '.gitignore',
      'src/shared/contract.ts',
      'src/host/main.ts',
      'src/host/operations.ts',
      'src/ui/main.tsx',
      'src/ui/index.html',
    ]) {
      expect(await stat(join(project, file)).then(() => true, () => false)).toBe(true);
    }

    const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe('plain');
    // A generated project must not depend on the workspace it came from.
    for (const range of Object.values(manifest.dependencies)) {
      expect(range).not.toContain('workspace:');
    }
  });

  test('substitutes every template marker', async () => {
    const run = await generate(['substituted', '--yes', '--no-install', '--title', 'My Notes']);
    expect(run.code).toBe(0);
    const project = join(workspace, 'substituted');
    for (const file of ['package.json', 'README.md', 'src/ui/index.html', 'src/ui/App.tsx']) {
      const text = await readFile(join(project, file), 'utf8');
      expect(text).not.toMatch(/__[A-Z_]+__/);
    }
    expect(await readFile(join(project, 'src/ui/App.tsx'), 'utf8')).toContain('My Notes');
  });

  test('ships a .gitignore, which npm would otherwise rename', async () => {
    await generate(['ignored', '--yes', '--no-install']);
    const text = await readFile(join(workspace, 'ignored', '.gitignore'), 'utf8');
    expect(text).toContain('node_modules/');
    expect(text).toContain('release/');
  });

  test('handles a destination containing spaces', async () => {
    const run = await generate(['my new app', '--name', 'my-new-app', '--yes', '--no-install']);
    expect(run.code).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(workspace, 'my new app', 'package.json'), 'utf8'),
    ) as { name: string };
    expect(manifest.name).toBe('my-new-app');
  });

  test('refuses a non-empty destination and leaves it untouched', async () => {
    const occupied = join(workspace, 'occupied');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'important.txt'), 'do not lose me', 'utf8');

    const run = await generate(['occupied', '--yes', '--no-install']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not empty');
    // The refusal must not have cost the user their file.
    expect(await readFile(join(occupied, 'important.txt'), 'utf8')).toBe('do not lose me');
    expect(await stat(join(occupied, 'package.json')).then(() => true, () => false)).toBe(false);
  });

  test('accepts a destination holding only a .git directory', async () => {
    const prepared = join(workspace, 'prepared');
    await mkdir(join(prepared, '.git'), { recursive: true });
    const run = await generate(['prepared', '--yes', '--no-install']);
    expect(run.code).toBe(0);
    expect(await stat(join(prepared, '.git')).then(() => true, () => false)).toBe(true);
  });

  test('refuses an invalid name', async () => {
    const run = await generate(['ok-dir', '--name', 'Bad Name', '--yes', '--no-install']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Refusing that name');
  });

  test('refuses a traversing destination', async () => {
    const run = await generate(['../escaped', '--yes', '--no-install']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('outside the current directory');
  });

  test('refuses an unknown option rather than ignoring it', async () => {
    const run = await generate(['dir', '--turbo', '--yes']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown option');
  });

  test('requires a destination when it cannot ask for one', async () => {
    const run = await generate(['--yes', '--no-install']);
    expect(run.code).toBe(2);
  });

  test('does not initialise git unless asked', async () => {
    await generate(['no-git', '--yes', '--no-install']);
    expect(
      await stat(join(workspace, 'no-git', '.git')).then(() => true, () => false),
    ).toBe(false);
  });
});
