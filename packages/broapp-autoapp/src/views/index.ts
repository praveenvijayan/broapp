/**
 * The internal barrel for the view specification.
 *
 * Not a package entry point: `broapp-autoapp/shared` is what the browser and
 * the host both import. This exists so the spec store, the host and the
 * renderer do not each reach into individual files.
 */
export { VIEWS_VERSION } from './types.ts';
export type {
  Action,
  Column,
  Component,
  Field,
  Format,
  Page,
  Path,
  Source,
  ViewsSpec,
} from './types.ts';

export { parseViews, walkComponents } from './validate.ts';
export { checkViewsAgainstContract } from './check.ts';
export { applyOverrides, NO_OVERRIDES } from './overrides.ts';
export type { Conflict, Override, Overrides } from './overrides.ts';
