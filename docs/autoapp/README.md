# Autoapp

Autoapp is an optional launcher for Broapp applications. It runs each
application as its own child process in its own tab; an AI engineer in the
launcher's own tab proposes changes as candidate releases; the execution gate
stops every change that is not the owner's own click and asks first; and the
whole of it ships as one compiled binary per target, with a starter
application inside.

![Architecture showing a browser with a launcher tab and an application tab, a launcher process holding the AI engineer, the execution gate, the knowledge store and the candidate builder, a model provider reached by the engineer, and per-application disk state and a child process that serves the application tab.](../../diagrams/autoapp-architecture.svg)

## Try it

Download the launcher for your machine and run it; no Bun installation is
needed. The launcher opens its tab, and **New application** writes the starter,
builds its first release and opens it.

```bash
curl -fsSL https://github.com/praveenvijayan/broapp/releases/latest/download/broapp-autoapp-darwin-arm64.tar.gz | tar xz
./broapp-autoapp-darwin-arm64
```

For a fuller start, the release's `notes-starter.zip` is the Notes example with
its AI panel:

```bash
unzip notes-starter.zip
./broapp-autoapp-darwin-arm64 import ./notes-starter --as notes --grant
./broapp-autoapp-darwin-arm64 serve notes
```

The binaries are unsigned; the other targets, and what macOS and Windows say
about an unsigned binary, are in [Packaging and offline](packaging.md).

## Read next

1. [Design](design.md) — the seven parts, the gate, and how a candidate release becomes the current one.
2. [What the launcher remembers](learning.md) — the record of what the engineer did, and the lessons a resolved case can leave behind.
3. [Approvals and limits](security.md) — which calls stop and ask, and how an answer is bound to its question.
4. [Packaging and offline](packaging.md) — the artifacts, where they have been run, and which offline claims have evidence.
5. [Phase 2 backlog](backlog.md) — what phase 1 left out, and what would make each item worth doing.

Autoapp is not containment: a candidate release is trusted local code, crash
isolated but not permission isolated. See [Scope and limitations](../limitations.md).
