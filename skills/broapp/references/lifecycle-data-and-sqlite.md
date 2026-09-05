# Lifecycle, data directory, SQLite, and file roots

## startApp

`src/host/main.ts` already calls this. Adjust the options, do not rewrite
the file.

```ts
const running = await startApp({
  page,                      // the built document, imported with { type: 'text' }
  appName: APP_NAME,
  version: VERSION,
  mode: lifecycle,           // 'interactive' | 'background'
  openBrowser: !argv.includes('--no-open') && process.env['BROAPP_OPEN_BROWSER'] !== '0',
  register: (bridge) => app.mount(bridge),
  idleGraceMs: 20_000,       // interactive: no attached tab for this long, then exit
  launchTimeoutMs: 120_000,  // no tab ever connected, then exit 1
  isBusy: () => app.activeStreams > 0 || pendingWrites > 0,
  onShutdown: (reason) => { store.close(); },   // 'signal' | 'idle' | 'never-connected' | 'requested'
});
return await running.done;   // exit code
```

`bridge` options pass through to Brobridge, except `host`, `index` and
`allowNonLoopback`, which are not forwarded. Loopback is not overridable.

## Two modes

- **interactive** (default). The process serves a tab. When the last tab has
  been gone for `idleGraceMs` and `isBusy()` is false, it exits. A launch no
  browser ever reaches exits with status 1 after `launchTimeoutMs`.
- **background**. Keeps running after the tab closes; stops on Ctrl+C,
  SIGTERM, or `stop()`. Still a foreground process. Broapp does not
  daemonise and does not install a service. The user writes a launchd plist
  or systemd unit if they want one.

Flags the template already handles: `--background`, `--no-open`,
`--data-dir`, `--version`, `--help`. Environment: `BROAPP_LIFECYCLE`,
`BROAPP_OPEN_BROWSER=0`, `BROAPP_DATA_DIR`, and `BROAPP_DEV=1` set by
`broapp dev`.

"Attached" means a live WebSocket, not "a session exists". Each tab is its
own session; the host stays up while any is attached.

## Shutdown order

SIGINT, SIGTERM and `stop()` take one path:

1. Stop the idle poll, unregister signal handlers.
2. `onShutdown(reason)`. Flush, checkpoint, close the database. A failure is
   logged and does not stop the rest.
3. `bridge.close()`. Open streams abort (handlers see `sink.signal`).
4. `done` resolves with the exit code.

A stream in flight at shutdown is cancelled, not finished. If work must
complete, report it through `isBusy` so the idle path waits. A SIGTERM still
ends it.

## Data directory

```ts
import { ensureDataDir, dataDir, DATA_DIR_ENV } from 'broapp/host';
const dir = ensureDataDir(APP_NAME);   // created with mode 0700
```

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/<name>` |
| Linux | `$XDG_DATA_HOME/<name>`, else `~/.local/share/<name>` |
| Windows | `%APPDATA%\<name>` |

`BROAPP_DATA_DIR` overrides it verbatim. `<app> --data-dir` prints it.
Never write beside the executable (may be read-only) or in the working
directory (two launches, two databases). Replacing the binary leaves the
directory alone, so updates keep data.

## SQLite

`bun:sqlite` is part of the Bun runtime and compiles into the binary. No
native module to install. Pattern from the `notes` example:

```ts
// src/host/db.ts
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX notes_updated ON notes(updated_at DESC)`,
];

export function openStore(dataDir: string) {
  const path = join(dataDir, 'notes.sqlite');
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema ${current} is newer than this build understands (${MIGRATIONS.length})`);
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }

  const insert = db.prepare('INSERT INTO notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)');
  return {
    path,
    create(title: string, body: string): number {
      const now = Date.now();
      return Number(insert.run(title, body, now, now).lastInsertRowid);
    },
    backup(to: string): void { db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`); },
    close(): void { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); },
  };
}
```

- Every value reaches SQLite as a bound parameter. Never concatenate input
  into SQL. The `VACUUM INTO` path above is host-chosen, not user input.
- Migrations run once each, inside a transaction that bumps `user_version`,
  so an interrupted upgrade stops at the last complete version.
- A database newer than the build is refused, not silently used.
- If the database cannot open, start anyway: report the problem and show
  the file path in the UI (via a `PublicError` or a status operation) so the
  user can move the file aside.
- Backups use `VACUUM INTO`, which is consistent while the app runs. Copying
  the file under WAL is not.
- Close in `onShutdown`.

Wire it in `main.ts`:

```ts
const store = openStore(dataDir);
const app = createApp({ ...facts, store });
await startApp({ ..., onShutdown: () => { app.abortAll('shutting down'); store.close(); } });
```

## Files: one authorized root

A browser `<input type="file">` never reveals an absolute path, so there is
no way for the page to "pick" a file for the host. Do this instead:

1. The host gets one root at startup: a `--root <dir>` flag, or a
   `workspace` folder inside the data directory by default.
2. The browser lists what is under the root and names files **relative** to
   it.
3. Every filesystem call goes through one containment function:

```ts
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function within(root: string, name: string): string {
  const base = realpathSync(root);
  const candidate = resolve(base, name);
  let real: string;
  try { real = realpathSync(candidate); } catch { real = candidate; }   // may not exist yet
  if (real !== base && !real.startsWith(base + sep)) {
    throw publicError.rejected('That file is outside the folder this application may read.');
  }
  return real;
}
```

Resolve first, then compare. Checking the string for `..` misses absolute
paths, encoded separators, and symlinks inside the root pointing outside.
Keep refusals vague so a probe learns nothing about the disk.

Also: skip files over a size limit rather than reading them into memory,
list only a fixed set of extensions, write outputs only under the root and
never overwrite (open with `wx`, add a numbered suffix), and make a
cancelled run write nothing partial.
