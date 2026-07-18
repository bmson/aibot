# Complex workflow test matrix

This is the regression contract for realistic assistant work. A unit test for one tool is not
enough to mark a workflow supported: the scenario must preserve context across every pause and
must end with evidence for each claimed action.

## Job application workflow

| Scenario | Required outcome | Evidence |
| --- | --- | --- |
| Drive resume → approved signed-in form → upload → portal receipt → approved tracker update | One durable task survives two approvals and a browser callback; only the approved plan runs; the final answer claims both actions only after both succeed | `apps/agent/src/job-application.e2e.test.ts` |
| Portal returns a review page but no receipt | The response contract replaces a fabricated “submitted” claim | `apps/agent/src/job-application.e2e.test.ts` |
| Portal confirms submission, owner denies tracker update | Report the confirmed application and the denied update separately; never call the Sheet API | `apps/agent/src/job-application.e2e.test.ts` |
| Missing or non-attachment upload path | Stop before interacting with the form; browser profile and arbitrary Workspace files remain unreadable | `packages/core/src/browse.test.ts`, `workers/browser-job/src/steps.test.ts` |
| Resume is larger than the supported 8 MB | Reject it before Workspace persistence or form interaction | `packages/tools/src/google/drive.test.ts`, `workers/browser-job/src/steps.test.ts` |
| Browser callback is replayed, late, forged, or never arrives | Accept one valid callback, reject replays/late tokens, and time out without relaunching | `apps/agent/src/browser.e2e.test.ts` |
| Browser launch response is ambiguous | Preserve the staged callback token and never start a duplicate job | `apps/agent/src/browser.e2e.test.ts` |

## Cross-cutting workflow guarantees

| Scenario | Required outcome | Evidence |
| --- | --- | --- |
| Process crash after a completed tool | Resume from the durable checkpoint without repeating the side effect | `apps/agent/src/executor.e2e.test.ts` |
| Approval denied, edited, expired, or resolved after cancellation | Execute only the approved payload, surface denials, and never resurrect cancelled work | `apps/agent/src/executor.e2e.test.ts`, `packages/tools/src/dispatcher.test.ts` |
| Budget is exhausted before or after approval | Park with the approved call intact and resume after the correct reset | `apps/agent/src/executor.e2e.test.ts`, `packages/core/src/model-router/router.test.ts` |
| External content enters an owner task | Propagate taint; privileged reads, writes, and network egress require exact owner approval | `packages/tools/src/dispatcher.test.ts`, `packages/tools/src/registry.test.ts` |
| Owner researches external content, then emails an exact summary | Carry the result into an exact approved email; do not expose tainted content to private voice samples | `apps/agent/src/research-email.e2e.test.ts`, `packages/tools/src/google/gmail.test.ts` |
| Portal submission is followed by a later confirmation email | Owner first approves one exact sender, opaque token, expiry, and literal Sheet mutation; authenticated Gmail then queues a deterministic, model-free update and reports into the original chat | `apps/agent/src/application-confirmations.e2e.test.ts` |
| Confirmation sender is spoofed/wrong, token is absent, watch expired/cancelled, or one email matches multiple applications | Make no private mutation; ambiguous matches become needs-attention and identify no application as confirmed | `apps/agent/src/application-confirmations.e2e.test.ts`, `apps/agent/src/email-sync.test.ts` |
| Confirmation update is replayed, crashes between checkpoints, or has an ambiguous provider result | Reclaim through the deterministic worker (never the model), reconcile the tool ledger after a known success, and suppress retry when Google may have committed | `apps/agent/src/application-confirmations.e2e.test.ts` |
| Provider response is lost after a mutation may have committed | Suppress automatic retry and report an unknown outcome instead of inventing success | `packages/tools/src/google/client.test.ts`, `packages/tools/src/twilio/client.test.ts` |
| Goal wakes repeatedly | Carry verified progress and next action forward; do not overlap a still-running Goal task | `packages/core/src/workflow/missions.test.ts` |
| Model claims an unsupported external action | Replace the prose with the evidence-backed failure response | `packages/core/src/workflow/response-contract.test.ts`, `apps/agent/src/executor.e2e.test.ts` |

## Still requiring stronger proof

- A real production job-board sandbox that allows safe repeatable form submissions. The local
  end-to-end suite executes the full state machine, but provider DOM and anti-bot behavior still
  require a consenting test target.
- The automated confirmation bridge currently applies an exact pre-authorized Google Sheet update.
  A comparable bounded Google Docs template/update path still needs implementation and testing
  before the assistant can claim the same automatic confirmation workflow for Docs.
- Automated mobile-browser assertions for the live production UI. Responsive source and production
  builds are covered, but viewport-specific interaction should be part of the release smoke test.
- OAuth revocation and insufficient-scope checks against a real bot account. The HTTP/token failure
  paths are tested with deterministic provider responses; live account state is covered only by
  deployment canaries.

## Release gate

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. A scenario is complete only when
the tool ledger, task state, provider result, and user-visible response all agree.
