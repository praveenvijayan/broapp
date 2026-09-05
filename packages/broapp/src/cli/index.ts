/**
 * `broapp/build` — the build tooling, as a library.
 *
 * The `broapp` command is the usual way in. This entry point exists so a
 * project with an unusual pipeline can call the same functions directly
 * instead of reimplementing them.
 */
export { buildPage } from './build-page.ts';
export type { BuildPageOptions, BuildPageResult } from './build-page.ts';
export { buildBinary } from './build-binary.ts';
export type { BuildBinaryOptions, BuiltBinary } from './build-binary.ts';
export { currentTarget, findTarget, TARGETS } from './targets.ts';
export type { Target } from './targets.ts';
export { defineConfig, loadConfig } from './config.ts';
export type { BroappConfig, ResolvedConfig } from './config.ts';
export { runDev } from './dev.ts';
export type { DevOptions } from './dev.ts';
