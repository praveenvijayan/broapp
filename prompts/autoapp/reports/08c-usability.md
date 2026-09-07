# 08c — Engineer usability from the 08b demo

## What was built

- `engineer/workspace.ts`: `applyEdits` matches a hunk exactly, then line-wise
  with leading whitespace ignored, reporting `matchedBy: ('exact'|'indent')[]`
  per hunk. An indent match is applied with the file's own indentation; an
  ambiguous one names every line it matched on; a miss quotes the nearest real
  line with its number. No third, looser pass, and a comment says why.
- `launcher/apps.ts`: `listApps`, `appIds`, `serving`. `launcher.appsList` and
  the new `apps.list` tool are the same rows from the same helper; the tool
  drops `pid`. `instructions.ts` names `apps.list` first in the loop, forgives
  whitespace, and asks for hunks of three to eight lines. 66 lines.
- `broapp/src/host/gate.ts`: `ApprovalQuestion` gains `askedAt` and `expiresAt`,
  filled for every call from the gate's own `confirmTimeoutMs`.
  `LAUNCHER_CONFIRM_TIMEOUT_MS = 600_000` in `launcher/app.ts` is used by
  `createLauncherGate` (which `main.ts` now calls instead of `createGate`) and
  passed to `createAi` through `createLauncherTab`.
- `broapp/shared`: `countdown`, `isUrgent`, `remainingMs`, `URGENT_MS`. The
  approvals strip and the chat's confirm card show "expires in 9:41" and turn
  amber under a minute. `broapp-autoapp/react` adds `titleWithPending`,
  `announcePending`, `browserSurface`; `AiChat` gained an optional `onAwaiting`,
  and the launcher's tab uses it to prefix its title with `(n) ` and raise a
  notification only where permission was already granted.
- `docs/autoapp/security.md`, new, with both numbers under approvals;
  `docs/autoapp/design.md` points at it. 16 new tests in
  `tests/autoapp-engineer.test.ts` and `tests/autoapp-gate.test.ts`.

## Deviations, and why

1. **Nested replacements keep their nesting.** The prompt's unequal-line-count
   rule is "the first matched line's indentation for every replacement line that
   began with whitespace"; applied literally it flattens a nested block. The
   rule here is that, plus whatever a line was indented *beyond the shallowest
   indented line in `replace`* — identical to the prompt whenever the
   replacement is one level throughout, which is the case its own test names.
2. **The title change is tested against an injected surface, not
   `react-dom/server`,** which runs no effects and cannot observe a
   `document.title` write. `announcePending` takes the surface it changes.
3. **Five files in the AI layer changed** (`shared/types.ts`,
   `shared/contract.ts`, `host/run.ts`, `react/use-ai-chat.ts`,
   `react/AiChat.tsx`): the prompt requires a countdown on the launcher's chat
   card, the card is `AiChat`, and `expiresAt` has to reach it over `ai.chat`.
   `onAwaiting` is opt-in, so no existing chat behaves differently.
4. **Three test files gained `askedAt`/`expiresAt` in hand-built records**; no
   assertion changed. The commit trailer names Claude Opus 5, per this
   session's attribution rule.

## The demo, step 3 only

Same provider as 08b: local Ollama, `qwen3.8:27b-mlx`. Nothing left the
machine; no key was entered. Fresh root, Notes imported, request sent once.

| # | Think | Bytes | Hunks | Result | `matchedBy` |
|---|---|---|---|---|---|
| 1 | 5m16s | 2,520 | 1 | **succeeded**, committed `545a36f` | `['indent']` |
| 2 | 1m16s | 1,535 | 2 | **succeeded**, committed `21fc131` | `['exact','indent']` |
| 3 | 2m08s | 721 | 1 | **succeeded**, committed `61f0658` | `['indent']` |

Three for three, against 08b's one for six. **Four of the five hunks matched
only because indentation is ignored** — under 08b's rules the first edit, the
third, and half the second would all have failed.

The loop was `apps.list`, `spec.read`, `source.list`, 12 × `source.read`, then
the three edits. **`apps.list` was called first, unaided**; 08b's first nudge is
gone. No question expired. Question 2 sat unread for 3m43s before I saw it —
under the old 120 s window it would already have been refused. The card read
"expires in 9:35" and the tab title read `(1) Autoapp` while it waited.

**A build was not reached.** The turn ended `succeeded` at 36m19s after the
third edit, still planning the host and contract changes, without calling
`candidate.build`. The workspace was clean after every edit and all three
landed as git commits.

## Commands run

```
bun run typecheck                                       exit 0
bun test tests/autoapp-{engineer,gate}.test.ts          73 pass, 0 fail
bun test tests                                          457 pass, 0 fail (29 files)
bun run --cwd packages/broapp-autoapp build:launcher    dist/broapp-autoapp
bun install && bun run check                            exit 0
cd examples/notes && bunx tsc --noEmit && bun test tests exit 0; 23 pass
```

## Acceptance criteria

- **08b's three whitespace failures, replayed, now apply** — pass. The report
  does not quote the hunks, so the test uses the equivalent it describes: seven
  spaces where the file has six, and a `s.optional(…)` line added inside an
  object, one call, all `indent`. The demo is the stronger evidence.
- **A not-found hunk error quotes a real nearby line** — pass, in the form
  `not found in <path>: <first line>. Closest line <n>: "<text>"`.
- **`apps.list` exists and the instructions name it first** — pass, in a test
  and as the model's first call.
- **The launcher's questions last ten minutes and show it** — pass: a gate test
  proves the window is the option, not a constant; the card read "expires in
  9:35".

## Open questions

- `docs/autoapp/design.md` still describes `releaseId` as covering page, host
  and contract; 08b widened it to the whole specification and did not update the
  document. Not touched here — not this prompt's file.
- The model spent 20 minutes after the third edit emitting nothing, then ended
  the turn. Hunk size is no longer what stops it; the plan itself is.
