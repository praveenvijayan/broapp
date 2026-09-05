# Streaming and cancellation

## The thing to get right

**Abandoning an async iterator does not cancel the stream underneath it.**

```ts
// This does NOT stop the host.
for await (const event of stream) {
  if (enough(event)) break;   // the host keeps producing, forever
}
```

Breaking out of the loop stops *you* reading. It sends nothing. The host's
handler carries on computing, and on a user's own machine that means a core
stays pegged until the process exits.

Cancellation has to be explicit:

```ts
const subscription = await client.subscribe('demo.countPrimes', { upTo: 60_000_000 }, {
  onEvent: (event) => setProgress(event.progress),
});

subscription.cancel();   // sends CANCEL; the host stops
```

`useStream` does this for you, including on unmount — which matters more here
than in a web application, because the producer is a process on the user's
machine.

## Writing a stream handler

```ts
app.stream('demo.countPrimes', async ({ upTo }, sink) => {
  let found = 0;

  for (let n = 2; n <= upTo; n += 1) {
    if (isPrime(n)) found += 1;

    if (n % 100_000 === 0) {
      if (sink.signal.aborted) return;                  // 1
      await sink.emit({ examined: n, found, progress: n / upTo, done: false });  // 2
    }
  }

  await sink.emit({ examined: upTo, found, progress: 1, done: true });
});
```

**1 — check the signal.** `sink.signal` is an `AbortSignal`, aborted when the
browser cancels, when its tab disconnects, or when the host shuts down. Nothing
preempts a tight loop, so a handler that never looks at the signal cannot be
cancelled however correct the rest of the plumbing is. Check it at a natural
checkpoint, often enough that a user does not notice the delay.

**2 — await `emit`.** It resolves when Brobridge's flow control has room, so a
browser that reads slowly slows the producer instead of filling a buffer. It
also yields the event loop, without which the loop above would starve the very
socket it is reporting on.

Returning ends the stream cleanly. Throwing ends it with an error — a
`PublicError` keeps its message, anything else becomes a fixed sentence.

## Cancellation, end to end

```
browser: subscription.cancel()
      → BridgeStream.cancel()          @brobridgejs/core
      → CANCEL frame                   over the WebSocket
host: stream fails with CANCELLED
      → stream.closed rejects
      → Broapp aborts the AbortController
      → sink.signal.aborted === true
      → your handler returns at its next checkpoint
```

`stream.closed` rejecting is the *only* reliable signal. A browser that merely
stops iterating sends nothing at all, which is why Broapp wires the signal from
`closed` rather than from anything about reading.

## Cleanup

Use `finally`, or listen on the signal — both run for a normal end, an error,
and a cancellation:

```ts
app.stream('files.watch', async ({ path }, sink) => {
  const watcher = openWatcher(path);
  try {
    for await (const change of watcher) {
      if (sink.signal.aborted) return;
      await sink.emit(change);
    }
  } finally {
    watcher.close();     // runs on completion, failure and cancellation alike
  }
});
```

Broapp aborts the controller in a `finally` of its own, so a handler that
returns normally also releases anything hanging off the signal.

## Framing

Brobridge streams carry **bytes**. Chunk boundaries are not message boundaries:
one chunk may hold two events, or half of one. Broapp frames events as
newline-delimited JSON and reassembles them, so `onEvent` is always called with
one complete event.

If you need raw bytes — a file transfer, a terminal — use
`client.bridge.openStream()` directly and skip the framing. `client.bridge` is
the underlying Brobridge client, there for exactly this.

The reassembly buffer is bounded at 4 MB. A producer that sends four megabytes
without a newline is a fault, not a slow event.

## What happens when the connection drops

**A live stream resumes.** Brobridge replays from the consumer's cursor, so
events are delivered exactly once and a gap surfaces as a `SnapshotRequiredError`
rather than as silently missing data. Your handler is not restarted and does not
notice.

**Unless the host process died.** A session lives in the host's memory. If the
process exited, the session is gone, and no reconnect can restore it — the tab
must bootstrap again with a fresh launch URL. `ConnectionStatus` reports
`reconnecting` with `resumable: false` once the host's session retention window
(`sessionTtlMs`, 60 seconds by default) has passed, which is the honest point at
which an interface should stop implying that work in progress is coming back.

**A call in flight when the socket drops rejects.** It is not retried: the host
may have run it, and retrying a mutation is not the transport's decision. A call
made *while* the connection is down waits for it to come back.

**There is no exactly-once execution across reconnects.** Broapp does not
promise it and neither does Brobridge. If an operation must not run twice, make
it idempotent.

## Multiple streams

Streams are multiplexed over one connection with per-stream credit. Opening
several is normal, cancelling one does not disturb the others, and a slow
consumer on one stalls only that one. The
[dashboard example](../examples/dashboard/README.md) runs three at once and has
a test for the independence.
