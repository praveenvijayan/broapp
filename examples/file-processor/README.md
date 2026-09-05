# File Processor

Counts lines, words and characters across text files in a directory the host
was explicitly given, and writes a report. Progress streams; cancelling really
cancels.

```bash
bun install
bun run dev
bun run build && ./release/file-processor --root ~/Documents/notes
```

Without `--root` it uses a `workspace` folder inside its own data directory.
Run `./release/file-processor --data-dir` to see where that is.

## Why there is no file picker

A browser `<input type="file">` hands JavaScript a `File` object and withholds
its absolute path. That is a deliberate privacy boundary in the browser, not an
oversight — so a browser-picked file **cannot** be named to a host process at
all, and any design that assumes otherwise is broken before it starts.

What a local application should do instead, and what this one does: the host is
given one authorized root when it starts. The browser may list what is inside
that root and name files **relative** to it. The host resolves each name against
the root and refuses anything landing outside.

## How the boundary is enforced

One function, `src/host/workspace.ts`, and every filesystem call goes through
it. The rule is:

> Resolve the name against the root, follow symlinks, then ask whether the
> result is under the root.

The order matters. Checking the input string for `..` is the obvious
implementation and it is wrong three ways: it misses an absolute path, it misses
an encoded separator, and it misses a symlink inside the root that points
outside it. Resolving first collapses all three into one question with one
answer. `tests/boundary.test.ts` has a case for each, including a real symlink.

Refusals are deliberately vague — "outside the folder this application may read"
— so a caller probing the boundary learns nothing about what else is on the
disk.

## How output is written

- Reports go to `reports/` inside the root, never elsewhere.
- Nothing is overwritten. A name that exists gets a numbered suffix, claimed
  atomically with `wx` so two runs cannot pick the same one.
- **A cancelled run writes nothing.** The report is only written once every file
  is done. A partial report that looks complete is worse than no report.

## Limits

Files over 32 MB are skipped rather than read into memory. Only a fixed set of
text extensions is listed. Subdirectories and symlinks are not listed.

## Where to look

- `src/host/workspace.ts` — the containment check. Read this one first.
- `src/host/operations.ts` — listing, counting, and the report writing.
- `tests/boundary.test.ts` — traversal, absolute paths, symlinks.
