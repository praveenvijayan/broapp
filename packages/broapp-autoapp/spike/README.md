# Spike: compiled supervision

What the launcher in prompt 05 depends on, proved with compiled binaries
rather than with `bun run`. Under the interpreter every one of these would
pass for the wrong reason — there is a Bun on the path, the bundler can see
the artifact, and a stuck child is somebody else's problem.

## What it proves

1. A compiled launcher spawns a compiled child of *itself*, via
   `process.execPath`, over `Bun.spawn`'s IPC with `serialization: 'json'`.
2. The child runs with `PATH=/nonexistent`. Nothing in the chain falls back to
   a `bun` on the path.
3. The child `await import()`s an application artifact by absolute path that no
   static import reaches, and the artifact runs *in the child*: it appends to
   `$BROAPP_DATA_DIR/spike.log`, which the launcher never writes.
4. All six lifecycle messages round-trip — `hello`, `ready`, `health`, `drain`,
   `shutdown`, `fatal` — each with a deadline. The launcher cannot hang.
5. A child that ignores `shutdown` is killed, and the launcher still reports.
6. A `hello` that never arrives is caught by its deadline and the child does not
   outlive the launcher.
7. A message carrying a protocol version this build does not understand is
   refused, and the child exits 3.

## Running it

```bash
cd packages/broapp-autoapp
bun build --compile --bytecode --minify spike/launcher.ts --outfile spike/dist/launcher

BROAPP_DATA_DIR=$(mktemp -d) spike/dist/launcher \
  "$PWD/spike/app-v1/index.ts" app-1 rel-1
```

It prints one JSON line and exits 0, or prints `{"error": …}` and exits 1.
`tests/autoapp-spike.test.ts` at the repository root does the same thing and
asserts on it.

## Deliberate misbehaviour

`AUTOAPP_SPIKE_MISBEHAVE` makes the child do the wrong thing on purpose, so the
launcher's deadlines can be tested rather than assumed:

| Value | What the child does |
|---|---|
| `ignore-shutdown` | Never exits when told to. The launcher kills it. |
| `no-hello` | Never announces itself. The launcher times out and kills it. |
| `bad-version` | Sends `hello` with `v: 2`. The launcher refuses the channel. |

## Two things a caller has to know

**`app-v1/index.ts` must never appear in an `import` statement.** If it does,
the bundler inlines it and the spike passes while proving nothing. It is loaded
by absolute path, at runtime, and depends only on `node:` builtins.

**A parent that pipes the launcher's stderr must drain it.** The launcher gives
its child `stderr: 'inherit'`, so a child that outlives the launcher keeps that
descriptor open, and `Subprocess.exited` in the parent will not settle until it
closes. This cost fifteen minutes per test run before it was found.
