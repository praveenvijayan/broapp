# Notes

A small persistent application: a notes list backed by SQLite, with a versioned
schema, validated CRUD, and a real backup.

```bash
bun install
bun run dev
bun run build && ./release/notes
```

Your notes live in `notes.sqlite` inside the application's data directory. Run
`./release/notes --data-dir` to print the path, or open **Data and backups** in
the application.

## What it demonstrates

**Persistence in a compiled binary.** `bun:sqlite` is part of the Bun runtime,
so it is embedded in the executable along with everything else — there is no
native module to install and nothing to resolve at startup. The trade-off is
that the SQLite in the binary is the one Bun linked for that target, which is
worth remembering when cross-compiling: the build produces a binary, it does not
prove that binary runs.

**Schema versioning.** `src/host/db.ts` holds an ordered list of migrations.
Each is applied once, inside a transaction that also bumps `user_version`, so an
interrupted upgrade leaves the database at the last version that fully applied —
never half-way through one. There are deliberately two migrations, so the
mechanism is exercised rather than merely described.

A database whose `user_version` is *newer* than the build understands is
refused, not silently used. A downgrade that quietly ignores columns it does not
know about is how data gets lost.

**Failure that has an answer.** If the database cannot be opened, the
application still starts. It reports the problem and shows the file's path, so a
user can move it aside — which is what they need — instead of meeting a spinner
or a crash.

**Backups that are actually consistent.** The button uses SQLite's
`VACUUM INTO`, which writes a complete single-file copy while the application
keeps running. Copying `notes.sqlite` yourself while it is open does not: in WAL
mode the recent writes live in a sidecar, and a copy taken mid-write can be
missing them. On shutdown the WAL is checkpointed, so the file left behind is
complete on its own.

## Safety notes

Every value reaches SQLite as a bound parameter; no statement is assembled by
string concatenation. There is a test that stores `'; DROP TABLE notes; --` as a
title and reads it back verbatim.

## Where to look

- `src/host/db.ts` — migrations, queries, backup, shutdown.
- `src/host/operations.ts` — validation and the public/internal error boundary.
- `tests/db.test.ts` — migration idempotence, persistence across restart,
  backup readability.
