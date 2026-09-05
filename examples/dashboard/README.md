# Live Dashboard

Streams aggregate system metrics — processor, memory, load — over one
Brobridge connection, as three independent streams.

```bash
bun install
bun run dev
bun run build && ./release/dashboard
```

## What it demonstrates

**Independent streams over one connection.** Each card owns its own
subscription. Pausing the processor stream does not touch memory or load: they
have separate stream ids, separate flow-control credit, and separate resume
cursors. That is what multiplexing buys, and it is easier to see with three
streams than with one.

**Honest handling of missing metrics.** `os.loadavg()` returns `[0, 0, 0]` on
Windows. That is a stub, not a reading of zero. The host sends `null` and the
interface says "not available on this platform" rather than drawing a flat line
that looks like data.

**Reconnect.** Kill the host and restart it, or suspend the machine. Each
stream resumes from its own cursor if the reconnect lands inside the host's
session retention window, and the badge says plainly when it no longer can.

## What it reads

Aggregate counters from `node:os` only: core times, byte totals, load averages.
No process list, no command lines, no environment, no filesystem.

## Where to look

- `src/shared/contract.ts` — the three streams and their event shapes.
- `src/host/operations.ts` — sampling, and the cancellation-aware sleep.
- `src/ui/MetricCard.tsx` — one card, one subscription, its own start and stop.
