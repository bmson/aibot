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
| Drive resume → approved portal submission → delayed authenticated email → Sheet + Doc → original chat | Preserve one approved action contract across the browser and email event boundary; reject spoofed mail, execute each frozen Workspace action once, and report the evidence in the originating conversation | `apps/agent/src/job-application-continuity.e2e.test.ts` |
| Portal submission succeeds but the owner denies the delayed confirmation watch | Preserve and report the verified submission while accurately reporting that no watch or future Workspace action was created | `apps/agent/src/job-application-continuity.e2e.test.ts` |

## Cross-cutting workflow guarantees

| Scenario | Required outcome | Evidence |
| --- | --- | --- |
| Process crash after a completed tool | Resume from the durable checkpoint without repeating the side effect | `apps/agent/src/executor.e2e.test.ts` |
| Approval denied, edited, expired, or resolved after cancellation | Execute only the approved payload, surface denials, and never resurrect cancelled work | `apps/agent/src/executor.e2e.test.ts`, `packages/tools/src/dispatcher.test.ts` |
| Budget is exhausted before or after approval | Park with the approved call intact and resume after the correct reset | `apps/agent/src/executor.e2e.test.ts`, `packages/core/src/model-router/router.test.ts` |
| External content enters an owner task | Propagate taint; privileged reads, writes, and network egress require exact owner approval | `packages/tools/src/dispatcher.test.ts`, `packages/tools/src/registry.test.ts` |
| Owner researches external content, then emails an exact summary | Carry the result into an exact approved email; do not expose tainted content to private voice samples | `apps/agent/src/research-email.e2e.test.ts`, `packages/tools/src/google/gmail.test.ts` |
| Portal submission is followed by a later confirmation email | Owner first approves one exact sender, opaque token, expiry, and literal Sheet and/or Google Doc mutations; authenticated Gmail then queues deterministic, model-free actions and reports each outcome into the original chat | `apps/agent/src/application-confirmations.e2e.test.ts` |
| Confirmation sender is spoofed/wrong, token is absent, watch expired/cancelled, or one email matches multiple applications | Make no private mutation; ambiguous matches become needs-attention and identify no application as confirmed | `apps/agent/src/application-confirmations.e2e.test.ts`, `apps/agent/src/email-sync.test.ts` |
| Confirmation update is replayed, crashes between checkpoints, or has an ambiguous provider result | Reclaim through the deterministic worker (never the model), reconcile the tool ledger after a known success, and suppress retry when Google may have committed | `apps/agent/src/application-confirmations.e2e.test.ts` |
| Sheet and Doc confirmation actions have different outcomes | Continue independent approved actions, persist each result separately, and report partial/unknown completion without claiming the whole workflow succeeded | `apps/agent/src/application-confirmations.e2e.test.ts` |
| Provider response is lost after a mutation may have committed | Suppress automatic retry and report an unknown outcome instead of inventing success | `packages/tools/src/google/client.test.ts`, `packages/tools/src/twilio/client.test.ts` |
| Goal wakes repeatedly | Carry verified progress and next action forward; do not overlap a still-running Goal task | `packages/core/src/workflow/missions.test.ts` |
| Model claims an unsupported external action | Replace the prose with the evidence-backed failure response | `packages/core/src/workflow/response-contract.test.ts`, `apps/agent/src/executor.e2e.test.ts` |
| A multi-action response mixes verified success with an unsupported claim | Preserve the verified actions in deterministic copy and reject only the unsupported completion claim; never replace real partial success with “nothing happened” | `packages/core/src/workflow/response-contract.test.ts` |
| Core UI runs at a 390×844 touch viewport | Dashboard, chat, Goals, tasks, profile, and settings have no horizontal overflow; interactive controls are at least 44×44; fields do not trigger iOS focus zoom; the navigation drawer contains focus and restores it on close | `scripts/mobile-smoke.ts`, `.github/workflows/ci.yml` |

## Still requiring stronger proof

- A real production job-board sandbox that allows safe repeatable form submissions. The local
  end-to-end suite executes the full state machine, but provider DOM and anti-bot behavior still
  require a consenting test target.
- An unattended, authenticated mobile-browser smoke test against the post-deploy production UI. CI
  now exercises the core UI in real Chrome at 390×844, and production is inspected with the owner's
  authenticated session, but the deployment gate cannot safely reuse that interactive OAuth session.
- OAuth revocation and insufficient-scope checks against a real bot account. The HTTP/token failure
  paths are tested with deterministic provider responses; live account state is covered only by
  deployment canaries.

## Release gate

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. A scenario is complete only when
the tool ledger, task state, provider result, and user-visible response all agree.
