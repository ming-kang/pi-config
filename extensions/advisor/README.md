# advisor — local independent review

Adds an `advisor` tool plus an `/advisor` command: a one-shot review from a separately configured reviewer model. Inspired by Claude Code's server-side advisor, but implemented fully locally through Pi's own model registry and provider auth.

## Behavior

Run `/advisor` to open a searchable menu:

- The title shows the currently configured reviewer model and effort.
- Search reviewer models by name/provider, like `/model`.
- Select reasoning effort for reasoning-capable reviewer models.
- Choose "No advisor" to disable the tool.

The setting is stored at `~/.pi/agent/pi-config/advisor.json`, restored on session start, and reconciled on model-select and agent-start. When no reviewer model is selected the tool stays inactive.

`advisor.json` also accepts an optional hand-edited `guidance` block — `{ "guidance": { "promptSnippet": "...", "promptGuidelines": ["..."] } }` — overriding the built-in model-facing prompt copy. It is read once at extension load; `/reload` applies changes.

When called, the `advisor` tool forwards the resolved current session context to the reviewer model with `tools: []` (the reviewer cannot execute tools, read files, or ask follow-up questions). It is a single completion — the packet it receives is everything it sees.

## Design notes

- **No same-model restriction.** The advisor is available regardless of whether the reviewer model matches the executor. A model in "review mode" (no tools, structured prompt) produces different output than in "execute mode".
- **Mode-specific reviewer prompt.** `advisorSystemPrompt(mode)` composes a shared base + a per-mode focus + shared output sections. The five modes — `plan` / `change` / `stuck` / `final` / `reconcile` — each steer the reviewer's stance. The `## Overall Judgment` output section is **always present** so the collapsed `renderResult` can extract a one-line summary (`extractSummary`).
- **Whole-context packet, bounded.** Because it is one-shot, the packet must be self-sufficient: the selected context is sent verbatim while it fits the reviewer's budget (context window minus the model's output reserve, at ~3 chars/token with a 0.9 safety margin — see `budget.ts`). Past the budget, the largest tool-result segments are head-truncated to a common cap (water-fill), marked inline with `[... truncated N chars]`, and declared to the reviewer at the top of the context; user/executor messages are never cut. If even that cannot fit, the call fails with an actionable error instead of sending a silently broken packet. Depth is controlled by `previousRuns` (0/1/2) — current run only by default, optionally plus one or two earlier request cycles. No executor tool inventory is sent (the executor handles advice in context regardless).
- **Context labeling.** The review brief labels executor-provided evidence as a summary and directs the reviewer to prefer raw session context on conflict. Prior advisor results inside the context are labeled "Previous advisor guidance" so the reviewer doesn't mistake them for executor work.
- **Loading state.** `renderResult` uses `activeDotLine` while awaiting the LLM.
- **No statusline display.** The advisor deliberately does not write to the footer; its result lives in the tool render only.

## Files

- `index.ts` — tool + command registration, render, lifecycle hooks
- `schema.ts` — params (`mode`, `previousRuns`, brief fields) + `clampPreviousRuns`
- `constants.ts` — `ADVISOR_DESCRIPTION`, `advisorSystemPrompt(mode)`, mode focus table, labels, guidelines
- `context.ts` — builds the review packet from session messages (flatten, select, label, budget-fit)
- `budget.ts` — pure char-budget estimation + water-fill segment trimming (zero imports, scratch-testable)
- `execute.ts` — runs the one-shot `completeSimple` call, maps the result
- `config.ts` — persisted config (model/effort + optional `guidance` prompt-copy overrides)
- `command.ts` / `restore.ts` — `/advisor` menu; in-memory model/effort state, tool (de)registration (`reconcileAdvisorTool`), session restore
