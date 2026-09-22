# 21a — The engineer reads the web

## What was built

- **`src/engineer/web.ts`** (new): `WebBrowser` and the three result types; `allowedWebUrl`;
  `searchUrl`, `unwrapResultUrl`, `tidyText`; the two page scripts `SEARCH_RESULTS_SCRIPT` and
  `PAGE_TEXT_SCRIPT`; `webViewBrowser(options?, views?)` over `Bun.WebView`; `webTools({ gate, browser })`
  returning `web.search` and `web.read`, both `external`. Constants: eight results by default, ten at
  most; 8 000 characters a read by default, 20 000 at most, 200 000 kept of any page; forty links;
  thirty seconds a load. The file has its own `parsed` so it and `tools.ts` do not import each other.
- **`tools.ts`**: `EngineerToolsOptions.browser?`, defaulting to `webViewBrowser()`; the two tools merged
  in before the planning, busy, refusal and expiry wrappers; the header no longer says `external` is
  only ever `release.activate`.
- **`instructions.ts`**: three lines after step 6 and one bullet; still seventy-two lines (below).
- **`engineer/index.ts`**: the module's exports.
- **Tests**: `tests/autoapp-web.test.ts` (15) and one case in `autoapp-engineer.test.ts`.
- **Documents**: design (effect paragraph, "The engineer and the web"), security ("The engineer and the
  web", the standing approval's exclusion named), packaging (outside the tiers), package README,
  troubleshooting (two entries), backlog (three rows), the prompts README row, this prompt.

`bun run check`: typecheck clean, 1213 tests pass across 61 files. `tests/ai-chat.test.ts` unedited.

## The by-hand run

A scratch script inside the repository, a `createGate` over a run store on the AI channel with a
`createPendingApprovals` answering yes, the real `webViewBrowser()` on macOS 15 / Bun 1.4.0 (WebKit):

| Call | Asked with | Came back | Time |
|---|---|---|---|
| `web.search` | `{"query":"Bun.WebView evaluate expression","limit":3}` | three rows: `bun.com/reference/bun/WebView/evaluate`, `bun.com/docs/runtime/webview`, `github.com/oven-sh/bun/issues/43412`, each with a title and a snippet | 1 163 ms |
| `web.read` | `{"url":"https://bun.com/reference/bun/WebView/evaluate","maxChars":600}` | title, 600 of 1 048 characters, `truncated: true`, `nextOffset: 600`, one link | 1 292 ms |
| `web.read` | `{"url":"http://127.0.0.1:1/"}` | `rejected` | — |

Both approved calls were recorded as steps of the run under `web.search` and `web.read`. The earlier
spike, before the tools existed, put `bun webview headless` to the same endpoint in 1 295 ms and read
`bun.com/docs/runtime/webview` (27 651 characters, 181 links) in 1 775 ms; the docs page has no
`article` or `main`, so the body is read and its navigation is hidden by the landmark rule.

## What the first by-hand run found wrong

The loopback refusal in the table above came back as *"web.read was not approved"*: `allowedWebUrl`
sat inside the guarded `run`, so the gate asked first and only then was the address refused. A card
for `http://127.0.0.1:4711/launch?secret=…` is a refusal put to the person as a question, and a
person could answer it. `web.read` is now the guarded tool spread into a second object whose `execute`
runs `allowedWebUrl` before reaching it, async so the refusal is a rejection like every other tool's.
The `GUARDED` brand is an own symbol property and survives the spread; the test proves a good address
still asks, and that nothing was pending and nothing read after the whole refusal list. The check runs
again on `page.url` after the read, for a redirect; the message names the host, never the page.

## The instructions at seventy-two

The first draft added a seven-line paragraph and two bullets: eighty-three lines, and both tests that
hold the cap failed. The web guidance is now three lines at the hundred-column width step 3 already
uses, plus one bullet, and the *What you are*, *How to work* preamble, migrations sentence, steps 1, 2
and 6, the backlog paragraph and the first two bullets were rewrapped at the same width — the same
words, fewer lines. `instructionsHash` changes, as it must for any edit; the knowledge store's
freshness flags see a new hash and nothing else.

## Fixed decisions

None found wrong. One was tempting to reopen: with both tools `external`, a search and two reads are
three cards in one turn. The rule is right — the card is the one place the person sees a query or an
address before it leaves the machine, and the standing approval's list is closed by name — so the cost
is a backlog row ("Browsing without asking"), not a change.

What the address check does not do, said in security.md: it does not resolve names, so a public name
that resolves to a private address passes it; the card is the second line there.

## Bun.WebView, as met

- `navigate` on the WebKit backend took about a second for either site; a `data:` page loads in
  milliseconds, which is what the real-view test uses.
- `evaluate` must be an expression; both scripts are an array expression and an IIFE. A result page
  from the engine wraps each link as `//duckduckgo.com/l/?uddg=…`; the spike's rows came back direct,
  so both shapes are handled and tested.
- One view a call, `dataStore: "ephemeral"`, `close()` in `finally`; the view is not kept between
  calls, so nothing the engineer read is anywhere afterwards and no login carries across pages.
- `Bun.WebView` is typed in `bun-types` 1.4.1, so no declaration was needed; it is looked up through
  `Bun` at the call so an older runtime reports `NO_BROWSER` rather than failing at construction.
- Issue 43412 (found by the by-hand search): an `evaluate` still in flight when a navigation starts can
  be overtaken on WebKit. The tools never overlap the two.
