# Request continuity and completion evidence

This first increment builds on the existing task checkpoints, tool ledger,
response contract, owner-reply folding, and generated-card revisions. It does
not introduce another agent loop, scheduler, approval mechanism, or database.

## Compound requests

Recognized direct owner chat/SMS requests with 2–12 action clauses get a
`requestChecklist` in task state. Supported outcome families are lookups,
memory saves, saved cards, reminders, sends, drafts, document creation, and
calendar creation. Labels must be verbatim spans of the triggering request.
Quoted, conditional, negated, or unsupported requests retain the existing
workflow instead of acquiring inferred obligations.

The executor reconciles outcomes against this task's tool calls before model
steps, approval parking, and final delivery. Successful execution plus a
matching result/receipt is required; approval alone, an empty search, prose,
and another task's successful action do not complete an item. Saved-card
receipts are added only after database persistence returns a revision.

A premature prose stop may get one persisted recovery attempt within the
existing step and cost budgets. This does not run after a blocked/waiting
outcome or a later owner instruction, and does not change dispatcher safety
or approval gates. Unverified outcomes cannot close the whole task as done;
the final response lists partial status and the task needs attention. Planner
clarification questions are retained. Task-detail queries project validated
checklist items, not the internal scratchpad or full state.

This is a conservative receipt check, not a general semantic proof that every
constraint was satisfied. Clause detection and target matching are deliberately
narrow. The existing response contract and final-output verifier still apply.
Automatic correction of the original checklist after owner edits and a
dedicated checklist UI are not part of this increment.

## Historical cards

Chat routing and task execution use the same bounded card-context builder.
Relevant follow-ups can see up to four recent card identities, with the newest
conversation-recorded revision winning. Generated cards include source-labelled
public facts, revision, capture time, and expiration. Sensitive facts, action
prompts, hidden payloads, and background notices are excluded.

These records are historical context, not current tool evidence or new
authorization. Their presence restores the executor's untrusted-content gate.
External senders never receive the owner's card history. Save-status questions
retain their dedicated receipt-check route. This does not fetch the current
saved-card database revision or refresh expired facts automatically.

## Regression coverage

Pure tests cover extraction, receipt matching, bounded context, redaction, and
revision selection. Scripted-model golden tests exercise the real executor and
isolated test database: omitted-step recovery, incomplete finals, owner changes,
task-scoped approvals, successful card persistence, and persistence failure.
They make no provider calls or production writes and do not measure live-model
quality. Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before release.
