# Streams and cancellation

Use a stream for anything long, progressive, or cancellable: a scan with
progress, a watcher, metrics sampled on a timer, an export that takes seconds.

## The one thing to get right

**Abandoning an async iterator does not cancel the stream underneath it.**
Breaking out of a `for await` loop stops you reading and sends nothing. The
host keeps computing on the user's own machine.

Cancellation is explicit. In React, `useStream` sends it for you, including
on unmount. With the raw client:

```ts
const subscription = await client.subscribe('files.scan', { root: 'inbox' }, {
  onEvent: (event) => setProgress(event.progress),
});
subscription.cancel();   // sends CANCEL; the host stops
```

## Writing a handler

```ts
app.stream('files.scan', async ({ root }, sink) => {
  const files = await listUnder(root);
  let done = 0;
  try {
    for (const file of files) {
      if (sink.signal.aborted) return;                          // 1
      await processOne(file);
      done += 1;
      await sink.emit({ done, total: files.length, finished: false });  // 2
    }
    await sink.emit({ done, total: files.length, finished: true });
  } finally {
    releaseAnything();                                          // 3
  }
});
```

1. **Check the signal.** `sink.signal` is an `AbortSignal`, aborted when the
   browser cancels, when its tab disconnects, or when the host shuts down.
   Nothing preempts a loop, so a handler that never looks at the signal
   cannot be cancelled. Check at a natural checkpoint, often enough that a
   user does not notice the delay. In a CPU-bound loop, every N iterations.
2. **Await `emit`.** It resolves when Brobridge's flow control has room, so a
   slow browser slows the producer instead of filling a buffer. Awaiting it
   also yields the event loop, without which a tight loop starves the socket
   it is reporting on. `emit` rejects once the stream has ended.
3. **Clean up in `finally`.** It runs on completion, failure and cancel.

Returning ends the stream cleanly. Throwing ends it with an error: a
`PublicError` keeps its message, anything else becomes a fixed sentence.

`sink.sessionId` is the authenticated session this stream belongs to, for
an application that needs to know which tab is asking.

A cancellation-aware sleep, for polling streams:

```ts
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

## Cancellation end to end

```
browser  subscription.cancel()
         CANCEL frame over the WebSocket
host     stream.closed rejects with CANCELLED
         Broapp aborts the AbortController
         sink.signal.aborted === true
         your handler returns at its next checkpoint
```

## Framing

Brobridge streams carry bytes. Broapp frames events as newline-delimited
JSON and reassembles them, so `onEvent` always gets one complete event. The
reassembly buffer is 4 MB; an event larger than that is a fault. For raw
bytes (a file transfer, a terminal) use `client.bridge.openStream()` directly.

## The React hook

```tsx
const scan = useStream<AppContract, 'files.scan'>('files.scan');

scan.start({ root: 'inbox' });   // cancels any run this hook already had
scan.cancel();
scan.last        // latest event or null
scan.running     // boolean
scan.cancelled   // previous run ended by cancel()
scan.error       // BroappError | null
```

Show a Cancel button while `running`, a Start button otherwise, a
`<progress>` bound to `last`, and a `role="status"` line describing the
state. The subscription is cancelled on unmount.

## What happens on disconnect

- **A live stream resumes** if the socket comes back inside the host's
  session retention window (`sessionTtlMs`, 60 s default). Brobridge replays
  from the consumer's cursor. The handler does not notice.
- **Unless the host process died.** Sessions live in host memory. After a
  restart no reconnect can restore one; the tab needs a fresh launch URL.
  `useConnection()` reports `reconnecting` with `resumable: false` past the
  window. Say so in the UI; do not imply work is coming back.
- **A call in flight when the socket drops rejects** and is not retried.
  The host may have run it. A call made while disconnected waits.
- **No exactly-once across reconnects.** Make mutations idempotent if it
  matters.

## Multiple streams

Streams are multiplexed over one connection with per-stream credit. Opening
several is normal, cancelling one leaves the others alone, and a slow
consumer stalls only its own stream. Give each card its own `useStream`.
