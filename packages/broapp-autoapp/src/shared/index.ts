/**
 * `broapp-autoapp/shared` — everything both sides import.
 *
 * No host code and no browser code: the contract, the view specification types,
 * and the pure functions over them. Nothing reachable from here may touch
 * `node:` or `bun:`, because the browser bundle follows these imports and a
 * page that could reach the filesystem would be a bug. A test asserts it.
 */
export { autoappContract } from './contract.ts';
export type { AutoappContract } from './contract.ts';

export { VIEWS_VERSION } from '../views/types.ts';
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
} from '../views/types.ts';

export { parseViews, walkComponents } from '../views/validate.ts';
export { checkViewsAgainstContract } from '../views/check.ts';
export { applyOverrides, NO_OVERRIDES } from '../views/overrides.ts';
export type { Conflict, Override, Overrides } from '../views/overrides.ts';
