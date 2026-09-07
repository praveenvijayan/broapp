# 04 — Adoption, documentation, release

## What was built

`examples/notes` and the Autoapp launcher render `BroappChat`; both import
`broapp-ai-elements/styles.css` beside `ai.css`, which `AiSettings` still
needs. `pack-local.ts` runs `build:css` before packing, and
`autoapp-dry-run.ts` installs the new tarball. Docs: "The chat panel" in
`docs/ai.md` plus its limitations and testing paragraphs, the package in
`README.md` and `CONTRIBUTING.md`, both panels in `docs/architecture.md`, two
paragraphs in `docs/security.md`, the size delta in `docs/packaging.md`, the
panel choice and two new "never"s in the skill.

`release-dry-run.ts` was left alone: it builds a project from `create-broapp`,
whose promise is a network-free, AI-free first run, so it names no AI package.

**Size.** The notes binary went 69.9 → 72.4 MiB and its inline page 292.9 →
1148.4 KiB; the launcher page is 1129.6 KiB and its binary 74.6 MB.

## The manual run

Compiled binaries, `BROAPP_DATA_DIR` under `/tmp`, Ollama at
`127.0.0.1:11434`, model `qwen3.8:27b-mlx`. Nothing left the machine.

| # | Outcome |
|---|---|
| 1 | ✅ "AI is not set up. Open Settings to choose a provider." |
| 2 | ✅ "Used notes.list / Completed", an answer, "1492 tokens in, 77 out" |
| 3 | ✅ "Allow this?", "expires in 1:59", Allow → the note appeared in the table, "Used notes.create / Completed" |
| 4 | ✅ "Declined notes.create / Denied", the model said so, no note |
| 5 | ✅ text froze mid-sentence and stayed; the box re-enabled |
| 6 | ✅ bold rendered, `<ul>` list rendered |
| 7 | ✅ the words "Example" with 0 `<a>`, 0 `<img>`, and `example.com` nowhere in the DOM |
| 8 | ✅ thumbnail above the box, loading from a `data:` URL (after bug A) |
| 9 | ❌ not attempted: no model this build calls vision-capable — see Open questions |
| 10 | ❌ not attempted: needs row 9 |
| 11 | ✅ a 4000×3000 PNG downscaled and reached the host; no "too large" |
| 12 | ✅ "Only PNG, JPEG, GIF and WebP images.", nothing attached |
| 13 | ✅ "The chosen model cannot read images. Pick one that can in Settings." |
| 14 | ❌ not attempted: the in-app browser could not bootstrap the launcher — the launch token is single-use and was spent before the pane's own request. `curl` on a fresh token serves the page: 200, 1.15 MB, `.broapp-chat` in it |
| 15 | ❌ not attempted: needs rows 9 and 14 |
| 16 | ✅ dark `#16171a`/`#eceef1`, light `#fbfbfa`/`#1b1a18`, urgent amber `#e0b95a` / `#8a6a12` — the application's own palette |
| 17 | ✅ the `.broapp-chat *` reduced-motion rule is in the served stylesheet, read back through the CSSOM — the pane cannot emulate the query, so it was not watched |

## Bugs found, all fixed inside `broapp-ai-elements`

- **A. Attachments were `blob:` URLs.** A Broapp page's policy is
  `img-src 'self' data:` and `connect-src 'self' ws://127.0.0.1:*`, so the
  preview would not load *and* the vendored blob-to-data conversion — a `fetch`
  of the blob: URL — was refused, leaving the turn to be sent with a URL the
  transport could not read ("That file could not be read."). `prompt-input.tsx`
  now reads each `File` into a `data:` URL with `FileReader`. **LOCAL edit 4.**
- **B. `prepareImage` fetched the data URL** to decode it — the same
  `connect-src` violation. It now decodes the base64 itself, and reads the
  pixel size from the file header (`intrinsicSize`, new and tested), so an
  image already inside both limits is sent untouched with no decoder at all.
- **C. A stale turn error hid a fresh attachment complaint.** The attachment
  message now wins: it is about what the person just did.
- **D. The empty state said the same thing twice** — the caller's sentence and
  the component's default description. `description=""`.

## Commands run

`bun install`, `bun run check` (526 pass, 0 fail, 36 files), `bunx tsc
--noEmit` + `bun test tests` (23 pass) + `bun run build` in `examples/notes`,
`build:page` and `build:launcher` for `broapp-autoapp`, `bun run site` (20
files), `bun run dryrun` ("Dry run passed"), `bun run dryrun:autoapp` ("Autoapp
dry run passed"), `bun run scripts/smoke-binary.ts examples/notes/release/notes`
("All checks passed"). All exit 0.

## Open questions

- **`broapp-ai-compatible` reports `vision: false` for every model** (its
  `/v1/models` list says nothing about capabilities, `src/index.ts:115`), so
  the host refuses every image turn through Ollama. Ollama's own `/api/show`
  *does* report `vision` for `gemma4:31b-mlx`, `qwen3.8:27b-mlx` and
  `muse-glimmer:30b-mlx` on this machine. That file is off limits here; rows 9,
  10 and 15 wait on it.
- `bun run scripts/smoke-binary.ts … --call notes.list` fails because the
  script calls with `undefined` and that route's input is an object;
  `--call notes.status` passes. Pre-existing, in `scripts/smoke-binary.ts`.
- `broapp dev` works on this machine again — report 07 found it broken.
