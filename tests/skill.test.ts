/**
 * The agent skill in `skills/broapp` follows the Agent Skills format
 * (https://agentskills.io/specification) so that `npx skills add
 * praveenvijayan/broapp` installs it into any supporting agent.
 *
 * These tests keep the frontmatter valid, the body within the recommended
 * size, and every relative link pointing at a file that exists.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const SKILL_DIR = resolve(import.meta.dir, '..', 'skills', 'broapp');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const text = readFileSync(SKILL_FILE, 'utf8');

function frontmatter(source: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (match === null) throw new Error('SKILL.md has no frontmatter');
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (pair !== null) fields[pair[1]!] = pair[2]!;
  }
  return fields;
}

const fields = frontmatter(text);
const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');

describe('skills/broapp/SKILL.md', () => {
  test('name matches the directory and the allowed pattern', () => {
    expect(fields['name']).toBe(basename(SKILL_DIR));
    expect(fields['name']).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(fields['name']!.length).toBeLessThanOrEqual(64);
  });

  test('description is present, within limits, and says when to use the skill', () => {
    const description = fields['description'] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Use when/);
  });

  test('compatibility stays within its limit', () => {
    expect((fields['compatibility'] ?? '').length).toBeLessThanOrEqual(500);
  });

  test('body stays under 500 lines', () => {
    expect(body.split('\n').length).toBeLessThan(500);
  });

  test('every relative link resolves to a file', () => {
    const links = [...body.matchAll(/\]\(((?:references|scripts)\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(existsSync(join(SKILL_DIR, link))).toBe(true);
    }
  });

  test('every reference file is linked from SKILL.md', () => {
    const referenced = new Set(
      [...body.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => basename(m[1]!)),
    );
    for (const file of ['contract-and-operations.md', 'streams.md', 'lifecycle-data-and-sqlite.md', 'security-rules.md', 'build-and-release.md', 'troubleshooting.md']) {
      expect(existsSync(join(SKILL_DIR, 'references', file))).toBe(true);
      expect(referenced.has(file)).toBe(true);
    }
  });

  test('verify.sh is executable and parses', async () => {
    const script = join(SKILL_DIR, 'scripts', 'verify.sh');
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const check = Bun.spawnSync(['bash', '-n', script]);
    expect(check.exitCode).toBe(0);
    expect(dirname(script)).toBe(join(SKILL_DIR, 'scripts'));
  });
});
