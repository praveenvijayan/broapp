/**
 * Notes, drawn by the pinned renderer.
 *
 * Rendered to a string rather than into a browser: there is no test library in
 * this workspace, and adding one to assert that three components appear would
 * be a large dependency for a small question. `renderToString` runs no effects,
 * so nothing here reaches the host — which is the point. What is under test is
 * that the view specification and the renderer agree well enough to produce the
 * components the application is supposed to have.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { BroappProvider } from 'broapp/react';
import { mergeContracts } from 'broapp/shared';
import type { JsonSchema } from 'broapp/shared';
import { autoappContract, Page } from 'broapp-autoapp/react';
import { checkViewsAgainstContract, parseViews } from 'broapp-autoapp/shared';
import { exportContract } from 'broapp-autoapp/spec';

import { contract } from '../src/shared/contract.ts';
import { notesViews } from '../src/shared/views.ts';

const merged = mergeContracts(contract, autoappContract);

/** What the renderer needs to know about each route, from the live contract. */
const routes = Object.fromEntries(
  Object.entries(merged.operations).map(([route, spec]) => [
    route,
    {
      effect: (spec as { effect?: string }).effect ?? 'write',
      input: (spec as { input: { toJsonSchema(): JsonSchema } }).input.toJsonSchema(),
    },
  ]),
);

/** Render one page of the Notes specification to HTML. */
function draw(pageId: string): string {
  const page = notesViews.pages.find((candidate) => candidate.id === pageId);
  if (page === undefined) throw new Error(`the specification has no page ${pageId}`);
  return renderToString(
    createElement(
      BroappProvider,
      { contract: merged, children: null } as never,
      createElement(Page, {
        views: notesViews,
        page,
        params: page.id === 'note' ? ['1'] : [],
        routes,
        navigate: () => undefined,
        confirm: () => true,
      }),
    ),
  );
}

describe('the Notes interface', () => {
  test('the specification is valid and agrees with the contract', () => {
    expect(() => parseViews(notesViews)).not.toThrow();
    expect(checkViewsAgainstContract(notesViews, exportContract(contract))).toEqual([]);
  });

  test('the notes page draws the form and the table', () => {
    const html = draw('notes');
    expect(html).toContain('data-autoapp-id="new-note"');
    expect(html).toContain('data-autoapp-id="notes-table"');
    // The columns are the ones the specification names, in its order.
    expect(html.indexOf('Title')).toBeLessThan(html.indexOf('Updated'));
    expect(html).toContain('No notes yet. Add one above.');
  });

  test('the details page draws the status values and the backup button', () => {
    const html = draw('status');
    expect(html).toContain('data-autoapp-id="backup"');
    expect(html).toContain('data-autoapp-id="db-path"');
    expect(html).toContain('Back up now');
  });

  test('the note page draws the edit form', () => {
    const html = draw('note');
    expect(html).toContain('data-autoapp-id="edit"');
    expect(html).toContain('data-autoapp-id="back"');
  });

  test('nothing the renderer emits is raw markup', () => {
    // A specification cannot introduce script, and a rendered page proves it:
    // the only tags present are the ones the renderer itself writes.
    const html = draw('notes') + draw('status') + draw('note');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
  });
});
