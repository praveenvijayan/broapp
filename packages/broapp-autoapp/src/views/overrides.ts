/**
 * A person's own changes to an interface somebody else wrote.
 *
 * Overrides are per-user and outlive releases, which is the whole difficulty:
 * the release they were made against may be gone, and the component they name
 * may be gone with it. The tempting thing is to drop an override that no longer
 * applies. This does not — a person who renamed a column and then updated the
 * application would find their change silently reverted, with nothing to
 * suggest it had ever been there.
 *
 * So an override that cannot apply is kept, and reported as a conflict. The
 * renderer shows one line per conflict, and the person can decide.
 */
import type { Column, Component, ViewsSpec } from './types.ts';

/** One person's change to one component. */
export interface Override {
  readonly componentId: string;
  readonly label?: string;
  readonly hidden?: boolean;
  /** Column id to header text, for tables. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Column ids in the order to show them; missing ids keep their place after these. */
  readonly columnOrder?: readonly string[];
}

/**
 * A component this person added, which the release does not have.
 *
 * Promotion writes one of these. It is how a saved workflow becomes a button
 * without a new release: the workflow lives in the application's own data, and
 * the thing that runs it is one more entry in the same per-user overrides file
 * as a renamed column.
 */
export interface Addition {
  readonly id: string;
  readonly page: string;
  readonly afterComponentId: string;
  readonly component: Component;
}

/** Everything one person changed. */
export interface Overrides {
  readonly version: 1;
  readonly items: readonly Override[];
  readonly additions?: readonly Addition[];
}

/** An override that names something the current release does not have. */
export interface Conflict {
  readonly componentId: string;
  readonly reason: string;
}

/** Nothing overridden. The shape `overridesGet` returns before anybody has changed anything. */
export const NO_OVERRIDES: Overrides = { version: 1, items: [], additions: [] };

/** Reorder columns by `columnOrder`, keeping unnamed ones in their original places. */
function reorder(columns: readonly Column[], order: readonly string[]): readonly Column[] {
  const named = order
    .map((id) => columns.find((entry) => entry.id === id))
    .filter((entry): entry is Column => entry !== undefined);
  const rest = columns.filter((entry) => !order.includes(entry.id));
  return [...named, ...rest];
}

/** Apply one override to one component, collecting whatever could not be applied. */
function applyTo(member: Component, override: Override, conflicts: Conflict[]): Component {
  let next: Component = member;
  if (override.label !== undefined) next = { ...next, label: override.label };
  if (override.hidden !== undefined) next = { ...next, hidden: override.hidden };

  if (override.headers !== undefined || override.columnOrder !== undefined) {
    const columns = next.columns;
    if (columns === undefined) {
      conflicts.push({
        componentId: override.componentId,
        reason: 'this component has no columns',
      });
      return next;
    }
    let updated: readonly Column[] = columns;
    for (const [id, header] of Object.entries(override.headers ?? {})) {
      if (!updated.some((entry) => entry.id === id)) {
        conflicts.push({ componentId: override.componentId, reason: `column ${id} no longer exists` });
        continue;
      }
      updated = updated.map((entry) => (entry.id === id ? { ...entry, header } : entry));
    }
    if (override.columnOrder !== undefined) {
      for (const id of override.columnOrder) {
        if (!updated.some((entry) => entry.id === id)) {
          conflicts.push({ componentId: override.componentId, reason: `column ${id} no longer exists` });
        }
      }
      updated = reorder(updated, override.columnOrder);
    }
    next = { ...next, columns: updated };
  }
  return next;
}

/**
 * Put `component` straight after `anchorId`, wherever that is in the tree.
 *
 * `null` when the anchor is not there — an added component with nothing to
 * anchor to is a conflict rather than something to append hopefully at the end,
 * because the position was part of what the person chose.
 */
function insertAfter(
  components: readonly Component[],
  anchorId: string,
  component: Component,
): readonly Component[] | null {
  const at = components.findIndex((member) => member.id === anchorId);
  if (at >= 0) {
    return [...components.slice(0, at + 1), component, ...components.slice(at + 1)];
  }
  for (const [index, member] of components.entries()) {
    if (member.children === undefined) continue;
    const inner = insertAfter(member.children, anchorId, component);
    if (inner === null) continue;
    return components.map((candidate, at2) =>
      at2 === index ? { ...candidate, children: inner } : candidate,
    );
  }
  return null;
}

/** Rebuild a component tree, applying whatever override names each component. */
function rewrite(
  components: readonly Component[],
  byId: ReadonlyMap<string, Override>,
  seen: Set<string>,
  conflicts: Conflict[],
): readonly Component[] {
  return components.map((member) => {
    const override = byId.get(member.id);
    let next = member;
    if (override !== undefined) {
      seen.add(member.id);
      next = applyTo(member, override, conflicts);
    }
    if (next.children !== undefined) {
      next = { ...next, children: rewrite(next.children, byId, seen, conflicts) };
    }
    return next;
  });
}

/**
 * Apply a person's overrides to a release's views.
 *
 * The input is never mutated: the caller holds the release's own specification,
 * which is immutable, and a customisation must not become part of it.
 */
export function applyOverrides(
  views: ViewsSpec,
  overrides: Overrides,
): { views: ViewsSpec; conflicts: readonly Conflict[] } {
  const byId = new Map(overrides.items.map((item) => [item.componentId, item]));
  const conflicts: Conflict[] = [];
  const seen = new Set<string>();

  let pages = views.pages.map((screen) => ({
    ...screen,
    children: rewrite(screen.children, byId, seen, conflicts),
  }));

  for (const addition of overrides.additions ?? []) {
    const screen = pages.find((candidate) => candidate.id === addition.page);
    if (screen === undefined) {
      conflicts.push({ componentId: addition.id, reason: `page ${addition.page} no longer exists` });
      continue;
    }
    const inserted = insertAfter(screen.children, addition.afterComponentId, addition.component);
    if (inserted === null) {
      conflicts.push({
        componentId: addition.id,
        reason: `component ${addition.afterComponentId} no longer exists`,
      });
      continue;
    }
    pages = pages.map((candidate) =>
      candidate.id === screen.id ? { ...candidate, children: inserted } : candidate,
    );
  }

  for (const item of overrides.items) {
    if (!seen.has(item.componentId)) {
      // Kept, not dropped. The next release may bring the component back, and
      // in the meantime the person is told rather than quietly overruled.
      conflicts.push({ componentId: item.componentId, reason: 'component no longer exists' });
    }
  }

  return { views: { ...views, pages }, conflicts };
}
