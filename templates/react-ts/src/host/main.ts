/**
 * The host entry point. This is what `bun build --compile` turns into an
 * executable.
 *
 * The UI arrives as an ordinary import of the document `broapp build` produced.
 * `with { type: "text" }` makes Bun inline its contents into the bundle, so the
 * compiled binary carries its interface inside it: no asset directory, nothing
 * resolved relative to the executable, and nothing to break when the file is
 * moved to another machine.
 *
 * The cast is a types-only wrinkle: `@types/bun` declares every `*.html`
 * import as Bun's `HTMLBundle`, without looking at the import attribute. With
 * `{ type: "text" }` the value really is a string — verified at runtime — and
 * there is no narrower way to say so today.
 */
import pageAsset from '../../dist/ui.html' with { type: 'text' };
import manifest from '../../package.json' with { type: 'json' };

import { ensureDataDir, startApp } from 'broapp/host';

import { createApp, type HostFacts } from './operations.ts';

const page = pageAsset as unknown as string;

const APP_NAME = manifest.name;
const VERSION = manifest.version;

const HELP = `${APP_NAME} ${VERSION}

Usage: ${APP_NAME} [options]

  --background     Keep running after the browser tab closes.
  --no-open        Do not open a browser; print the address instead.
  --data-dir       Print where this application stores data, then exit.
  -v, --version    Print the version.
  -h, --help       Print this message.

Environment:
  BROAPP_DATA_DIR    Override the data directory.
  BROAPP_LIFECYCLE   "interactive" or "background".
  BROAPP_OPEN_BROWSER  "0" to suppress the browser launch.

This application listens on the loopback interface only. Its address carries a
one-time token; treat it as a password until you have opened it.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(VERSION);
    return 0;
  }

  // Created before anything else needs it, so a permissions problem surfaces
  // here rather than at the first write.
  const dataDir = ensureDataDir(APP_NAME);
  if (argv.includes('--data-dir')) {
    console.log(dataDir);
    return 0;
  }

  const lifecycle =
    argv.includes('--background') || process.env['BROAPP_LIFECYCLE'] === 'background'
      ? 'background'
      : 'interactive';

  const facts: HostFacts = {
    appName: APP_NAME,
    version: VERSION,
    dataDir,
    development: process.env['BROAPP_DEV'] === '1',
    lifecycle,
  };

  const app = createApp(facts);

  const running = await startApp({
    page,
    appName: APP_NAME,
    version: VERSION,
    mode: lifecycle,
    openBrowser: !argv.includes('--no-open') && process.env['BROAPP_OPEN_BROWSER'] !== '0',
    register: (bridge) => app.mount(bridge),
    // An idle exit must not throw away a computation someone is watching. The
    // grace period is for a closed tab, not for a busy host.
    isBusy: () => app.activeStreams > 0,
    onShutdown: () => {
      // Nothing to flush in the starter. A real application closes its
      // database here; see the SQLite example.
      app.abortAll('the application is shutting down');
    },
  });

  return await running.done;
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(`${APP_NAME} could not start: ${String(cause instanceof Error ? cause.message : cause)}`);
    process.exit(1);
  },
);
