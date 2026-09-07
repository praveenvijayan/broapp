/**
 * When a send may go out, and with which attachments.
 *
 * Reading a pasted file into a `data:` URL is asynchronous — a Broapp page's
 * policy forbids the `blob:` URL upstream uses — so between the paste and the
 * bytes there is a moment where an attachment exists but has no content. A
 * send in that moment used to leave the image behind. The decision is here,
 * away from React, so it can be tested where `FileReader` does not exist.
 */

/** An attachment as `PromptInput` holds it while its read is still running. */
export interface PendingEntry {
  readonly id: string;
  readonly url: string;
  readonly pending?: boolean;
}

/**
 * Wait for every read still running, then return the entries that are complete.
 *
 * `entries` is a function rather than a list because the list changes while
 * this waits: a read finishing patches its entry, a failed one takes its entry
 * away, and a person may remove one by hand. Only what is there afterwards
 * counts.
 *
 * A read that rejects has already reported itself and removed its own entry,
 * so it must not take the rest of the turn with it — hence `allSettled`.
 * Reads started *while* this waits belong to a later turn and are not awaited.
 */
export async function settleForSubmit<T extends PendingEntry>(
  entries: () => readonly T[],
  pending: ReadonlyMap<string, Promise<unknown>>,
): Promise<T[]> {
  await Promise.allSettled([...pending.values()]);
  return entries().filter((entry) => entry.pending !== true && entry.url !== '');
}
