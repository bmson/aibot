# Operations

## Health endpoints

- `GET /health` on the agent is a liveness probe and does not touch dependencies.
- `GET /ready` on the agent checks PostgreSQL and reports secret-safe module readiness.
- `GET /api/health` on the web reports the released commit.
- `GET /api/ready` on the web checks PostgreSQL and returns 503 when traffic should stop.

Container and Cloud Run probes should use readiness endpoints. Alert on sustained 5xx responses,
queue age, tasks in `needs_attention`, expired approvals, webhook rejection rates, and budget
exhaustion. OpenTelemetry can be enabled centrally with `OTEL_EXPORTER=otlp`.

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
