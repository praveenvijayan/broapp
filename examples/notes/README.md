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

## AI

The example is also the reference for Broapp's optional [AI layer](../../docs/ai.md).
It is off until you open **Settings** and choose a provider; four are compiled
in — Anthropic, Ollama, OpenAI, and any OpenAI-compatible server.

What it shows:

- **The model reads your notes, not your disk.** `context.resolve` turns the
  `note:<id>` reference for the note you are editing into a document, and
  `context.search` runs the same bounded `LIKE` query the application uses.
  Nothing else is visible to it.
- **Reading is free; changing asks.** `notes.list` is a read tool and runs when
  the model asks for it. `notes.create`, `notes.update` and `notes.remove` are
  confirm tools: the chat shows what is about to happen and waits for Allow or
  Decline. The tools come from the contract, so a model's arguments are
  validated exactly like a call from the browser.
- **Where the data goes is on screen.** The settings panel says whether the
  chosen provider runs on this computer or receives your notes, always, without
  opening a menu.

## Where to look

- `src/host/db.ts` — migrations, queries, backup, shutdown.
- `src/host/operations.ts` — validation and the public/internal error boundary.
- `src/host/ai.ts` — what the model may read, and what it may do.
- `tests/db.test.ts` — migration idempotence, persistence across restart,
  backup readability, and the two queries the AI layer uses.
