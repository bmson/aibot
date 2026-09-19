# Production messaging review — September 19, 2026

The read-only production snapshot at 18:43 UTC covered 1,902 messages in 145 conversations: 629 user messages and 1,273 assistant messages. The live primary conversation was also inspected (102 visible messages). Private snapshots and normalization previews remain in ignored `.workspace/messaging-review/`, outside version control.

## Findings and repairs

- Two native menu-close gesture modifiers used `GestureMask.none` while inactive, disabling descendant controls. They now preserve subview gestures. Suggestion actions show a saving state until acknowledged and reject duplicate submissions.
- Two accepted production suggestions had completed tasks with no conversation destination. Acceptance now finds the originating card's owner-scoped chat or the primary chat, and the executor retains the accepted proposal as its instruction. New results return to the chat. Existing accepted receipts display the real task status instead of permanently claiming work is running; existing completed tasks are not rerun.
- Snoozes could expire precisely when they should reopen. They now retain a response window and authoritative wake time. Stale polls cannot undo saved decisions, and replayed requests return the existing result. Dated proposals cannot outlive their useful deadline.
- Seventeen historical email alerts were labelled “Needs a reply,” including automated alerts and confirmations. Known legacy pulse envelopes are normalized on read to “Needs attention”; internal scoring rationale and duplicate sender summaries are removed. New notices offer a clear review action.
- Important-email notifications no longer expose internal scoring explanations. Briefings exclude stale or archived task failures and expired approvals, and present service failures in plain language.
- Calendar cards rendered persisted UTC clock strings beside local-time strings. Clients now derive display times from timestamps, and date-only all-day entries keep their calendar day.

Stored message text is preserved. The historical cleanup only recognizes the known legacy producer envelope; arbitrary email summaries and action instructions are not rewritten. No external email, reminder, or calendar action was triggered during the audit.

## Verification

- All 1,273 assistant messages and their 538 card payloads passed server-rendering checks against the updated web components. Twenty-five historical email-thread cards and one resource card retain the existing readable prose fallback on web.
- Full JavaScript suite: 275 files passed, 2,547 tests passed; 28 files / 131 tests skipped (optional integrations).
- Repository typechecks, lint/architecture boundaries, production build, and whitespace checks passed. Existing lint warnings remain.
- Native simulator suite: 250 tests, one optional corpus snapshot skipped, zero failures; additional calendar and receipt regressions are checked separately after review.
- Native layouts were checked in light, dark, narrow, and accessibility snapshots. Simulator unit/render tests do not prove physical-device touch behavior.

A server deployment can update message hydration and task behavior. The gesture repair requires an updated signed iOS app; server deployment alone cannot replace the installed native code. The separate message-API-error task owns the model provider's mandatory-reasoning failure.
