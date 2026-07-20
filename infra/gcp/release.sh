#!/usr/bin/env bash
# Normal production release: build one immutable image set and roll it out to
# the already-provisioned Cloud Run services/job. One-time IAM, secrets,
# networking, Scheduler, and Pub/Sub setup remains in deploy.sh.
set -euo pipefail

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
REGION="${GCP_REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-assistant}"
TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"

if [[ ! "$TAG" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "IMAGE_TAG may contain only letters, digits, '.', '_' and '-'." >&2
  exit 2
fi

IMAGE_ROOT="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
AGENT_SERVICE_ACCOUNT="assistant-agent@${PROJECT}.iam.gserviceaccount.com"
BROWSER_SERVICE_ACCOUNT="assistant-browser@${PROJECT}.iam.gserviceaccount.com"
INTERNAL_INVOKER_SERVICE_ACCOUNT="assistant-internal-invoker@${PROJECT}.iam.gserviceaccount.com"

if [[ "${SKIP_IMAGE_BUILD:-false}" != "true" ]]; then
  echo "Building release ${TAG} with Cloud Build"
  gcloud builds submit . \
    --project "$PROJECT" \
    --config infra/gcp/cloudbuild.yaml \
    --substitutions "_REGION=${REGION},_REPO=${REPO},_TAG=${TAG}" \
    --quiet
else
  echo "Using pre-built release images ${TAG}"
fi

# Migrations run in a short-lived Cloud Run Job with the agent's existing
# database-secret access. The GitHub deployer never receives the database URL,
# and a failed migration stops the release before any new service revision is
# made live.
echo "Migrating database"
if gcloud run jobs describe assistant-migrate --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update assistant-migrate \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/agent:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --command pnpm --args=--filter,@assistant/db,migrate \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
else
  gcloud run jobs create assistant-migrate \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/agent:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --command pnpm --args=--filter,@assistant/db,migrate \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
fi
gcloud run jobs execute assistant-migrate --project "$PROJECT" --region "$REGION" --wait --quiet

# This script rolls images only; deploy.sh owns environment and provisioning.
# That split is silent by default: a commit that starts depending on a new env
# var, or on a Scheduler job deploy.sh creates, ships green here and fails in
# production. It has happened — the agent served every Gmail push a 403 for days
# because GMAIL_PUSH_SERVICE_ACCOUNT was only ever set by deploy.sh, while the
# gmail-sync job that would have masked it was silently skipped below. Fail the
# release instead, and say which script to run.
echo "Verifying agent configuration"
REQUIRED_AGENT_ENV=(
  GMAIL_PUBSUB_TOPIC
  GMAIL_PUSH_SERVICE_ACCOUNT
  INTERNAL_AUTH_MODE
  INTERNAL_OIDC_SERVICE_ACCOUNT
  OWNER_EMAIL
  PUBLIC_URL
  QUEUE_DRIVER
)
# env[].name yields names only, semicolon separated — never the values, so this
# stays safe to run with the release log attached to a public build.
AGENT_ENV_NAMES="$(gcloud run services describe assistant-agent \
  --project "$PROJECT" --region "$REGION" \
  --format='value(spec.template.spec.containers[0].env[].name)' | tr ';' '\n')"
MISSING_ENV=()
for REQUIRED in "${REQUIRED_AGENT_ENV[@]}"; do
  grep -Fxq -- "$REQUIRED" <<<"$AGENT_ENV_NAMES" || MISSING_ENV+=("$REQUIRED")
done
if (( ${#MISSING_ENV[@]} )); then
  echo "Refusing to release: assistant-agent is missing required environment variables:" >&2
  printf '  - %s\n' "${MISSING_ENV[@]}" >&2
  echo "These are provisioned by infra/gcp/deploy.sh. Run it, then re-run this release." >&2
  exit 1
fi

echo "Rolling out agent"
gcloud run services update assistant-agent \
  --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE_ROOT}/agent:${TAG}" --quiet

# Scheduler jobs call protected internal endpoints. Keep their authentication
# route-scoped and self-healing on every release so an old static header cannot
# strand retries or silently weaken the boundary after an infrastructure change.
AGENT_URL="$(gcloud run services describe assistant-agent --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo "Refreshing internal scheduler OIDC"
MISSING_JOBS=()
for JOB_SPEC in \
  'assistant-sweep:/internal/sweep' \
  'assistant-gmail-sync:/internal/gmail/sync' \
  'assistant-gmail-watch:/internal/gmail/watch' \
  'assistant-canaries:/internal/canaries/run' \
  'assistant-canary-health:/internal/canaries/health'; do
  JOB_NAME="${JOB_SPEC%%:*}"
  JOB_PATH="${JOB_SPEC#*:}"
  # A job that does not exist is drift, not a no-op to skip past: these carry the
  # mailbox poll and the canaries, so a missing one removes the very signal that
  # would report it missing.
  if ! gcloud scheduler jobs describe "$JOB_NAME" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    MISSING_JOBS+=("$JOB_NAME")
    continue
  fi
  gcloud scheduler jobs update http "$JOB_NAME" --project "$PROJECT" --location "$REGION" \
    --uri="${AGENT_URL}${JOB_PATH}" --http-method=POST --attempt-deadline=300s \
    --max-retry-attempts=0 --clear-headers \
    --oidc-service-account-email="$INTERNAL_INVOKER_SERVICE_ACCOUNT" \
    --oidc-token-audience="${AGENT_URL}${JOB_PATH}" --quiet
done
if (( ${#MISSING_JOBS[@]} )); then
  echo "Refusing to finish release: expected Cloud Scheduler jobs are absent:" >&2
  printf '  - %s\n' "${MISSING_JOBS[@]}" >&2
  echo "These are created by infra/gcp/deploy.sh. Run it, then re-run this release." >&2
  exit 1
fi

echo "Rolling out browser job"
gcloud run jobs update assistant-browser \
  --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE_ROOT}/browser:${TAG}" \
  --service-account "$BROWSER_SERVICE_ACCOUNT" --quiet

echo "Rolling out web"
gcloud run services update assistant-web \
  --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE_ROOT}/web:${TAG}" --quiet

echo "Release ${TAG} is live"
gcloud run services describe assistant-web \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)'
