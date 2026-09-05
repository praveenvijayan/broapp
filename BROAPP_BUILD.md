Build Broapp: a reusable starter kit for local applications powered by Bun, a browser UI, and Brobridge.

Work autonomously through implementation, testing, documentation, and a local release dry run. Make reasonable implementation decisions and document them. Do not stop after creating a plan or scaffold.

Do not publish packages, push releases, or deploy anything without explicit authorization. Complete all local preparation first.

CONTEXT

The architecture is established: a compiled Bun executable starts a local service, serves a web interface, and opens the user’s browser.

Public precedents include:
- https://github.com/HelgeSverre/glitchedit
  Uses bun build --compile, embeds its interface, starts a server, and opens the browser.
- https://github.com/capaj/ingit
  Uses a compiled Bun backend with a browser interface.
- https://github.com/webui-dev/bun-webui
  Uses browsers as GUIs for Bun applications.

Broapp’s purpose is to make this pattern easy, repeatable, and maintainable. Do not describe it as an invented architecture.

Brobridge already exists as a separate package:
https://github.com/praveenvijayan/brobridge

An example application is:
https://github.com/praveenvijayan/brolog

Keep Brobridge independent. Broapp should consume its public packages and APIs. Do not copy, fork, or rewrite its protocol, authentication, or streaming implementation.

Brolog is a reference implementation, not a template to copy wholesale. Its documented architecture includes:
- A loopback listener.
- A one-time browser launch URL.
- An authenticated browser session.
- Host and Origin protections.
- Unary calls and binary streams.
- Reconnect/resume.
- Bundled UI assets embedded in a Bun executable.

Inspect current upstream documentation and source before relying on these details. Package versions and APIs may have changed.

PRODUCT GOAL

An independent developer should be able to run approximately:

bun create broapp my-app
cd my-app
bun run dev
bun run build
./dist/<platform-specific-executable>

The first command is the intended published experience. Verify Bun’s package naming and create-command resolution before finalizing package names. Provide a working local equivalent before publication.

The generated application should:
1. Start a local Brobridge host.
2. Open an authenticated browser session.
3. Display a polished React interface.
4. Demonstrate a typed local function call.
5. Demonstrate streamed progress with cancellation.
6. Compile into an executable containing its UI assets.
7. Run without a separately installed Bun runtime.

Internet access must not be required for the starter’s normal runtime operation.

SCOPE AND ARCHITECTURE

Prefer a small Bun workspace containing:
- A create-broapp generator package.
- A companion package for shared development/build tooling.
- One canonical React + TypeScript template.
- Three runnable examples.
- Documentation and CI.

Choose final package names after checking availability and existing naming conventions. If the preferred names are unavailable, document a proposed alternative. Do not register names.

Use:
- Bun for host runtime, package management, tests where appropriate, and compilation.
- React + TypeScript for the default UI.
- Ordinary CSS with accessible, responsive styling.
- Brobridge’s published packages.
- A small runtime validation library if needed.

Avoid adding a framework-selection menu in v1.

Keep generated applications understandable. Suggested layout:

src/host/       Local operations and application lifecycle
src/ui/         React components and browser entry point
src/shared/     Contracts, types, and validation schemas

A developer should be able to identify where to add a host operation and where to call it from the UI in minutes.

Keep security-sensitive transport logic in Brobridge. Share repetitive tooling through the companion package. Introduce a shared runtime abstraction only when it materially simplifies the starter and examples.

FIRST: INVESTIGATE THE REAL DEPENDENCIES

Before implementation:
- Read applicable repository instructions.
- Inspect Brobridge’s current published packages, public API, examples, and security documentation.
- Inspect Brolog’s relevant build and lifecycle code.
- Verify Bun’s current executable asset-embedding and target support.
- Determine a supported minimum Bun version.
- Check whether browser launch and lifecycle functionality already exist upstream.
- Check stream cancellation and reconnect semantics.
- Check whether typed contracts already exist upstream.

Produce a short implementation plan with verified facts and unresolved constraints, then continue implementing.

Do not invent APIs or assume that ending an async iterator cancels its underlying stream.

If Brobridge lacks a required capability, use an adapter built on public APIs where safe. Document any upstream blocker and continue unaffected work. Do not weaken authentication to make development convenient.

GENERATOR REQUIREMENTS

Implement an interactive and noninteractive generator.

Support at least:
- Destination directory.
- Application name.
- Package manager behaviour appropriate for Bun.
- An option to skip dependency installation.
- Help and version output.

Requirements:
- Reject invalid names and unsafe paths.
- Support destination paths containing spaces.
- Never overwrite a nonempty directory silently.
- Do not introduce arbitrary shell interpolation.
- Generate correct package metadata and executable naming.
- Include a useful README and .gitignore.
- Do not initialize Git or make commits without an explicit option.
- Make a network-free generation path available through skip-install.
- Print concise next steps after successful generation.
- Handle partial failures without deleting preexisting user files.

Verify the generator from a packed local package, not only from workspace source.

GENERATED APP EXPERIENCE

The starter UI should contain:
- A concise explanation of the local application.
- A connection indicator.
- A button invoking a validated host function.
- A progress operation demonstrating streaming.
- A cancel button that actually cancels the operation.
- Useful loading, disconnected, reconnecting, and failure states.

Choose a harmless example such as a cancellable local computation. Do not expose arbitrary command execution or unrestricted filesystem access.

Use semantic HTML, visible focus indicators, labelled controls, sufficient contrast, and reduced-motion support.

Keep implementation jargon out of normal user-facing controls. Put technical explanations in a developer-oriented expandable area or documentation.

TYPED OPERATIONS AND VALIDATION

Provide an ergonomic, typed way to define host operations and call them from the browser.

Prefer Brobridge’s existing facilities. If an adapter is necessary, keep it small.

Requirements:
- Share request and response types without bundling host implementation into the browser.
- Validate untrusted inputs at runtime on the host.
- Clearly distinguish public errors from internal errors.
- Do not expose stack traces, filesystem paths, or secrets to the browser by default.
- Support cancellation for long-running operations.
- Make cleanup happen when an operation ends, fails, or is cancelled.
- Document what happens to operations during transport disconnection.

Do not promise exactly-once execution across reconnects. Avoid automatically retrying mutating operations unless their semantics make that safe.

SECURITY DEFAULTS

Use Brobridge’s supported authentication and session flow unchanged.

Requirements:
- Bind to loopback by default.
- Do not enable LAN access in v1.
- Preserve upstream Host, Origin, cookie, and browser-request protections.
- Serve the application through the intended authenticated origin.
- Avoid off-origin scripts, fonts, styles, analytics, or CDN assets.
- Use a restrictive content security policy compatible with the application and upstream behaviour.
- Validate every privileged operation’s input.
- Expose only explicitly registered operations.
- Do not create a generic shell execution endpoint.
- Do not create an unrestricted filesystem-serving endpoint.
- Do not log launch credentials or session cookies.
- If a launch URL must be shown for manual fallback, display it deliberately and do not persist it in log files.

Document the threat model accurately:
- Loopback HTTP/WebSocket communication is not TLS encryption.
- Authentication is not a sandbox for the local process.
- The executable runs with the invoking user’s permissions.
- Compromised frontend code may exercise the operations available to its session.
- Local malware and compromised operating systems are outside the starter’s protection.

Do not claim that Broapp or Brobridge is security-audited unless an actual audit can be cited.

DEVELOPMENT WORKFLOW

Provide one development command that:
- Builds or watches the UI.
- Starts the host.
- Opens the browser appropriately.
- Cleans up child processes on exit.
- Avoids spawning a new browser tab after every rebuild.

Prefer serving development assets through the authenticated application origin.

Investigate whether secure hot reload is straightforward. If it is not, implement a reliable rebuild-and-reload workflow first and explain it. Do not add permissive CORS or bypass authentication just to achieve HMR.

Host restarts may invalidate sessions. Handle this explicitly: reopen or guide the developer through a fresh authenticated launch. Do not silently pretend transport resume survives destruction of the host process.

LIFECYCLE

Support two explicit lifecycle modes through a small configuration surface:

1. Interactive:
   Exit after a configurable grace period with no attached browser clients, provided shutdown will not silently discard active work.

2. Background:
   Continue when the UI closes, with documented termination behaviour.

Choose interactive as the starter default.

Requirements:
- Account for multiple browser tabs.
- Distinguish attached clients from retained sessions used for replay.
- Handle initial launch when no browser ever connects.
- Handle SIGINT and SIGTERM.
- Cancel or finish work according to a documented shutdown policy.
- Close servers, streams, database connections, and child processes.
- Provide a clear manual-browser fallback.
- Use accurate reconnect states; do not display “offline” based on an invented transport timeout.

For background mode, a foreground terminal process is acceptable in v1. Do not silently install a system service or implement daemonization.

BUILD AND PACKAGING

Provide:
- Current-platform build as the default.
- Explicit target selection.
- A documented command for all supported release targets.
- Version and help flags on the generated executable.
- Deterministic output naming.
- Clean build errors.

Embed all required UI assets into the executable using supported Bun mechanisms. Verify actual emitted assets, including fonts or workers if any are introduced.

The compiled starter must run:
- Without source files nearby.
- Without a separately installed Bun.
- From an unrelated working directory.
- Without writing into the executable’s directory.
- Without internet access for normal operation.

Store mutable application data in an appropriate per-user application-data directory, outside the executable. Make its location discoverable and allow a documented override.

Document runtime size honestly. Do not promise tiny binaries.

Do not assume every dependency or native module cross-compiles. State supported target limitations.

UPDATES AND DISTRIBUTION

Include a release workflow that can:
- Run required checks.
- Build supported binaries.
- Produce archives and checksums.
- Prepare release artifacts.

Keep package publication and public releases manually gated or otherwise explicitly controlled.

Document:
- macOS signing and notarization.
- Windows signing and SmartScreen implications.
- Linux executable permissions and compatibility.
- How to replace an installed executable.
- How application data remains separate from updates.

Automatic self-updating is out of scope for v1. Do not ship an insecure updater.

EXAMPLES

Build three examples using the same public tooling available to generated projects:

1. Live dashboard
   - Streams useful, non-sensitive system metrics.
   - Demonstrates independent streams and reconnect behaviour.
   - Handles unavailable platform metrics honestly.

2. File processor
   - Processes files under a deliberately configured or authorized directory.
   - Demonstrates progress and cancellation.
   - Avoids path traversal and arbitrary filesystem access.
   - Writes outputs safely and defines cancellation behaviour.
   - Clearly explains how file paths reach the host; browsers do not reveal arbitrary absolute paths through ordinary file inputs.
   - Does not overwrite user files by default.

3. SQLite application
   - A small notes or task application.
   - Persistent data in the user-data directory.
   - Validated CRUD operations.
   - Schema versioning and a minimal migration mechanism.
   - Clear behaviour for database failures.
   - Documented backup/export approach.

Keep these focused. Their purpose is to verify that the abstraction works across realistic applications.

DOCUMENTATION

Write:
- Root README with a concrete promise and a quick start.
- Generated-project README.
- Architecture explanation in prose.
- Guide to adding a host operation.
- Guide to streaming and cancellation.
- Development and production lifecycle guide.
- Security model and safe-operation guidance.
- Packaging and release guide.
- Troubleshooting guide.
- Contributor guide.
- Scope and limitations document.

Include a short comparison with:
- A plain local HTTP application.
- Electron.
- Tauri.

Explain tradeoffs factually, without unsupported size or performance claims.

State that this pattern is established. Broapp’s contribution is the reusable developer experience around Bun and Brobridge.

Do not generate diagrams unless needed and permitted by applicable repository instructions.

TESTING AND VERIFICATION

Test behaviour and important boundaries, not implementation details.

At minimum verify:
- Generator produces a usable application.
- Nonempty destinations are protected.
- Paths with spaces work.
- Packed generator and companion packages work outside the monorepo.
- Generated dependencies resolve without workspace-only references.
- Browser bundle excludes host code and secrets.
- Unauthenticated HTTP and WebSocket access are rejected as expected.
- Untrusted origins are rejected.
- Invalid operation inputs are rejected.
- Typed client contracts detect incompatible usage.
- Stream cancellation releases work.
- Reconnect behaviour matches documented semantics.
- Multiple-tab lifecycle works.
- Shutdown releases resources.
- Starter builds and launches as a standalone executable.
- Embedded assets work from an unrelated directory.
- SQLite data persists across restarts.
- File processing respects its configured boundary.

Add a real browser smoke test where available:
- Launch executable.
- Complete authenticated bootstrap.
- Invoke a host operation.
- Observe progress.
- Cancel.
- Exercise disconnection/reconnection.
- Verify connection/error UI.

Run native-platform executable smoke tests in CI where runners are available. Clearly separate cross-compilation success from actual native execution.

Do not claim tests passed unless they ran. Report environmental limitations precisely.

LOCAL RELEASE DRY RUN

Before finishing:
1. Pack the generator and companion packages.
2. Generate a fresh application outside the workspace package tree.
3. Install using local packed artifacts or another reproducible local package-resolution strategy.
4. Run checks.
5. Build the executable.
6. Run it from a different working directory without its source tree as a dependency.
7. Verify its browser interface and one local operation.
8. Record exact commands and outcomes.

Do not publish to npm merely to test installation.

ACCEPTANCE CRITERIA

The work is complete when:
- A new developer can generate, run, modify, and compile an application using documented commands.
- Brobridge remains independent and unmodified.
- Secure upstream defaults are preserved.
- The default UI demonstrates a typed call and cancellable progress stream.
- UI assets are embedded in the starter executable.
- Interactive and background lifecycle modes behave as documented.
- All three examples use the same supported tooling.
- Tests and the local package dry run pass, subject to clearly identified environmental constraints.
- Documentation explains limitations and distribution requirements.
- There are no placeholder implementations, fake success states, or undocumented critical TODOs.

FINAL HANDOFF

Report:
- What was built.
- Repository/package layout.
- Exact local commands to generate, develop, test, and build.
- Verified operating systems and targets.
- Test and package-dry-run results.
- Important design choices.
- Remaining limitations or upstream blockers.
- The concrete steps requiring human authorization before publication.

Keep a clear distinction between implemented behaviour, verified behaviour, and future possibilities.