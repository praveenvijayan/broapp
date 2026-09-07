# 08b — Fix-ups from the first pass

## Step 1 — a release's identity covers everything it contains

`ReleaseParts` is `{ page, host, spec }`; the digest is page · 0x00 · host ·
0x00 · `canonicalJson(stripIdentity(spec))`. `stripIdentity` **deletes**
`manifest.releaseId` and `createdAt` rather than blanking them, so a spec that
never had them hashes the same as one they were removed from.

`candidate.ts` assembles the whole `AppSpec` with a placeholder name, hashes it,
re-seals it. The old "does not alter the page, the host bundle or the contract"
refusal is gone. An identical rebuild is still `rebuilt: false`, detected by
comparing `stripIdentity` of stored against new — and if those ever differ it
**throws**, because that means the hash is not a function of the contents, and
continuing on a broken hash is how an approval authorises code nobody read.

A release built under the old rule reads as `conflict` with the prompt's
sentence. It is not migrated: renaming breaks every approval and `current`
naming it, and rehashing would assert its contents are what somebody approved,
which nothing here knows. `listReleases` reads without the check so a stale
release is **listed and labelled**, not quietly missing — somebody whose
`current` will not start needs to see the release that is the reason.
`releases` prints `stale`; `keepServing` refuses to start one and says why.

**Two activation tests changed rather than the check.** "A migration that
fails" and "an acceptance example that fails" both worked by editing a built
release in place, which the identity check now catches first — they failed at
phase `requested`. Both now break the **source** and build a real release. The
acceptance one is only possible because acceptance is part of the identity now.

## Step 2 — the engineer edits by hunk

`applyEdits` checks every hunk and computes every new file in memory before
writing, so a set either all lands or none does — a half-applied edit leaves the
model working out which half. Two hunks on one file apply in order to the same
buffer. Zero matches is `not found in <path>: …`; more than one is `ambiguous in
<path>: N matches, include more context`. `applyChange` and `applyEdits` share
the history-and-commit half so the two undo paths cannot drift.

`source.change` keeps creating files and now refuses to **replace** an existing
file over 60 lines, with a `rejected` naming `source.edit`. Creation stays
unlimited: there is no smaller way to say a new file.

## Step 3 — no `instanceof` across the release boundary

Five sites. What crosses, and how:

1. **`isPublicError`** — the `instanceof` fast path is gone. It was correct, but
   it is the shape somebody copies, and a check whose answer depends on which
   bundle asked is the bug this function exists to fix.
2. **`fromTransportError`, `BroappError`** — shared code. The browser calls it in
   one bundle; the child runtime calls it on an error out of a release's bundle
   (`run-child.ts` on an MCP forward, `workflows/run.ts` on a step).
3. **`fromTransportError`, `BridgeError`** — same call sites. A release bundles
   its own Brobridge, so a cancellation raised there was not `instanceof` the
   launcher's and became `internal` rather than `rejected`. `ErrorCode` is
   string constants, which is what makes the value comparison work across copies.
4. **`app.ts` × 2, `ValidationError`** — new `isValidationError`. A schema built
   in one bundle and parsed in another throws a different class with the same
   shape, and the message ("n: expected a finite number") was being replaced by
   a bare `invalid input`.
5. **`ai/host/registry.ts`, `PublicError`** — the rule applied, not a bug fixed;
   leaving it would have needed an allow-list entry that was not true.

`tests/autoapp-boundary.test.ts` reads both source trees and fails on any
`instanceof` outside an allow-list with a reason each. Intrinsics are listed
separately, because the test also insists every allow-list entry is **used** — an
exception nobody needs outlived its case. A third test builds same-shape errors
from a pretend other realm and checks the shape functions accept them and reject
an `Error` that only claims the name.

`assertAppInstance` checks what `start()` returned: `register`, `isBusy`,
`shutdown`, `invoke`, whole-number `schemaVersion`.

## Step 4 — the demo

**Provider.** Nothing is configured in the launcher tab — no `broapp-autoapp`
data directory exists at all. Per the prompt's rule the demo ran on local
Ollama, `qwen3.8:27b-mlx`, as prompt 07 did. A hosted OpenRouter provider is
configured for a *different* application here; I did not touch it, because
reaching for its key is what the rule forbids. `glm-5.2:cloud` was again not
used: it leaves the machine.

**Two nudges, both findings.** The engineer stopped before doing anything and
asked which application I meant — *"I don't have a way to list the applications
on this machine."* There is no `apps.list` tool. Later I told it a hunk had
failed on indentation.

| Step | Outcome |
|---|---|
| 3. The large request | **Reached `source.edit`, never reached a build.** Six attempts: 1 succeeded, 3 failed on whitespace, 2 timed out unanswered |
| 4. Tool sequence | `spec.read`, `source.list`, 8 × `source.read`, `source.edit` — three times over, unaided, in its instructions' order |
| 5–8. Preview, activate, workflow, promoted form | **Not attempted by a model in this pass** |

**The measurement this step existed for.** Report 07 watched this model spend 22
minutes composing a `source.change` that never left it. Time from last
`source.read` to the call landing:

| # | Think | Bytes | Hunks | Result |
|---|---|---|---|---|
| 1 | 7m12s | 9,672 | 7 | timed out unanswered |
| 2 | 10m42s | 3,473 | 4 | **failed** — 7 spaces where the file has 6 |
| 3 | 1m15s | 3,469 | 4 | timed out unanswered |
| 4 | 14m19s | 3,043 | 6 | **failed** — same, on `done: s.optional(…)` |
| 5 | 2m31s | 728 | 2 | **succeeded**, committed `4b8bc3e` |
| 6 | 1m30s | 2,379 | 5 | **failed** — same line again |

52 minutes from first message to the successful edit. Zero build iterations.

1. **Exact-match `find` is now the wrong contract for this model.** Three of four
   approved edits failed on leading whitespace in text `source.read` had just
   given it verbatim. Telling it explicitly did not help — the next attempt
   failed on the same line. The tool is no longer too slow; it is too strict.
2. **Smaller hunks succeed.** The one that landed was 728 bytes; the failures
   were 2,379 to 3,473.
3. **The 120-second confirm window is too short here.** A call arrives after 7
   to 14 minutes of silence, then gives a person two minutes. A gate default,
   not a model problem, and the reason two rows say "timed out".

**What worked, every time.** All-or-nothing held: after each rejected hunk set,
`git status` showed the workspace untouched and no commit. The model read before
editing, refused to retry blindly after a denial, asked what to adjust, and laid
out a correct five-file plan. The successful edit committed through git.

**Deviations.** (a) The scripted-model test drives a fake adapter's `source.edit`
through `ai.chat` and the real gate; the evidence a *real* model composes hunks
is the demo, which is where the prompt wants it. (b) The prompt caps
`instructions.ts` at 70 lines: the text is 62, the module 84 with its doc
comment (80 before this prompt). I read the budget as the text, which is what
reaches every system prompt.

## Commands run

```
bun run typecheck                                      exit 0
bun test tests/autoapp-spec.test.ts                    37 pass, 0 fail
bun test tests/autoapp-activation.test.ts              23 pass, 0 fail
bun test tests/autoapp-engineer.test.ts                30 pass, 0 fail
bun test tests/autoapp-boundary.test.ts                 3 pass, 0 fail
bun test tests                                        441 pass, 0 fail (29 files)
cd examples/notes && bunx tsc --noEmit && bun test tests && bun run build
                                                       exit 0; 23 pass; 69.9 MiB
bun run --cwd packages/broapp-autoapp build:launcher   dist/broapp-autoapp
bun run check                                          exit 0
```

## Acceptance criteria

- **Acceptance, views, migrations or capabilities alone change the identity;
  `createdAt` alone does not** — pass, one test per case plus a `stripIdentity`
  deletes-not-blanks test.
- **An old release directory is refused with the stated sentence** — pass: the
  spec test hand-builds one under the old rule and checks the refusal and the
  `stale` label; the activation test checks `keepServing` refuses and starts no
  child.
- **`source.edit` refuses ambiguous and missing hunks before touching any
  file** — pass in tests, and three times against a real model with the
  workspace verifiably untouched after each.
- **The boundary test passes and its allow-list has a reason per entry** — pass,
  and every entry must also be used.
- **One demo row per step 3 to 8 with an outcome** — pass. Steps 5 to 8 are
  recorded as not attempted by a model, the outcome the provider rule
  anticipates.

## For prompt 10

- **Whitespace-tolerant hunk matching**, or an error quoting the nearest real
  line. Now the single biggest obstacle to the loop.
- **An `apps.list` tool** — the engineer cannot discover what exists.
- **The gate's 120-second confirmation window** against a model that thinks for
  ten minutes.
- `listReleases` hashes every release to label staleness. Cheap today; wants an
  mtime-keyed cache once releases accumulate.
