# Investigating an audit record

Open `/audit/<task UUID>` and use **Copy investigation request** to ask the assistant to investigate from the mobile app. The bot's `audit.read` and `audit.read_field` tools use the same owner-scoped projection as the console. They are unavailable to externally triggered tasks, return untrusted evidence, and never retry or mutate the investigated task.

The record includes task setup, trigger, plan, attempt/reclaim counts, budgets, deadlines and selected diagnostic state; tool arguments, results, errors and policy decisions; model role, provider/model, token usage, finish reason and latency; captured system/input/output; approval requests and resolutions; messages from the task and conversation at task creation; response-contract and verification checks; and recall quality counters.

Each section pages independently using timestamp plus record ID, preserving entries with equal timestamps. Follow `nextCursor` with the same section. Large fields expose `offset`, `totalChars` and `hasMore`; `audit.read_field` retrieves the next 12,000 sanitized characters. Reading more cannot recover content truncated by the original capture. JSON downloads from `/api/audit/<task UUID>` require owner browser authentication and return a bounded page with the same continuations.

Capture respects `LLM_AUDIT_CAPTURE` (`off`, `redacted`, or `full`) and the existing retention window. Provider errors now retain the input and error metadata when capture is enabled, even when the provider returns no billable result. Audit write failures must never replace the provider error or trigger extra provider work. Credentials and runtime resume tokens are excluded from the investigation projection.

Older tasks may lack capture, per-attempt lifecycle history, or the release version that executed them. Missing entries are evidence gaps, not proof that an action or model call never happened. Investigations should cite record IDs, distinguish observed causes from hypotheses, identify missing evidence, and propose concrete fixes and regression scenarios rather than automatically modifying code.
