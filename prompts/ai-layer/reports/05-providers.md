# 05 — Provider packages

`bun install`, `bun run check` and `bun run dryrun` all exit 0. `bun test
tests` → `212 pass, 0 fail` across 18 files; `tests/ai-providers.test.ts`
contributes 20. No test touches the network: every adapter call takes its
`fetch` from `AdapterConfig`, and each test passes a stub that records what it
was asked for.

## What was built

`packages/broapp-ai-anthropic` exporting `anthropic()`, and
`packages/broapp-ai-compatible` exporting `openaiCompatible(options)` with the
`ollama()`, `openai()` and `customServer()` presets. Both carry the metadata
style of the existing packages (license, repository `directory`, `files`,
`publishConfig`, `engines`), their own `tsconfig.json` extending the base, and
a copy of `LICENSE`.

Both adapters follow the prompt's tables exactly: Anthropic sends `x-api-key`
and `anthropic-version: 2023-06-01` to `/v1/models?limit=100` and follows
`has_more` / `last_id` for at most five pages; the compatible adapter sends
`GET <baseUrl>/models` with a bearer token only when a key is set.

## Decisions I made

- **Anthropic's next-page cursor is `last_id`, not `after_id`.** The prompt
  named `after_id` for both. `after_id` is the *request* parameter; the
  response carries `last_id`. The adapter reads `last_id` and sends it back as
  `after_id`, and the pagination test asserts the second request's query
  string.
- **`has_more` alone does not continue the loop**; a page that claims more but
  gives no `last_id` would otherwise repeat the first page forever.
- **The error body is attached as `cause`, never interpolated.** The test
  asserts a `'super-secret-body'` response never appears in any message, for
  all six status classes and for a `fetch` that throws.
- **`test()` calls `models()`.** Listing costs no tokens and still proves the
  key, so a connection test cannot quietly bill the user.
- **Both packages depend on `broapp` as a peer** and import `AdapterError` and
  `isLoopbackUrl` from `broapp/ai/host`, so an adapter and the host it plugs
  into cannot disagree about what an error means.
- `broapp-ai-anthropic` and `broapp-ai-compatible` were added to the root
  `devDependencies` as `workspace:*`. Without that, `tests/` cannot resolve
  them — the workspace globs make them packages, but nothing linked them into
  the root `node_modules`.
- `scripts/pack-local.ts` hardcoded `['broapp', 'create-broapp']`; it now has a
  `PUBLISHED` list with all four. `scripts/release-dry-run.ts` selects the two
  tarballs it needs by name from `packLocal()`'s result, so it needed no
  change, and the dry run still passes.

## Capabilities reported

Anthropic reports `{ tools: true, vision: true, structuredOutput: true }` for
every model, as the prompt specifies. The compatible adapter reports
`{ tools: true, vision: false, structuredOutput: false }`, because `GET
/models` says nothing about what a model can do and claiming a capability it
lacks fails at the worst moment. Neither is discovered; both are declared.

## Open questions

- Nothing here validates that a model id in settings is still offered by the
  provider. A model that is withdrawn leaves the application configured and
  failing at the first chat turn, with whatever the provider says. Prompt 06's
  settings UI could re-check the list on open.
- The compatible adapter's `local()` is computed from the base URL alone. A
  user who points it at a loopback *proxy* that forwards off-machine would be
  told their prompts stay local. There is no way to detect that from here; it
  is worth a sentence in the documentation.
