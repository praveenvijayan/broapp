# 19b — Choosing the folder in the form

## Goal

19a made the host able to put an application's source workspace in a folder a
person chose: `launcher.appCreate` takes a `location`, `launcher.locationCheck`
says where the project would be made, `launcher.appsList` says where each
workspace is and whether it is still there, `launcher.appLocate` repoints one
that moved, and removal says what it left behind. None of it is on the page.
Today only `broapp-autoapp create … --at <dir>` reaches it.

After this prompt the New application form has a **Where it lives** field
with the system's own folder dialog behind it; an application whose workspace
has gone says so on its row, still opens, and has a `Locate…` button; and the
removal confirmation says, before the person types the id, that their folder
will be left alone.

A person who never touches the new field sees the form post exactly what it
posts today.

## Read first

- `prompts/autoapp/00-common-rules.md`. Prompt 19a and **its report, whole** —
  the section on what 19b needs, anything in its *Fixed decisions* it found
  wrong, and what the approval for `launcher.appCreate` shows on channel `ai`.
  If the report and this prompt disagree about a route's shape, the code is
  right: read `contract.ts` and say so in your report.
- `src/launcher/contract.ts`: `launcher.appCreate` (`location`),
  `launcher.locationCheck`, `launcher.appLocate`, `appSummary.workspace`, the
  removal description and receipt (`workspaceLeftAt`).
- `src/launcher/location.ts` (`checkLocation`, `sourceState`) and
  `src/launcher/location-words.ts` — the sentences. The page imports the words
  from there; it does not write its own.
- `src/launcher/app.ts`: how `install`, `initGit` and `openBrowser` are options
  a test replaces. The folder chooser follows that pattern. How `openBrowser`
  spawns per platform, if it does.
- `src/launcher/ui/AppsTable.tsx`, whole: the create form (~214), its error
  and pending states, the row, the removal confirmation (~414) and the
  after-removal line (~327). `App.tsx` ~100–120: how `localStorage` is read and
  written so that a browser refusing it breaks nothing.
- `packages/broapp/src/ai/react/use-ai-models.ts`: the generation counter that
  drops an answer that arrives after a newer request. The live check uses the
  same idea.
- The launcher's stylesheet and `docs/autoapp/design-guidance.md`: the muted
  line, the warning line, the secondary button. No new colour, no new
  component library, nothing a class that exists already does.
- The view tests that render `AppsTable` without a browser, and how they fake
  an operation.

## Fixed decisions

| Decision | Value |
|---|---|
| The dialog | A new route, `launcher.folderChoose`, effect `'write'` — it puts a window on a person's screen, so on channel `ai` it is asked about, and there is no engineer tool for it. Input `{ startAt: s.optional(s.string({ max: 1024 })) }`, output `{ available: s.boolean(), chosen: s.nullable(s.string({ max: 1024 })) }`. Implemented in a new `src/launcher/choose-folder.ts`, replaceable through the launcher's options as `install` is, so no test opens a window. |
| Per platform | macOS: `osascript`, `choose folder with prompt … default location …`, answering `POSIX path of`. Windows: `powershell -NoProfile -STA -Command` with `System.Windows.Forms.FolderBrowserDialog`. Linux: `zenity --file-selection --directory`, else `kdialog --getexistingdirectory`, else `available: false`. `available: false` also when Linux has neither `DISPLAY` nor `WAYLAND_DISPLAY`, and whenever the spawn itself fails (`ENOENT`) — never an error for a missing program. |
| The dialog is not trusted | **No path is ever interpolated into a script.** `Bun.spawn` with an argument array, never a shell string. On macOS the prompt and `startAt` arrive through `on run argv`; on Windows through environment variables the script reads; `zenity` and `kdialog` take them as separate arguments (`--filename=<dir>/` is one argv element). A pure function builds `{ cmd, env }` per platform so a test can read it. What comes back is a string like any other: the form sends it through `launcher.locationCheck`, and `launcher.appCreate` checks it again. |
| The dialog's edges | Cancel — `osascript` exit 1 with `-128`, an empty PowerShell result, `zenity`/`kdialog` exit 1 — is `chosen: null`, not an error, and the form says nothing about it. Any other non-zero exit is `available: false` with the stderr's last line logged, not shown. One dialog at a time: a second call while one is open is `publicError.conflict` (`A folder window is already open.`). A dialog left open is killed after five minutes (an option, so a test uses milliseconds) and answers `chosen: null`. The launcher shutting down kills it. A trailing newline and a trailing separator are trimmed; `/` and `C:\` are left alone. A `startAt` that does not exist or is not a directory is dropped, not an error. |
| Coming to the front | On macOS the window often opens behind the browser. Do not reach for `System Events` or `activate` of another application — that asks the person for an automation permission to save them one click. The form says where the window is (*The form*). If `osascript`'s own `activate` inside the script brings it forward without a permission prompt, use it and say so in the report; if it prompts, do not. |
| Where the words come from | `location-words.ts`. The two the page adds — the status while the dialog is open, and the hint under the typed field — go in the same module. |
| `localStorage` | One key, `broapp-autoapp:last-location`, through the guarded helper `App.tsx` already has: the last folder a person **successfully created into**, used only as the dialog's `startAt`. It is never filled into the field. The default is the default every time. A stored value that is not a string, or is longer than 1024, is ignored. |
| Not in scope, each a backlog row if 19a did not already write it | "Show in folder" on the row. A default location in Settings. Drag a folder onto the form. Moving an existing workspace from the page. A folder browser drawn in the page — it would need a route that lists a person's directories, and the system already has a dialog. |

## The form

In `AppsTable.tsx`, one group after the description, a `<fieldset>` with the
legend **Where it lives**:

- At rest: the words `In the launcher’s own folder` and a secondary button
  `Choose a folder…`. No path is shown for the default — it is long, it is not
  the person's business, and it makes the default look like a choice that
  needs checking. Below, muted:
  `Choose a folder to keep the project beside your others. A folder for it is made inside the one you pick.`
- Pressing the button calls `launcher.folderChoose` with the remembered
  `startAt`. While it is pending the button is disabled and, beside it in an
  `aria-live="polite"` region:
  `A folder window is open. It may be behind this one.` A person staring at a
  dead button presses it again; this is why. Create stays enabled — the
  default is still a valid answer — and pressing it while the dialog is open
  creates at whatever the field holds now.
- `chosen: null`: the status clears, nothing else changes, focus returns to
  the button.
- `available: false`: the button is replaced, for the life of this form, by a
  text field labelled `Folder` with the hint
  `The full path of a folder that exists, for example /Users/you/Projects`
  (`C:\Users\you\Projects` when `navigator.platform` says Windows). The same
  field is reachable when the dialog works, behind a `Type a path instead`
  link — somebody will want to paste. Pasted text is trimmed; surrounding
  quotes, which Finder's and Explorer's "copy as path" add, are removed.
- A `conflict` from `folderChoose` shows its sentence in the status region and
  re-enables the button.
- With a folder chosen or typed: `It will be made at` and the target in
  `<code>`, from `launcher.locationCheck`'s `target` — not joined in the page,
  so `~` and `..` show as what they resolve to — and a `Use the default`
  button that clears it and returns focus to `Choose a folder…`. The path
  wraps (`overflow-wrap: anywhere`) and is never truncated: the end is the part
  that differs. While the id is not yet a legal one, the line reads
  `It will be made inside {location}, in a folder named after its id.`
- The live check: `launcher.locationCheck`, called when a folder is chosen
  and, debounced 300 ms, as a typed path or the id changes, only once the id
  is legal. A generation counter discards an answer that arrives after a newer
  request. Its `problem` is shown **under this field**, tied to the field with
  `aria-describedby`, in a `role="alert"` element that exists only while there
  is a problem. It **never disables Create**: the host checks again, and a
  check that raced or failed to load must not strand a form. A check that
  itself fails (the route threw, the connection dropped) shows nothing.
- A refusal from `launcher.appCreate` that is about the location is shown
  under this field as well as wherever the form shows errors today, and
  **every field keeps what was typed**, the chosen folder included. Focus moves
  to the field. A `PublicError` is a code and a sentence and nothing else
  (`packages/broapp/src/shared/errors.ts`), core is not changed for this, and a
  sentence is not a discriminant (18c). So: when `appCreate` is refused with
  `invalid_input` or `conflict` and a location was sent, the form calls
  `launcher.locationCheck` once more. A `problem` back means the refusal was
  the location's and that problem is what is shown under the field; `ok` means
  it was about something else and it is shown as today.
- A creation that returns `ok: false` with problems (the build failed, the
  disk filled) is shown as today. The workspace exists by then; the first note,
  `the workspace is at …`, is shown with the problems so the person knows where
  to look.
- Success: today's line, and when a location was chosen, the first note. Then
  the form resets as today, the location with it, and the remembered
  `startAt` is written.
- Create while a creation is already running: as today. Read what today is and
  say; if the form can be submitted twice, that is a finding to fix here,
  because the second one now fails with *target exists* instead of *id exists*
  and reads like the person's mistake.
- Keyboard: every control reachable in order — legend, button, link, field,
  `Use the default`, Create. Enter in the typed field submits the form like
  Enter in any other field. Nothing here needs a pointer.
- Narrow widths: the group stacks; the button goes full width where the
  form's other buttons do.

## The row

From `appSummary.workspace`:

- `chosen: false`: the row is exactly as today. No path, no label.
- `chosen: true`, `present`: under the name, muted, the `dir`, wrapping as
  above, with `title` holding the same text.
- Any other state: in that place, in the warning style the table already has
  — words, not colour alone, no icon alone — the sentence for that state from
  `location-words`, and a secondary button `Locate…`.
- `Locate…` opens the dialog with `startAt` the missing path's nearest
  existing ancestor (the host works that out: `folderChoose` drops a `startAt`
  that is not there, so send the parent and let it fall back). The answer goes
  to `launcher.appLocate`. Its refusal is shown on the row, `role="alert"`;
  the row stays as it was. Its success refreshes the list. With
  `available: false`, `Locate…` opens a one-field inline form on the row —
  the same typed field, a `Set` button and `Cancel` — not a browser `prompt()`.
- **Open stays enabled** in every state, and works.
- Whatever starts a build or an engineer turn for that application is not
  disabled either: a disabled button explains nothing, and the host's sentence
  does. Read what the engineer panel and the Backlog panel show when 19a's
  guard refuses a turn or a task, and make sure the sentence is what the person
  reads — whole, not a generic failure line with the sentence in a log.
- The list already refreshes on some events. Read which. A folder that comes
  back must show as `present` without a restart: if nothing refreshes the list
  while the page sits open, refresh it when the window regains focus
  (`visibilitychange`/`focus`, no timer) and say so.

## Removal

- The confirmation, for `chosen: true`, says before the person types the id:
  `Its workspace at {dir} will be left where it is.` For a state that is not
  `present`: `Its workspace at {dir} cannot be found; nothing there will be
  touched.` For `chosen: false` it is word for word as today.
- The after-removal line (~327) gains 19a's *Removal, left* or *Removal, was
  missing* sentence when the receipt has `workspaceLeftAt`.

## Verification

```bash
bun run typecheck
bun test tests/autoapp-create.test.ts tests/autoapp-remove.test.ts
bun test tests/autoapp-views.test.ts tests/autoapp-panel-link.test.ts
bun test tests
bun run --cwd packages/broapp-autoapp build:launcher
bun run scripts/autoapp-smoke.ts
bun run theme-check
bun run check
```

New tests. None opens a window.

The route:

1. `launcher.folderChoose` with the chooser replaced: a path comes back
   trimmed of its newline and trailing separator; `/` stays `/`; cancel is
   `chosen: null`; a chooser reporting no program is `available: false`; a
   chooser exiting non-zero for another reason is `available: false` and logs.
2. A second call while the first is pending is `conflict`; after the first
   answers, a third call works.
3. A chooser that never answers is killed at the injected deadline and the
   route answers `chosen: null`; the kill was called once. Stopping the
   launcher while one is open kills it.
4. The argument builder, for `darwin`, `win32` and `linux` with `zenity` and
   with `kdialog`: given a `startAt` of `"; rm -rf ~ #`, of `$(id)`, of
   `` `id` ``, of `' & calc & '` and of a path with a newline, the value
   appears **only as one whole argv element or one environment value**, and
   the script text is byte-identical to the script built for `/tmp`.
5. A `startAt` that does not exist is dropped; one that is a file is dropped.
6. On channel `ai` the route is asked about, not run.

The form (the view tests' way, no browser):

7. Untouched, the form renders no path and posts exactly today's input — no
   `location` key at all, not `undefined`, not `''`.
8. Choose: the button disables, the status line shows, the target line
   appears from `locationCheck`'s `target`, and it follows the id as it is
   typed. `Use the default` clears it and the post has no `location`.
9. Cancel changes nothing and shows nothing. `available: false` swaps the
   button for the field, and stays swapped. `Type a path instead` shows the
   field while the dialog is available. `"/a b/c"` with quotes and spaces
   around it posts `/a b/c`.
10. A `locationCheck` problem renders under the field with `role="alert"` and
    `aria-describedby`; Create is still enabled. Two checks answered out of
    order: the older is dropped. A check that throws renders nothing.
11. `appCreate` refused and the follow-up `locationCheck` returns a problem:
    that problem is under the field, and name, id, description, template and
    location all keep their values. Refused because the id exists
    (`locationCheck` answers `ok`): the sentence is **not** under the location
    field. Refused with no location sent: no `locationCheck` call is made.
12. `ok: false` with problems after a location: the problems and the
    `the workspace is at …` note are both shown.
13. Success writes `last-location`; the next dialog is opened with it as
    `startAt`; the field is still empty. `localStorage` throwing on read and
    on write breaks nothing. A stored number is ignored.
14. With an illegal id and a chosen folder: the *named after its id* line, and
    no `locationCheck` call was made.

The row and removal:

15. `chosen: false` renders identically to before this prompt (snapshot or
    markup equality against the old row).
16. `present`: the path, muted. Each of `missing`, `not-a-directory`, `denied`,
    `unreadable`: its sentence from `location-words`, a `Locate…` button, and
    Open enabled.
17. `Locate…`: the chooser's answer is posted to `launcher.appLocate`; success
    refreshes the list; a refusal shows on the row; with `available: false`
    the inline field appears and `Cancel` removes it.
18. The list refreshes when the window regains focus, if that is what you
    added.
19. The confirmation and the after-removal line for a chosen, a missing and a
    default workspace — the last unchanged word for word.
20. No sentence from *The words* is written out in `AppsTable.tsx`: they are
    imported. (A grep in the test, as 18c did for `only the first`.)

By hand, on a copy of the root, both colour schemes, at a wide and a narrow
width, screenshots in `reports/19b/`:

- macOS: `Choose a folder…`. Record whether the window came to the front and
  what the form said while it was open. Cancel it. Choose a folder with a
  space in its name; record the target line; change the id and watch it
  follow; Create.
- Choose `~/Desktop` on a machine where the launcher has not been given it.
  Record what the system asked, and — if refused — where the sentence
  appeared and that the form kept everything.
- Choose a folder, then make `<folder>/<id>` by hand before pressing Create.
  Record the live check's line, and what Create says.
- Press `Choose a folder…`, leave the window open, press Create. Record what
  happened.
- With the application serving, rename its folder in Finder, switch back to
  the launcher. Record the row, that Open works, and what the engineer panel
  says when asked for a change. Rename it back, switch away and back; record
  the row.
- Rename it away, `Locate…` the right folder; then the wrong one.
- Remove it; screenshot the confirmation and the after-removal line.
- The whole form with the keyboard only, and once with VoiceOver: record what
  is announced when the dialog opens, when a problem appears and when it
  clears.
- Linux or Windows, if one is to hand: the dialog. If not, say so — do not
  claim it. In either case run the launcher with `PATH` stripped of
  `osascript`/`zenity` and record the typed-path form.

## Acceptance criteria

- The form, left alone, posts what it posted before and looks the same apart
  from one quiet group.
- A person can choose a folder with the system's dialog, or type or paste one
  where there is no dialog, and reads where the project will be made before
  pressing Create.
- Every location refusal appears beside the field, in 19a's words, with the
  form as typed.
- Nothing about the dialog can strand the form: cancel, no program, a window
  left open, a second press, the launcher stopping.
- No path reaches a shell as text, and a test reads the argv to hold it.
- A workspace that has gone is said on its row, in words; the application
  still opens; `Locate…` repoints it; a folder that came back shows as back
  without a restart.
- A person removing an application is told, before they confirm, that their
  folder stays.
- Everything is reachable by keyboard and announced; nothing is colour alone.
- `bun run check` and `theme-check` green. `location.ts`, `create.ts`,
  `layout.ts` and everything under `packages/broapp` untouched.

## Docs

`docs/autoapp/security.md`: the dialog — what it is given, how, and why a
returned path is checked like a typed one. `docs/troubleshooting.md`: add
`Locate…` to 19a's entry; a new entry, "The folder window did not appear"
(behind the browser; no `zenity`; a remote session) with the typed path as the
answer. `packages/broapp-autoapp/README.md`: one line and one screenshot's
worth of words under creating an application. `docs/autoapp/backlog.md`: the
rows from *Not in scope* that 19a did not write.

## Report

`prompts/autoapp/reports/19b-choosing-the-folder-in-the-form.md`: whether the
macOS window came to the front and what you did about it; which platforms'
dialogs were run and which only unit-tested; that the form tells a location
refusal from an id refusal by asking `locationCheck` again, and any case where
that gave the wrong answer; whether the
form could be submitted twice; what refreshes the list and what you added;
what the engineer and Backlog panels show for a refused turn; the VoiceOver
notes; and anything in *Fixed decisions* you found wrong, with what you did
instead and why — do not quietly differ.

## Commit

```
Choose where an application lives from the form

Creation could put a workspace in a folder of the person's choosing,
but only from the command line. The form now has the field: a button
opens the system's folder dialog, a typed path stands in where there is
none, and the form says where the project will be made before Create is
pressed. A refusal appears beside the field with everything as typed.
The dialog is given its starting folder as an argument and never as
script text, and what it returns is checked like any typed path. A
workspace that has gone is said on its row, which still opens and has a
Locate button, and the removal confirmation says the folder will be
left where it is. Left alone, the form posts what it always did.
```

End the commit with the co-author trailer your session's rules give you.
