# 04c — A pasted image is on the turn it was pasted for

## What was built

One mechanism in `prompt-input.tsx`, applied to both `add` paths:

- **The chip goes up first.** `add` creates entries synchronously with
  `url: ''` and `pending: true` (`entriesFor`, `withIds`), runs the accept /
  size / `maxFiles` checks on the synchronous list, then starts the reads
  (`startReads`). A read patches its entry's `url` and clears `pending`; one
  that fails removes its entry and says so.
- **The list is a ref, the state is a picture of it.** Every change goes
  through `commit` / `commitLocal`, which writes `entriesRef` / `itemsRef` and
  then `setState`. A read resolves outside React's scheduling, so a submit that
  awaits it and then reads *state* still sees `pending: true` and drops the
  image — the same bug in a second form.
- **Submit waits.** `handleSubmit` calls
  `settleForSubmit(attachmentsCtx.currentFiles, attachmentsCtx.pendingReads)`
  — new file `src/ui/components/ai-elements/pending-files.ts` — and hands
  `onSubmit` the complete entries only.
- **The button tells the truth.** `PromptInputSubmit` is disabled while any
  entry is pending — never while a turn runs, where it is Stop — and the Enter
  handler already honours that. The pending chip is dimmed with `opacity-50`
  on `Attachment`, a class the vendored component takes.
- **Remove works while pending**: it deletes the entry's promise from the map
  first, so a submit does not wait on a file the person took back.

`AttachmentsContext` gained `pendingReads` and `currentFiles()`, and `add` an
optional error sink, so the panel's `onError` hears a failed read on the
provider path too. Four `settleForSubmit` cases in
`tests/ai-elements-images.test.ts`. `revokeObjectURL` on a data URL is kept: a
no-op, and nothing here knows what an upstream caller stored.

## Which `add` path the manual run proved

**The local one.** `BroappChatView` renders `PromptInput` with no
`PromptInputProvider` above it, so `usingProvider` is false and `addLocal` /
`removeLocal` / `itemsRef` are what ran. The provider path is the same shape,
covered by the helper test and the typechecker only; nothing in this
repository mounts `PromptInputProvider`.

## The manual run

Compiled `examples/notes/release/notes --no-open`, `BROAPP_DATA_DIR` under
`/tmp`, Ollama at `127.0.0.1:11434`, `gemma4:31b-mlx`. Pastes were dispatched
as `ClipboardEvent`s carrying a real `File` and Enter as a `keydown` on the
textarea — the handlers a hand reaches, at a speed it cannot.

| # | Outcome |
|---|---|
| A | ✅ 4000×3000 PNG (277 KB) pasted and Enter dispatched **in the same tick**: the turn carried the image and the model answered "Yellow, purple." — the colours drawn in it, 778 tokens in. A second paste measured the chip up and Send disabled at t≈6 ms, Send live again at t<890 ms |
| B | ✅ paste, chip removed, Enter in the same tick: "TEXT ONLY.", 535 tokens in, no third image in the transcript. Again with a 1.3 MB image: "STILL TEXT ONLY.", 556 tokens in |
| C | ✅ two images pasted back to back, Enter in the same tick: "first=green, second=black" — both stripe colours, images in the transcript 2 → 4, 1148 tokens in |
| D | ✅ row 8: chip `row8.png` with a 640×480 thumbnail from a `data:` URL above the box. Row 9: "A red circle is centered on a white background with a blue horizontal stripe at the bottom." |

## Decisions I made

- **`settleForSubmit` uses `allSettled`.** A failed read has already removed
  its chip and said so; it must not take the turn with it. Reads started while
  it waits belong to a later turn.
- **`tests/ai-elements-source.test.ts` names `pending-files.ts` as ours.** The
  provenance rule covers `src/ui/components/**`, and this file has no upstream
  to diff against. One named exemption, with the reason.
- **A failed read keeps `code: 'accept'`** but carries its own sentence, and
  the view shows that sentence: "Only PNG, JPEG, GIF and WebP images." would be
  a lie about a PNG that could not be read.
- **`PromptInputSubmit` reads the optional contexts**, so it does not start
  throwing outside a `PromptInput`.

## Commands run

`bun run typecheck` (exit 0); `bun test` on the images, source and view files
(33 pass, 0 fail); `bun run check` (535 pass, 0 fail, 36 files);
`examples/notes` `bun run build` (72.4 MiB); `bun run build:css` (unchanged).

## Open questions

- **The pending window is single-digit milliseconds here.** A 1.3 MB read
  finished inside the first `setTimeout(…, 1)` after the paste, so a scripted
  "remove while pending" mostly lands after the read, and the dimmed chip was
  inferred from the disabled Send at t≈6 ms rather than photographed. That
  decision is covered by the helper test.
