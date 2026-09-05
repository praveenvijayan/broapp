# How this compares

Three honest comparisons. No benchmarks are quoted, because the ones that
circulate for this class of tool are mostly measuring startup on an empty
application.

## Against a plain local HTTP application

The common shape: `Bun.serve()` on port 3000, tell the user to open
`localhost:3000`.

**What you gain by using Brobridge instead.** A plain local server has no
authentication, so anything on the machine that can make an HTTP request can
call it — including a web page in the user's browser, which is the part people
usually miss. DNS rebinding turns `localhost:3000` into an origin an attacker's
page can reach unless you check `Host` and `Origin`, and most local servers do
not. Brobridge checks both, requires a one-time token to bootstrap, and issues a
session cookie.

You also get streaming with flow control, resume across a dropped socket, and a
closed route table rather than a static file server.

**What it costs.** More moving parts, and a bootstrap flow — the URL carries a
token, and a user who bookmarks it will find the bookmark stops working.

**When the plain server is the right answer.** A development tool you run for
thirty seconds, on a machine where you are the only user, exposing nothing
sensitive.

## Against Electron

**Where Electron wins.** Native menus, tray icons, dock behaviour, file dialogs,
global shortcuts, multi-window, auto-update, deep OS integration, and a
guaranteed Chromium — you know exactly which engine renders your interface. If
you are building something that must feel like a native application, Electron
does things this pattern cannot.

**Where this pattern wins.** No bundled browser: the binary is around 60 MB
rather than 150 MB and up, and there is no second runtime to keep patched. The
UI runs in the browser the user already has, already configured with their
extensions, their zoom, their accessibility settings. And the security boundary
is explicit — a Broapp host exposes the operations you registered and nothing
else, whereas an Electron renderer with `nodeIntegration` on has the whole
platform, and getting that wrong is the classic Electron vulnerability.

**The honest trade.** You give up owning the window. Your application appears as
a browser tab. It cannot have a menu bar, cannot appear in the dock, cannot be
the default handler for a file type without extra work, and renders in whichever
engine the user has. For a developer tool that is fine. For something you want a
non-technical user to think of as an app, it is a real limitation.

## Against Tauri

**Where Tauri wins.** Much smaller binaries — single-digit megabytes, because it
uses the operating system's webview instead of shipping one. A real application
window with native chrome. A mature permission system. Good mobile support.

**Where this pattern wins.** You write TypeScript on both sides and need no Rust
toolchain. Cross-compiling is one Bun flag rather than a cross-compilation setup.
And the UI runs in the *user's browser*, not in a system webview — which sounds
like a downside until you have debugged something in WKWebView on an old macOS
and wished for Chrome's devtools. Webview version fragmentation across platforms
is Tauri's genuine ongoing tax.

**The honest trade.** Tauri produces a smaller, more app-like artefact. This
produces a simpler build with one language. If binary size is a headline concern
for you, Tauri is better at it and it is not close.

## Summary

| | Plain local server | Broapp | Electron | Tauri |
| --- | --- | --- | --- | --- |
| Authenticated by default | No | Yes | N/A | N/A |
| Own window | No | No | Yes | Yes |
| Bundled browser engine | No | No | Yes | No |
| Binary size | tiny–small | ~60 MB | ~150 MB+ | single-digit MB |
| Languages | JS/TS | TS | JS/TS | TS + Rust |
| Rendering engine | user's browser | user's browser | bundled Chromium | OS webview |
| Cross-compiling | n/a | one flag | per-platform | Rust toolchain |
| OS integration | none | none | deep | good |

Sizes are order-of-magnitude for an application of this shape, not measurements
of yours.

## Choosing

- **A window, a menu bar, deep OS integration** → Electron or Tauri.
- **The smallest possible binary** → Tauri.
- **A local tool with a real interface, one language, no browser to ship, and
  authentication you do not have to design** → this pattern.
- **Thirty seconds of scratch work on your own machine** → a plain server, and
  stop reading.
