# 10 — Phase 2 backlog

Not a build prompt. This records what the nine build prompts deliberately
left out, why, and what would have to be true before each item is worth
doing. Read it after prompt 09's report, then update it: move anything the
reports discovered into the right section, and delete anything the reports
show was done after all.

Write the result to `docs/autoapp/backlog.md` and commit it on `autoapp`
with the message `Record the Autoapp phase 2 backlog`. Keep the fixed
decisions from `00-common-rules.md` intact; this file proposes, it does not
reopen.

## Deferred on purpose

| Item | Why deferred | Precondition to start |
|---|---|---|
| **Enforced capabilities.** An OS sandbox for application children: `sandbox-exec` profiles on macOS, Landlock or bubblewrap on Linux, a restricted token or AppContainer on Windows. Or a broker model where privileged work is available only through launcher-provided operations. | v1 children are trusted local code; the manifest describes, the gate decides, nothing contains. Doing containment per platform before the loop exists would have cost the loop. | A non-engineer audience, or a single report of a generated change reaching outside its data directory. Start with the broker model: it is portable and the gate already has the `external` effect to hang it on. |
| **Custom browser code per application.** Generated React or JavaScript views, which need an origin of their own and therefore a Brobridge change (an explicit `same-site` embedding allowlist) or a second document route. | The renderer covers tables, forms, actions and status. Generated browser code breaks the "one pinned document" property that makes the CSP a guarantee. | A view the renderer cannot express that a real user needed, recorded in a report. Then design the Brobridge opt-in first and review it there. |
| **Renderer primitives.** A pure navigation action; charts; file upload and download inside the data directory; a list-detail layout; a stream-backed live table using `useStream`. | Prompt 04's set was the minimum for Notes. Prompt 04's report notes the missing navigation action. | Each is small; add when a demo needs it. Navigation first. |
| **Workflow failure policies** beyond `stop`: `continue`, `retry` with a count, compensation steps. | Compensation is where "undo" becomes a lie without care; `stop` is honest. | A workflow with external steps in real use. Compensation for external effects stays manual and explicit. |
| **Workflow capture from demonstration** (record what the person clicks, not what the model called). | Research-grade problem; the tool-call sequence from a run is structured already and covers the demo. | Evidence that people want to save what they did by hand, not what they asked for. |
| **`external` operations over MCP.** | External effects driven by an external agent through a tab approval is two hops of trust; keep it out until the approval UI shows enough context. | The approvals strip showing the operation's declared hosts and paths from the manifest. |
| **Approval by MCP elicitation** instead of the tab. | Elicitation support varies by client; the tab is one place that always works. | Two mainstream clients supporting elicitation. Keep the tab path; add elicitation as a second approver. |
| **Prune.** Deleting `data-prev-*`, snapshots, previews and old releases. | Recovery must never lose data; deleting is a separate, explicit action. | Design a `prune` command that lists what it would remove, requires `--yes`, and never removes the current release, the last two `data-prev`, or any snapshot younger than seven days. |
| **Multiple launcher instances.** Two launchers on one machine over one root. | The control file and journal assume one. | A lock file in `<root>` with pid and liveness check; `serve` refuses to start twice. Small; do it early in phase 2. |
| **The engineer running inside the application's tab** (the original sketch). | Avoided an IPC RPC surface for the launcher; the launcher tab is the engineer's home. | If users keep two tabs open anyway, add `launcher.*` routes proxied through the app child so the app's `AiChat` can reach the engineer. Costs one more IPC message type and a second gate hop; the gate design already carries `caller`, so the audit trail survives. |
| **Down migrations and data-restore UX.** | Forward-only by decision; the rollback boundary is documented. | A UI in the launcher that shows, after a failed activation past the switch, the three honest options (compatible downgrade, forward repair, approved restore discarding later writes) and journals which was taken. |
| **Rate limits and resource limits on children.** CPU, memory, disk quotas. | The child is trusted local code in v1. | Comes with enforced capabilities. |
| **A second example** beyond Notes, chosen from real use: document intake and reconciliation was one reviewer's guess. | Unverified market pick. | Evidence from anyone using the Notes loop for something else. |

## Findings to fold in from the reports

Fill this from `reports/01` to `reports/09`: every "Decisions I made", every
deviation, every skipped platform test, every place the model stalled in
the prompt 07 demo. Each becomes either a backlog row above, a fix in the
build prompts for a second pass, or a documented limitation in
`docs/limitations.md`.

## What to measure before phase 2

- How many build iterations the engineer needed per change in the demo,
  and where it stalled.
- Whether the promoted workflow was used again after the demo session.
- Whether any approval was declined, timed out, or mismatched in real use,
  and why.
- Binary size of the launcher versus a Notes binary.
- Time from "ask" to "activated" for the Notes change, wall clock.

These decide whether the core promise, software that keeps adapting to its
owner, holds up enough to invest in containment, custom views, or a second
example.
