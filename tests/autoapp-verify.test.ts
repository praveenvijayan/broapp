/**
 * What an acceptance check proves, and the reference that says what the
 * specification means.
 *
 * A route step proves the host and a view step proves the view specification;
 * neither renders a page, and the runner has to say so every time. The
 * reference is prose beside the code, so a test holds it to the types: a
 * property the types declare and the reference does not mention is a rule the
 * engineer would be told nothing about.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { refusedByRoute, routeRefusal, type ChildHandle } from 'broapp-autoapp/launcher';
import { PublicError } from 'broapp/shared';
import {
  contains,
  coverage,
  DESIGN_CHECK,
  DESIGN_RULES,
  designTopic,
  divergence,
  REFERENCE_TOPICS,
  runAcceptance,
  specReference,
  stepFailure,
  UNVERIFIED_BY_CHECKS,
  viewStepFailure,
} from 'broapp-autoapp/engineer';
import type { AcceptanceExample, RouteStep } from 'broapp-autoapp/spec';
import type { ViewsSpec } from '../packages/broapp-autoapp/src/views/types.ts';

const views: ViewsSpec = {
  specVersion: 1,
  home: 'notes',
  pages: [
    {
      id: 'notes',
      title: 'Notes',
      children: [
        {
          id: 'tools',
          kind: 'section',
          children: [
            {
              id: 'archive',
              kind: 'button',
              label: 'Archive',
              action: { id: 'do', label: 'Archive', operation: 'notes.archive', confirmText: 'Archive?' },
            },
          ],
        },
      ],
    },
    { id: 'empty', title: 'Empty', children: [] },
  ],
};

describe('a view step', () => {
  test('finds a component anywhere on the page and compares what it declares', () => {
    expect(viewStepFailure({ view: { page: 'notes', component: 'archive', match: { kind: 'button', label: 'Archive' } } }, views)).toBeNull();
    expect(
      viewStepFailure({ view: { page: 'notes', component: 'archive', match: { action: { operation: 'notes.delete' } } } }, views),
    ).toMatch(/component archive on page notes is declared as .* does not contain/);
  });

  test('says when a page or a component is not declared, and when one should not be', () => {
    expect(viewStepFailure({ view: { page: 'notes', component: 'missing' } }, views)).toBe(
      'component missing on page notes is not declared',
    );
    expect(viewStepFailure({ view: { page: 'archive' } }, views)).toBe('page archive is not declared');
    expect(viewStepFailure({ view: { page: 'archive', exists: false } }, views)).toBeNull();
    expect(viewStepFailure({ view: { page: 'notes', component: 'archive', exists: false } }, views)).toMatch(
      /is declared, and the step says it must not be/,
    );
    // A page with no children is a fact a step can state.
    expect(viewStepFailure({ view: { page: 'empty', match: { children: [] } } }, views)).toBeNull();
  });

  test('cannot be judged without a view specification, and says so', () => {
    expect(viewStepFailure({ view: { page: 'notes' } }, undefined)).toMatch(/not given a view specification/);
  });
});

describe('runAcceptance', () => {
  /** A child that must never be asked: every step here is about the specification. */
  const untouchable: ChildHandle = {
    invoke: () => Promise.reject(new Error('a view step must not reach the child')),
  } as unknown as ChildHandle;

  test('judges view steps without the child, and counts what the examples cover', async () => {
    const examples: AcceptanceExample[] = [
      {
        id: 'declared',
        title: 'The archive button is declared',
        steps: [{ view: { page: 'notes', component: 'archive', match: { label: 'Archive' } } }],
      },
      { id: 'gone', title: 'The archive page is gone', steps: [{ view: { page: 'archive', exists: false } }] },
    ];
    const results = await runAcceptance(untouchable, examples, views);
    expect(results.map((result) => result.passed)).toEqual([true, true]);
    expect(coverage(examples)).toEqual({ host: 0, structure: 2 });
    expect(coverage([{ id: 'r', title: 'r', steps: [{ route: 'notes.list', input: {} }, ...examples[0]!.steps] }])).toEqual({
      host: 1,
      structure: 1,
    });
  });

  test('the sentence about what no check shows names the person at the preview', () => {
    expect(UNVERIFIED_BY_CHECKS).toMatch(/neither renders a page/);
    expect(UNVERIFIED_BY_CHECKS).toMatch(/open the preview/);
  });
});

describe('the specification reference', () => {
  const typesText = readFileSync(join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'views', 'types.ts'), 'utf8');
  const stepsText = readFileSync(join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'spec', 'types.ts'), 'utf8');

  test('names every property the view types declare, as code', () => {
    const declared = new Set([...typesText.matchAll(/^\s+readonly (\w+)\??:/gm)].map((match) => match[1]));
    expect(declared.size).toBeGreaterThan(30);
    const text = specReference('views');
    const missing = [...declared].filter((name) => !text.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  test('names every component kind and every acceptance step field', () => {
    const kinds = /kind: ('[a-z]+'(?: \| '[a-z]+')*)/.exec(typesText)?.[1] ?? '';
    const names = [...kinds.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    expect(names.length).toBe(6);
    for (const kind of names) expect(specReference('views')).toContain(`\`${kind}\``);

    const stepBlock = stepsText.slice(stepsText.indexOf('export interface RouteStep'), stepsText.indexOf('export type AcceptanceStep'));
    const fields = new Set([...stepBlock.matchAll(/^\s+readonly (\w+)\??:/gm)].map((match) => match[1]));
    for (const field of fields) expect(specReference('acceptance')).toContain(`\`${field}\``);
  });

  test('is served a topic at a time, and whole when none is named', () => {
    for (const topic of REFERENCE_TOPICS) expect(specReference(topic)).toMatch(new RegExp(`^# ${topic} `));
    const whole = specReference();
    for (const topic of REFERENCE_TOPICS) expect(whole).toContain(specReference(topic));
    expect(specReference('views')).toMatch(/confirmText.*required on a button/s);
    expect(specReference('views')).toMatch(/submit.*exempt/s);
  });

  test('the views topic points at the design topic', () => {
    expect(specReference('views')).toContain('`design` topic');
    expect(specReference('design')).toBe(designTopic());
  });
});

/**
 * The design topic is guidance, which is exactly why it needs a test: prose
 * about design drifts into prose the engineer cannot act on, and a rule naming
 * something the renderer does not have is a rule it will invent a way to
 * follow.
 */
describe('the design topic', () => {
  const typesText = readFileSync(join(import.meta.dir, '..', 'packages', 'broapp-autoapp', 'src', 'views', 'types.ts'), 'utf8');
  const declared = new Set([...typesText.matchAll(/^\s+readonly (\w+)\??:/gm)].map((match) => match[1]));
  const kinds = [...(/kind: ('[a-z]+'(?: \| '[a-z]+')*)/.exec(typesText)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map(
    (match) => match[1] as string,
  );

  test('every rule names a real kind and a property the types declare', () => {
    expect(kinds.length).toBe(6);
    const subjects = new Set([...kinds, 'page']);
    for (const rule of DESIGN_RULES) {
      expect(rule.kinds.length).toBeGreaterThan(0);
      for (const kind of rule.kinds) expect(subjects.has(kind)).toBe(true);
      for (const property of rule.properties ?? []) expect(declared.has(property)).toBe(true);
    }
  });

  test('every kind is named by at least one rule', () => {
    for (const kind of kinds) {
      expect(DESIGN_RULES.some((rule) => rule.kinds.includes(kind as never))).toBe(true);
    }
  });

  test('says nothing the renderer cannot express, and stays short', () => {
    const text = designTopic();
    // What a declarative renderer with six kinds has no way to act on. A line
    // about any of it is a line the engineer would have to invent a way to obey.
    for (const word of ['font', 'animate', 'motion', 'oklch', 'gradient', 'glass', 'modal', 'hero', 'landing']) {
      expect(text.toLowerCase()).not.toContain(word);
    }
    expect(text.split('\n').length).toBeLessThan(120);
    expect(text).toMatch(/^# design /);
  });

  test('carries the eight-item check, and every section, in order', () => {
    const text = designTopic();
    expect(DESIGN_CHECK.length).toBe(8);
    for (const item of DESIGN_CHECK) expect(text).toContain(item);
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      'What a good page is',
      'Structure',
      'Every state',
      'Copy',
      'Colour and contrast',
      'Before you ask the person to look',
    ]);
  });
});

/**
 * The detector, over the page a person actually looks at.
 *
 * `theme-check` measures the pairs it was told about; this reads every
 * text-on-background pair there is, which is how four contrast failures in the
 * gallery's own frame survived the harness. It is skipped, loudly, when the CLI
 * is not installed — an offline checkout should not fail on a missing binary.
 */
describe('the design detector', () => {
  const repo = join(import.meta.dir, '..');
  const cli = join(repo, 'node_modules', '.bin', 'impeccable');
  const gallery = join(repo, 'packages', 'broapp-autoapp', '.broapp-tmp', 'theme-gallery.html');
  const available = existsSync(cli);

  test.skipIf(!available)('finds nothing primary in the theme gallery', () => {
    // The gallery is generated, not committed, so the test draws it first.
    const drawn = Bun.spawnSync(['bun', 'run', '--cwd', join(repo, 'packages', 'broapp-autoapp'), 'theme-gallery'], {
      cwd: repo,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(drawn.exitCode).toBe(0);
    expect(existsSync(gallery)).toBe(true);

    const run = Bun.spawnSync([cli, 'detect', '--no-config', '--no-advisory', '--json', gallery], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = run.stdout.toString().trim();
    const findings = text === '' ? [] : (JSON.parse(text) as { antipattern: string; snippet: string }[]);
    expect(findings.map((finding) => `${finding.antipattern}: ${finding.snippet}`)).toEqual([]);
    // 0 is "no primary findings"; 2 is "at least one".
    expect(run.exitCode).toBe(0);
  }, 60_000);
});

/** The attribution the package carries, because the topic is somebody else's work. */
describe('the package notice', () => {
  const packageDir = join(import.meta.dir, '..', 'packages', 'broapp-autoapp');

  test('ships, and names Impeccable, its author, its licence and the modification', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      files: readonly string[];
    };
    expect(manifest.files).toContain('NOTICE.md');

    const notice = readFileSync(join(packageDir, 'NOTICE.md'), 'utf8');
    expect(notice).toContain('Impeccable');
    expect(notice).toContain('Paul Bakaus');
    expect(notice).toContain('Apache License, Version 2.0');
    expect(notice).toContain('This is a modification.');
    // The file the notice is about, named so a reader can check the claim.
    expect(notice).toContain('src/engineer/design.ts');
  });
});

describe('where a step diverges', () => {
  test('names the first field that differs, under expect and under match', () => {
    expect(divergence({ items: [{ id: 1, count: 2 }], total: 1 }, { items: [{ id: 1, count: 3 }], total: 1 }, 'expect')).toBe('items.0.count');
    expect(divergence({ items: [] }, { items: [{ id: 1 }] }, 'match')).toBe('items.length');
    expect(divergence({ a: 1, extra: true }, { a: 1 }, 'expect')).toBe('extra');
    // Under match an extra key is not a difference; the value itself is the divergence only when nothing narrower is.
    expect(divergence({ a: 1, extra: true }, { a: 2 }, 'match')).toBe('a');
    expect(divergence('x', 'y', 'expect')).toBe('$');
    expect(divergence({ notes: { count: 1 } }, { notes: { count: 1, list: [] } }, 'match')).toBe('notes.list');
  });

  test('a failed route step says which comparison failed and where', () => {
    const detail = stepFailure({ route: 'items.list', input: null, expect: { items: [], count: 99 } }, { items: [], count: 0 });
    expect(detail).toMatch(/\(expect; differs at count\)/);
    const partial = stepFailure({ route: 'items.list', input: null, match: { items: [{ label: 'a' }] } }, { items: [] });
    expect(partial).toMatch(/\(match; differs at items\.length\)/);
    expect(stepFailure({ route: 'items.list', input: null, match: { count: 0 } }, { items: [], count: 0 })).toBeNull();
  });
});

describe('14d: an example can say "some number" and "this is refused"', () => {
  const kinds = ['string', 'number', 'boolean', 'array', 'object', 'null', 'any'] as const;
  const samples: Record<(typeof kinds)[number], unknown> = {
    string: 'a',
    number: 5,
    boolean: false,
    array: [],
    object: {},
    null: null,
    // Every JSON value has one of the six other kinds; `any` takes each of them.
    any: undefined,
  };

  test('$is under match: each kind against its own and every other', () => {
    for (const kind of kinds) {
      for (const [other, value] of Object.entries(samples).filter(([name]) => name !== 'any')) {
        const wanted = kind === 'any' || other === kind;
        expect({ kind, other, passed: contains({ v: value }, { v: { $is: kind } }) }).toEqual({ kind, other, passed: wanted });
      }
    }
    // `any` needs the key there, and takes a null in it.
    expect(contains({ v: null }, { v: { $is: 'any' } })).toBe(true);
    expect(contains({}, { v: { $is: 'any' } })).toBe(false);
    expect(contains({}, { v: { $is: 'null' } })).toBe(false);
    // A number is finite.
    expect(contains({ v: Number.NaN }, { v: { $is: 'number' } })).toBe(false);
    expect(contains({ v: Number.POSITIVE_INFINITY }, { v: { $is: 'number' } })).toBe(false);
  });

  test('$is nested in an object and in an array element; the array-length rule unchanged', () => {
    const wanted = { items: [{ id: { $is: 'number' }, title: 'Milk' }] };
    expect(contains({ items: [{ id: 7, title: 'Milk', doneAt: 1 }] }, wanted)).toBe(true);
    expect(contains({ items: [{ id: '7', title: 'Milk' }] }, wanted)).toBe(false);
    expect(contains({ items: [] }, wanted)).toBe(false);
    expect(contains({ items: [{ id: 7, title: 'Milk' }, { id: 8, title: 'Milk' }] }, wanted)).toBe(false);
    expect(contains({ a: { b: { c: [1, 2] } } }, { a: { b: { c: { $is: 'array' } } } })).toBe(true);
  });

  test('expect never reads $is: it compares literally', () => {
    const step = { route: 'r.x', input: null, expect: { n: { $is: 'number' } } };
    expect(stepFailure(step, { n: 5 })).toContain('(expect; differs at n)');
    expect(stepFailure(step, { n: { $is: 'number' } })).toBeNull();
  });

  test('a matcher miss names the path, the kind wanted and the value got, cut at 80', () => {
    const step = { route: 'notes.markDone', input: { id: 1 }, match: { note: { doneAt: { $is: 'number' } } } };
    const detail = stepFailure(step, { note: { doneAt: '2026-09-18' } }) ?? '';
    expect(detail).toContain('differs at note.doneAt: expected a number, got "2026-09-18"');
    expect(divergence({ a: 'x'.repeat(200) }, { a: { $is: 'array' } }, 'match')).toBe(`a: expected an array, got "${'x'.repeat(78)}…`);
    expect(divergence({ a: 1 }, { a: { $is: 'null' } }, 'match')).toBe('a: expected null, got 1');
    // A missing key is still named as the path alone.
    expect(divergence({}, { a: { $is: 'any' } }, 'match')).toBe('a');
  });

  /** A child that answers each route from a table: a value, a route's refusal, or a crash. */
  const childOf = (answers: Record<string, () => unknown>): ChildHandle =>
    ({
      invoke: async ({ route }: { route: string }) => {
        const answer = answers[route];
        if (answer === undefined) throw new Error(`no answer for ${route}`);
        return answer();
      },
    }) as unknown as ChildHandle;
  const refusing = childOf({
    'items.add': () => {
      throw refusedByRoute('invalid_input', 'title: must be at least 1 character');
    },
    'items.list': () => ({ items: [], count: 0 }),
    'items.crash': () => {
      throw refusedByRoute('internal', 'The application could not complete that operation.');
    },
    'items.gone': () => {
      // What the supervisor throws when the child dies: not the route's answer.
      throw new PublicError('unavailable', 'the application stopped (exit code 1)');
    },
  });
  const one = async (steps: RouteStep[]): Promise<{ passed: boolean; detail?: string }> => {
    const [result] = await runAcceptance(refusing, [{ id: 'e', title: 'e', steps }]);
    return result ?? { passed: false, detail: 'no result' };
  };

  test('fails: a refusing route passes, by code and by words, and each mismatch says why', async () => {
    expect(await one([{ route: 'items.add', input: { title: '' }, fails: {} }])).toEqual({ id: 'e', title: 'e', passed: true } as never);
    expect((await one([{ route: 'items.add', input: {}, fails: { code: 'invalid_input', message: 'title' } }])).passed).toBe(true);
    expect((await one([{ route: 'items.list', input: null, fails: {} }])).detail).toBe(
      'items.list succeeded with {"items":[],"count":0}, but the example says it is refused',
    );
    expect((await one([{ route: 'items.add', input: {}, fails: { code: 'conflict' } }])).detail).toBe(
      'items.add was refused with invalid_input, but the example says conflict (title: must be at least 1 character)',
    );
    expect((await one([{ route: 'items.add', input: {}, fails: { message: 'Title' } }])).detail).toContain('which does not contain "Title"');
    expect((await one([{ route: 'items.crash', input: {}, fails: {} }])).detail).toBe(
      'items.crash failed with an internal error, which is not a refusal',
    );
    expect((await one([{ route: 'items.gone', input: {}, fails: {} }])).detail).toMatch(/failed with an internal error, which is not a refusal/);
    // A step with no `fails` is refused the way it always was.
    expect((await one([{ route: 'items.add', input: {} }])).detail).toBe('title: must be at least 1 character');
    expect(routeRefusal(new PublicError('invalid_input', 'x'))).toBeNull();
  });

  test('a refusal does not stop the example: refused, and the list is unchanged, is two steps', async () => {
    const refusedThenListed: RouteStep[] = [
      { route: 'items.add', input: { title: '' }, fails: { code: 'invalid_input' } },
      { route: 'items.list', input: null, match: { count: 0, items: { $is: 'array' } } },
    ];
    expect((await one(refusedThenListed)).passed).toBe(true);
    const listChanged: RouteStep[] = [refusedThenListed[0]!, { route: 'items.list', input: null, match: { count: 1 } }];
    expect((await one(listChanged)).detail).toContain('differs at count');
  });
});
