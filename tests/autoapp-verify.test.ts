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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChildHandle } from 'broapp-autoapp/launcher';
import {
  coverage,
  REFERENCE_TOPICS,
  runAcceptance,
  specReference,
  UNVERIFIED_BY_CHECKS,
  viewStepFailure,
} from 'broapp-autoapp/engineer';
import type { AcceptanceExample } from 'broapp-autoapp/spec';
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
});
