# Report 19b — Choosing the folder in the form

Written by the reviewing session, not the one that did the work. The 19b
session stopped at 12:55 on 2026-09-21 after the docs step, with the code,
the tests, the docs and nineteen screenshots in the working tree and neither
a report nor a commit. What follows is what the tree and the screenshots
show; what only that session could have known is listed as not recorded
rather than filled in.

## What is there

- `src/launcher/choose-folder.ts`: `launcher.folderChoose`, effect `write`.
  Constant scripts; the prompt and `startAt` reach `osascript` through
  `on run argv` (after `--`, which osascript does not count as an argument —
  checked at review), PowerShell through `AUTOAPP_FOLDER_PROMPT` /
  `AUTOAPP_FOLDER_START`, `zenity` and `kdialog` as whole arguments. One
  window at a time, a five-minute deadline that is an option, `stop()` called
  from the launcher's shutdown through `tab.app.shutdown()`.
- macOS comes to the front with osascript's own `activate`, which names no
  other application. Whether that raised a permission prompt is **not
  recorded**; the code comment says it does not.
- The page: `ui/new-application.ts` (the form's state, the generation counter,
  the follow-up `locationCheck` that tells a location refusal from an id
  refusal), `AppsTable.tsx`, `ui/storage.ts` (the guarded `localStorage`
  helper moved out of `App.tsx`, plus `rememberedText`), `ui/on-return.ts`.
- What refreshes the list: nothing re-read it while the page sat open, so it
  is re-read on window focus and on `visibilitychange` to visible. No timer.
- Every sentence is in `location-words.ts`; nine were added for the page.
- `location.ts`, `create.ts`, `layout.ts` and `packages/broapp` were untouched
  by 19b. (The review then changed `location.ts`; see below.)

## Tests

`tests/autoapp-folder.test.ts`, 20 tests, green with 19a's 23 and the two the
review added: `bun test tests/autoapp-location.test.ts
tests/autoapp-folder.test.ts` — 45 pass. The full gate is in the release
notes of the version that ships this, not here.

## By hand

Screenshots in `reports/19b/`, light and dark, wide and narrow: the form at
rest, with a target, with a problem under the field; a missing row with
`Locate…` and Open enabled; the removal confirmation; the after-removal line.
macOS only. **Not recorded**: the protected-folder case, Create pressed with
the window open, the keyboard-only pass, VoiceOver, the run with `osascript`
off the `PATH`, whether the form could be submitted twice, and what the
engineer and Backlog panels show for a refused turn (19a's report has the
engineer's answer from the command line's side). No Windows or Linux dialog
was run by anybody; both are unit-tested through the argument builder only.

## Found at review, fixed in the following commit

1. `launcher.appCreate`'s `notes` were capped at 400 characters and
   `launcher.locationCheck`'s `problem` at 600, both numbers from the prompts.
   A folder may be 1,024 long and both sentences carry it, and a route's answer
   is parsed against its own schema: a long folder created the application and
   then reported an error. Now 1,400 and 2,400; a test creates into a
   520-character folder through the route.
2. `locate` refused a folder inside another application's workspace and not
   one that *holds* another's. It does now, after the root check, with its own
   sentence.
3. `apps.list`'s description said "and and"; `describeReceipt` tested
   `!== undefined` where the receipt's value may be `null`.

## Open

- `launcher.locationCheck` is a read, so on channel `ai` it answers without a
  question, and its sentences tell "does not exist" from "is a file". On a
  person's own computer, beside tools that already read their workspace, that
  is little; `security.md` should say so.
- 19a saw one workspace build to two release ids at two paths. Release
  identity depends on the absolute path of the source. True before 19a, when
  the path never changed; a backlog row.
