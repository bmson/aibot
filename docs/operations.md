# Operations

## Health endpoints

- `GET /health` on the agent is a liveness probe and does not touch dependencies.
- `GET /ready` on the agent checks PostgreSQL and reports secret-safe module readiness.
- `GET /api/health` on the web reports the released commit.
- `GET /api/ready` on the web checks PostgreSQL and returns 503 when traffic should stop.

Container and Cloud Run probes should use readiness endpoints. Alert on sustained 5xx responses,
queue age, tasks in `needs_attention`, expired approvals, webhook rejection rates, and budget
exhaustion. OpenTelemetry can be enabled centrally with `OTEL_EXPORTER=otlp`.

## Monitoring and alerting

`infra/gcp/deploy.sh` provisions a baseline automatically: a log-based metric
(`assistant-error-logs`) counting error-severity entries from every `assistant-*` service and job,
an email notification channel to `OWNER_EMAIL`, and an "Assistant error burst" alert policy
(more than 5 error logs in 5 minutes). The policy is created once and then left alone, so
threshold tuning in the console survives redeploys.

Traces cover model calls (`model.generate`/`model.step`/`model.object`), task execution
(`task.execute`), individual tool executions (`tool.execute`, with tool name, task, and step
attributes), and the nightly self-maintenance jobs. Locally, `OTEL_EXPORTER=console` prints spans
to stdout; `OTEL_EXPORTER=otlp` exports over OTLP/HTTP to whatever `OTEL_EXPORTER_OTLP_ENDPOINT`
points at.

## History retention

Messages, tool calls, model calls, and cost events are kept forever by default. To bound them, set
`HISTORY_RETENTION_DAYS` (minimum 30) and `COST_RETENTION_DAYS` (minimum 60 — budget caps count a
rolling month of spend, so pruning inside that window would quietly raise the limit). The sweep
prunes in batches of 1000 per run, so a large backlog drains gradually. Two kinds of rows outlive
their cutoff by design: messages anchoring a conversation-segment summary (the recall unit
references them), and tool calls still referenced by an approval or a retained cost event.

## Release artifacts

CI scans every selected container for HIGH/CRITICAL vulnerabilities, generates an SPDX JSON SBOM,
uploads SBOMs as workflow artifacts, and attaches keyless Cosign signatures and SBOM attestations to
the immutable image tags. Browser, code, and processor images are built only when their modules are
selected.

Verify a released image with Cosign:

```sh
cosign verify \
  --certificate-identity-regexp='https://github.com/ORG/REPO/.github/workflows/deploy.yml@refs/heads/main' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  REGION-docker.pkg.dev/PROJECT/REPOSITORY/agent:COMMIT_SHA
```

Dependency and action updates are proposed weekly through Dependabot. CI still runs audit, boundary,
type, test, build, and browser-smoke gates before deployment.
