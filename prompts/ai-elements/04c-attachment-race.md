# 04c — A pasted image must be on the turn it was pasted for

## Why

Report 04b found: paste an image, press Enter before `FileReader` has
finished, and the turn goes out with no `files`. The chip stays on screen,
the model answers about an image it never received. Cause, in the vendored
`packages/broapp-ai-elements/src/ui/components/ai-elements/prompt-input.tsx`:
LOCAL edit 4 (prompt 04, bug A) made `add` asynchronous — it reads every
file to a data URL **and only then** calls `setAttachmentFiles` /
`setItems` — while `handleSubmit` reads `files` from React state. Between
the paste and the state update there is nothing to submit.

Upstream did not have this race only because `URL.createObjectURL` is
synchronous; the CSP forced the switch to `FileReader`, so the fix is ours.

## Read first

- `prompts/ai-elements/00-common-rules.md`, reports 01–04b.
- `prompt-input.tsx`: `readAsDataUrl` (~line 90), the context `add`
  (~286), `addLocal` (~601), `addWithProviderValidation` (~667),
  `handleSubmit` (~869), the Enter handler that calls `requestSubmit`
  (~1005), `PromptInputSubmit` (~1241). Read the whole file once; there
  are two providers (the context one and the local one) and both paths
  must be fixed the same way.
- `src/ui/BroappChatView.tsx` — how `onSubmit` receives `{ text, files }`.

## The fix

One mechanism, applied to both `add` paths:

1. **Insert the chip synchronously.** On `add`, create the entries at once
   with `url: ''` and a new field `pending: true`, run the accept / size /
   `maxFiles` checks on the synchronous list exactly as today, and call
   the state setter **before** any read starts. The chip appears the
   moment the paste happens, which is also what a person expects.
2. **Track the reads.** Keep `pendingReads = useRef(new Map<string, Promise<string>>())`
   keyed by entry id. Each read, on resolution, patches that entry's `url`
   and clears `pending`, then deletes itself from the map. On rejection
   it removes the entry and reports `onError?.({ code: 'accept', message: 'That file could not be read.' })`.
3. **Submit waits.** `handleSubmit` first does
   `await Promise.all([...pendingReads.current.values()])`, then reads the
   entries from a ref mirror of the state (`itemsRef.current`, updated in
   an effect or in the setter's callback) rather than from the `files`
   closure, which is stale after the `await`. Only entries with a
   non-empty `url` and `pending !== true` are handed to `onSubmit`. If the
   text is empty and no entry is complete, do nothing.
4. **The button tells the truth.** `PromptInputSubmit` is disabled while
   any entry is `pending`, and the Enter handler already respects a
   disabled submit button. Show the pending chip with a spinner or reduced
   opacity via `Attachment` — pick whichever the vendored `attachments`
   component already supports; do not add a component.
5. **Remove still works** while pending: deleting a pending entry deletes
   its promise from the map too, so submit does not wait on a file the
   person removed.

Wrap every change in `// LOCAL: 04c …` / `// END LOCAL`. Update the
existing LOCAL 4 comment to point here. `remove`'s
`URL.revokeObjectURL(found.url)` on a data URL is a no-op; leave it or
guard it, your call, but say which in the report.

## Tests

The race cannot run under `bun test` (no `FileReader`), so extract the
decision into a pure helper in a new file
`src/ui/components/ai-elements/pending-files.ts`:

```ts
export interface PendingEntry { readonly id: string; readonly url: string; readonly pending?: boolean }
/** Wait for every read still running, then return the entries that are complete. */
export async function settleForSubmit<T extends PendingEntry>(
  entries: () => readonly T[],
  pending: ReadonlyMap<string, Promise<unknown>>,
): Promise<T[]>;
```

`prompt-input.tsx` calls it from `handleSubmit`. `tests/ai-elements-images.test.ts`
gains cases: two entries, one pending whose promise resolves and the
`entries()` function then returns it complete → both returned; a pending
promise that rejects → the other entry returned, no throw; an entry
removed while pending (absent from `entries()` after settle) → not
returned; nothing pending → returns immediately with the complete ones
only.

`tests/ai-elements-source.test.ts` still passes (provenance headers, no
aliases).

## Manual run

Compiled notes binary, Ollama, a vision model from report 04b. Rows:

| # | Step | Expected |
|---|---|---|
| A | Paste a large (4000×3000) screenshot and press Enter within a second | The chip appears at once; Send stays disabled until the read finishes; the turn then goes out **with** the image and the model describes it |
| B | Paste, then remove the chip before the read finishes, then send text | Text-only turn, no placeholder, model answers the text |
| C | Paste two images quickly, send | Both reach the model (host log or the model's answer names two) |
| D | Row 8 and 9 of prompt 04 again | Unchanged |

## Verify

```bash
bun run typecheck
bun test tests/ai-elements-images.test.ts tests/ai-elements-source.test.ts tests/ai-elements-view.test.tsx
bun run check
cd examples/notes && bun run build && cd ../..
```

## Report

`prompts/ai-elements/reports/04c-attachment-race.md`: the four manual
rows with outcomes, and which of the two `add` paths the notes example
actually exercises (the provider or the local one), so a reader knows
which path the manual run proved and which only the helper test covers.

Commit:

```
Hold a send until every pasted image has been read, and show the chip at once
```
