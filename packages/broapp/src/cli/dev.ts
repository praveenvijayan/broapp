/**
 * `broapp dev` — one command that watches, rebuilds and restarts.
 *
 * ## Why there is no hot module replacement
 *
 * HMR needs a channel the page can pull new modules over. In a Broapp
 * application there is exactly one such channel — the authenticated Brobridge
 * bridge — and every other route is a `404`, on purpose. The usual shortcut is
 * a second dev server on another port with permissive CORS, which is precisely
 * the thing this starter must not do: it would serve the application from an
 * unauthenticated origin, and the development build would stop resembling the
 * shipped one in the way that matters most.
 *
 * So the workflow here is rebuild-and-reload, and it is honest about it. A
 * change to UI code rebuilds the page and restarts the host, and the browser
 * tab reconnects. Reload cost is roughly the bundle time plus a page load,
 * which for a starter-sized UI is well under a second.
 *
 * ## Why the browser opens only once
 *
 * A restart mints a new one-time launch token, so the old tab's cookie is for
 * a host that no longer exists — Brobridge sessions do not survive the process
 * that minted them, and pretending otherwise would be exactly the "silent
 * resume" the spec warns against. `broapp dev` therefore opens the browser on
 * the first start only and, on every restart afterwards, prints the fresh
 * launch URL for the developer to reload with. A rebuild does not spawn a tab.
 */
import { watch } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { buildPage } from './build-page.ts';
import type { ResolvedConfig } from './config.ts';

/** Options for {@link runDev}. */
export interface DevOptions {
  readonly config: ResolvedConfig;
  /** Directories to watch. Default: the whole of `src`. */
  readonly watchDirs?: readonly string[];
  /** Open a browser on the first successful start. Default `true`. */
  readonly open?: boolean;
  /** Debounce for filesystem events. Default 120 ms. */
  readonly debounceMs?: number;
}

/** Run the development loop. Resolves when the developer stops it. */
export async function runDev(options: DevOptions): Promise<number> {
  const { config } = options;
  const debounceMs = options.debounceMs ?? 120;
  const watchDirs = (options.watchDirs ?? ['src']).map((dir) => resolve(config.root, dir));

  let child: ReturnType<typeof Bun.spawn> | null = null;
  let generation = 0;
  let restarting: Promise<void> = Promise.resolve();
  let stopped = false;
  let firstStart = true;

  const stopChild = async (): Promise<void> => {
    const current = child;
    child = null;
    if (current === null) return;
    // SIGTERM lets the host run its shutdown hook — close the database, end
    // streams — before the listener goes. A host that ignores it gets 3 s.
    current.kill('SIGTERM');
    const deadline = Bun.sleep(3_000).then(() => 'timeout' as const);
    const exited = await Promise.race([current.exited, deadline]);
    if (exited === 'timeout') current.kill('SIGKILL');
  };

  const cycle = async (): Promise<void> => {
    const mine = (generation += 1);
    await stopChild();
    if (stopped || mine !== generation) return;

    const started = Date.now();
    try {
      const page = await buildPage({
        root: config.root,
        entry: config.uiEntry,
        template: config.uiTemplate,
        outFile: config.pageOut,
        minify: false,
        csp: config.csp,
      });
      if (stopped || mine !== generation) return;
      console.log(
        `[broapp] ui ${(page.bytes / 1024).toFixed(0)} KiB in ${String(Date.now() - started)} ms`,
      );
    } catch (cause) {
      console.error(`[broapp] build failed:\n${String(cause instanceof Error ? cause.message : cause)}`);
      console.error('[broapp] waiting for a change…');
      return;
    }

    if (stopped || mine !== generation) return;
    child = Bun.spawn(['bun', 'run', resolve(config.root, config.hostEntry)], {
      cwd: config.root,
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        // The host opens the browser itself on a cold start only. On a restart
        // the developer already has a tab; a second one per save is noise.
        BROAPP_OPEN_BROWSER: firstStart && options.open !== false ? '1' : '0',
        // A dev host that exits because the tab is momentarily gone would race
        // every restart. The developer stops it with Ctrl+C.
        BROAPP_LIFECYCLE: 'background',
        BROAPP_DEV: '1',
      },
    });
    if (!firstStart) {
      console.log('[broapp] host restarted — reload the tab (its previous session ended with the old process)');
    }
    firstStart = false;
  };

  const queue = (): void => {
    restarting = restarting.then(cycle, cycle);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const bump = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(queue, debounceMs);
  };

  const watchers = watchDirs
    .filter((dir) => existsSync(dir))
    .map((dir) =>
      watch(dir, { recursive: true }, (_event, filename) => {
        if (filename === null) return;
        // Ignore the artefact this loop writes, or every build triggers another.
        const written = relative(dir, resolve(config.root, config.pageOut));
        if (filename === written || filename.startsWith(`${dirname(written)}/`)) return;
        if (!/\.(?:tsx?|jsx?|css|html|json)$/.test(filename)) return;
        console.log(`[broapp] changed: ${join(relative(config.root, dir), filename)}`);
        bump();
      }),
    );

  if (watchers.length === 0) {
    console.warn(`[broapp] nothing to watch under ${watchDirs.join(', ')}`);
  }

  queue();

  return await new Promise<number>((resolveExit) => {
    const shutdown = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      void restarting.then(stopChild).then(() => resolveExit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
