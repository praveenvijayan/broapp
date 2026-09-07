/**
 * Reading a view specification.
 *
 * A view specification is the one part of a release an AI engineer edits most
 * often, and the one part a person is most likely to hand-edit. So it is
 * checked hard, and the checks that matter are the structural ones rather than
 * the shapes: a table pointing at a source that is not on the page, a link to a
 * page that does not exist, two components sharing an id. None of those is a
 * malformed value; all of them are an interface that would fail at the moment
 * somebody clicked it.
 */
import { s, ValidationError } from 'broapp/shared';
import type { Issue, JsonSchema, Result, Schema } from 'broapp/shared';

import { VIEWS_VERSION, type Action, type Component, type Page, type ViewsSpec } from './types.ts';

/** Where in a value a failure happened. */
type Path = readonly (string | number)[];

/**
 * A page, component or source identifier.
 *
 * Kept to lowercase and hyphens because these three are the names a *person*
 * sees: an override keys on a component id, and a template names a source id
 * inside a placeholder whose own grammar allows nothing else.
 */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * A column, field or action identifier.
 *
 * Broader, because these have to line up with names the contract chose. A form
 * field's id *is* the operation input's property name, and an application is
 * entitled to call one `schemaVersion`.
 */
const MEMBER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** What a `text` component's template may contain besides literal text. */
const PLACEHOLDER = /\{\{[a-z][a-z0-9-]*(\.[A-Za-z0-9_]+)*\}\}/g;
/** Anything that opens a placeholder. Used to find the ones that are not well formed. */
const ANY_BRACES = /\{\{[^}]*\}\}/g;

/** How deep a `section` may nest. A cycle is impossible in JSON, but depth is not. */
const MAX_DEPTH = 8;

function fail<T = never>(path: Path, message: string): Result<T> {
  return { ok: false, issues: [{ path, message }] };
}

/**
 * A schema for a recursive shape.
 *
 * `Component` contains `Component[]`, and a schema value cannot refer to itself
 * while it is being constructed. The indirection through a function defers the
 * reference to the first call, by which time the binding exists.
 */
function lazy<T>(build: () => Schema<T>): Schema<T> {
  let inner: Schema<T> | null = null;
  const resolve = (): Schema<T> => (inner ??= build());
  const self: Schema<T> = {
    kind: 'lazy',
    check: (value, path = []) => resolve().check(value, path),
    parse(value) {
      const outcome = self.check(value, []);
      if (outcome.ok) return outcome.value;
      throw new ValidationError(outcome.issues);
    },
    toJsonSchema: (): JsonSchema => ({ type: 'object' }),
  };
  return self;
}

/** Any JSON value, including `undefined` for an absent one. */
const anyValue = s.unknown();

/** An object whose keys are chosen by the author and whose values are literals. */
const inputMap: Schema<Record<string, unknown>> = {
  kind: 'input-map',
  check: (value, path = []) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : fail(path, 'expected an object'),
  parse(value) {
    const outcome = this.check(value, []);
    if (outcome.ok) return outcome.value;
    throw new ValidationError(outcome.issues);
  },
  toJsonSchema: () => ({ type: 'object' }),
};

const action = s.object({
  id: s.string({ pattern: MEMBER_PATTERN }),
  label: s.string({ min: 1, max: 200 }),
  operation: s.string({ min: 1, max: 200 }),
  input: s.optional(inputMap),
  confirmText: s.optional(s.string({ min: 1, max: 400 })),
  refresh: s.optional(s.array(s.string({ pattern: ID_PATTERN }), { max: 50 })),
  then: s.optional(
    s.object({
      page: s.string({ pattern: ID_PATTERN }),
      params: s.optional(s.array(s.string({ min: 1, max: 200 }), { max: 10 })),
    }),
  ),
});

const format = s.enum(['text', 'number', 'boolean', 'datetime']);

const column = s.object({
  id: s.string({ pattern: MEMBER_PATTERN }),
  header: s.string({ min: 1, max: 200 }),
  path: s.string({ min: 1, max: 200 }),
  format: s.optional(format),
  width: s.optional(s.enum(['narrow', 'normal', 'wide'])),
  link: s.optional(
    s.object({
      page: s.string({ pattern: ID_PATTERN }),
      params: s.array(s.string({ min: 1, max: 200 }), { max: 10 }),
    }),
  ),
});

const field = s.object({
  id: s.string({ pattern: MEMBER_PATTERN }),
  label: s.string({ min: 1, max: 200 }),
  type: s.enum(['text', 'textarea', 'number', 'boolean']),
  required: s.optional(s.boolean()),
  min: s.optional(s.number()),
  max: s.optional(s.number()),
  initial: s.optional(anyValue),
});

const component: Schema<Component> = lazy(
  () =>
    s.object({
      id: s.string({ pattern: ID_PATTERN }),
      kind: s.enum(['section', 'text', 'table', 'form', 'button', 'status']),
      label: s.optional(s.string({ max: 200 })),
      hidden: s.optional(s.boolean()),
      children: s.optional(s.array(component, { max: 100 })),
      template: s.optional(s.string({ max: 4_000 })),
      source: s.optional(s.string({ pattern: ID_PATTERN })),
      rows: s.optional(s.string({ min: 1, max: 200 })),
      columns: s.optional(s.array(column, { max: 50 })),
      rowActions: s.optional(s.array(action, { max: 20 })),
      emptyText: s.optional(s.string({ max: 400 })),
      fields: s.optional(s.array(field, { max: 100 })),
      submit: s.optional(action),
      action: s.optional(action),
      path: s.optional(s.string({ min: 1, max: 200 })),
      format: s.optional(format),
    }) as unknown as Schema<Component>,
);

const source = s.object({
  id: s.string({ pattern: ID_PATTERN }),
  operation: s.string({ min: 1, max: 200 }),
  input: s.optional(anyValue),
});

const page = s.object({
  id: s.string({ pattern: ID_PATTERN }),
  title: s.string({ min: 1, max: 200 }),
  params: s.optional(s.array(s.string({ pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ }), { max: 10 })),
  sources: s.optional(s.array(source, { max: 50 })),
  children: s.array(component, { max: 200 }),
});

const viewsShape = s.object({
  specVersion: s.number({ int: true, min: VIEWS_VERSION, max: VIEWS_VERSION }),
  pages: s.array(page, { min: 1, max: 200 }),
  home: s.string({ pattern: ID_PATTERN }),
});

/** Walk every component on a page, depth first, with its path for diagnostics. */
export function walkComponents(
  components: readonly Component[],
  at: Path,
  visit: (component: Component, path: Path) => void,
): void {
  for (const [index, member] of components.entries()) {
    const path = [...at, index];
    visit(member, path);
    if (member.children !== undefined) walkComponents(member.children, [...path, 'children'], visit);
  }
}

/** Every action reachable from one component, including a table's row actions. */
function actionsOf(member: Component): readonly Action[] {
  return [
    ...(member.action === undefined ? [] : [member.action]),
    ...(member.submit === undefined ? [] : [member.submit]),
    ...(member.rowActions ?? []),
  ];
}

/** What each kind of component must carry to be renderable at all. */
function kindIssues(member: Component, path: Path): Issue[] {
  const issues: Issue[] = [];
  const need = (field: string, present: boolean): void => {
    if (!present) issues.push({ path: [...path, field], message: `a ${member.kind} needs ${field}` });
  };
  switch (member.kind) {
    case 'section':
      need('children', member.children !== undefined);
      break;
    case 'text':
      need('template', member.template !== undefined);
      break;
    case 'table':
      need('source', member.source !== undefined);
      need('rows', member.rows !== undefined);
      need('columns', member.columns !== undefined && member.columns.length > 0);
      break;
    case 'form':
      need('fields', member.fields !== undefined && member.fields.length > 0);
      need('submit', member.submit !== undefined);
      break;
    case 'button':
      need('action', member.action !== undefined);
      break;
    case 'status':
      need('source', member.source !== undefined);
      need('path', member.path !== undefined);
      break;
  }
  return issues;
}

/** Everything that is about more than one field, checked after the shapes hold. */
function crossCheck(views: ViewsSpec): Issue[] {
  const issues: Issue[] = [];
  const pageIds = new Set<string>();
  const paramCount = new Map<string, number>();
  const componentIds = new Set<string>();

  for (const [index, screen] of views.pages.entries()) {
    if (pageIds.has(screen.id)) {
      issues.push({ path: ['pages', index, 'id'], message: `page id ${JSON.stringify(screen.id)} is used twice` });
    }
    pageIds.add(screen.id);
    paramCount.set(screen.id, (screen.params ?? []).length);
  }

  if (!pageIds.has(views.home)) {
    issues.push({ path: ['home'], message: `page ${JSON.stringify(views.home)} is not in this specification` });
  }

  for (const [index, screen] of views.pages.entries()) {
    const at: Path = ['pages', index];
    const sourceIds = new Set<string>();
    for (const [order, loaded] of (screen.sources ?? []).entries()) {
      if (sourceIds.has(loaded.id)) {
        issues.push({
          path: [...at, 'sources', order, 'id'],
          message: `source id ${JSON.stringify(loaded.id)} is used twice on this page`,
        });
      }
      sourceIds.add(loaded.id);
    }

    /** A page navigation, wherever it appears, has to name a page and match its arity. */
    const checkNavigation = (
      to: { readonly page: string; readonly params?: readonly unknown[] },
      where: Path,
    ): void => {
      if (!pageIds.has(to.page)) {
        issues.push({ path: where, message: `page ${JSON.stringify(to.page)} is not in this specification` });
        return;
      }
      const wanted = paramCount.get(to.page) ?? 0;
      const given = (to.params ?? []).length;
      if (given !== wanted) {
        issues.push({
          path: where,
          message: `page ${JSON.stringify(to.page)} takes ${String(wanted)} parameter(s), not ${String(given)}`,
        });
      }
    };

    walkComponents(screen.children, [...at, 'children'], (member, path) => {
      if (componentIds.has(member.id)) {
        issues.push({
          path: [...path, 'id'],
          message: `component id ${JSON.stringify(member.id)} is used twice`,
        });
      }
      componentIds.add(member.id);
      if (path.length > MAX_DEPTH * 2) {
        issues.push({ path, message: `sections are nested more than ${String(MAX_DEPTH)} deep` });
      }
      issues.push(...kindIssues(member, path));

      if (member.source !== undefined && !sourceIds.has(member.source)) {
        issues.push({
          path: [...path, 'source'],
          message: `source ${JSON.stringify(member.source)} is not loaded by this page`,
        });
      }

      if (member.template !== undefined) {
        // A template is text with named holes in it. Anything else that looks
        // like a hole is a mistake, and rendering it verbatim would show the
        // author's intention rather than a value.
        const all = member.template.match(ANY_BRACES) ?? [];
        const good = new Set(member.template.match(PLACEHOLDER) ?? []);
        for (const candidate of all) {
          if (!good.has(candidate)) {
            issues.push({
              path: [...path, 'template'],
              message: `${JSON.stringify(candidate)} is not a {{sourceId.path}} placeholder`,
            });
          }
        }
        for (const placeholder of good) {
          const head = placeholder.slice(2, -2).split('.')[0] ?? '';
          if (!sourceIds.has(head)) {
            issues.push({
              path: [...path, 'template'],
              message: `source ${JSON.stringify(head)} is not loaded by this page`,
            });
          }
        }
      }

      for (const [order, entry] of (member.columns ?? []).entries()) {
        if (entry.link !== undefined) {
          checkNavigation(entry.link, [...path, 'columns', order, 'link', 'page']);
        }
      }

      for (const performed of actionsOf(member)) {
        for (const reload of performed.refresh ?? []) {
          if (!sourceIds.has(reload)) {
            issues.push({
              path: [...path, 'refresh'],
              message: `source ${JSON.stringify(reload)} is not loaded by this page`,
            });
          }
        }
        if (performed.then !== undefined) {
          checkNavigation(performed.then, [...path, 'then', 'page']);
        }
      }
    });
  }

  return issues;
}

/** Validate one view specification. Throws `ValidationError` naming the first failure. */
export function parseViews(raw: unknown): ViewsSpec {
  const views = viewsShape.parse(raw) as unknown as ViewsSpec;
  const issues = crossCheck(views);
  if (issues.length > 0) throw new ValidationError(issues);
  return views;
}
