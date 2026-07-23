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
CODE_SERVICE_ACCOUNT="assistant-code@${PROJECT}.iam.gserviceaccount.com"
PROCESSOR_SERVICE_ACCOUNT="assistant-processor@${PROJECT}.iam.gserviceaccount.com"
INTERNAL_INVOKER_SERVICE_ACCOUNT="assistant-internal-invoker@${PROJECT}.iam.gserviceaccount.com"

# ── release bookkeeping ──────────────────────────────────────────────────────
# Rollout steps below are attempted independently; failures are collected here
# and reported together at the end, and the release still exits non-zero.
#
# This used to be strictly fail-fast with the web rollout as its very LAST
# command. That pairing silently stranded the dashboard: an agent env var only
# deploy.sh sets, or one absent Cloud Scheduler job, aborted the script several
# steps before web was ever updated. The web image had been built, pushed, and
# tagged — production just went on serving the previous revision, and the only
# symptom was "my UI change didn't show up". Fail-fast is right for a gate that
# protects the thing being deployed (the migration below), and wrong for drift
# in a component that the next rollout does not depend on.
FAILURE_COUNT=0
FAILURE_LIST=""

record_failure() {
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  FAILURE_LIST="${FAILURE_LIST}  - ${1}"$'\n'
  printf '  ✗ %s\n' "$1" >&2
}

# Run one release step, recording rather than propagating its failure. Call as
# `step "label" fn args...` — errexit stays armed for everything outside these.
step() {
  local label="$1"
  shift
  echo "── ${label}"
  if "$@"; then
    return 0
  fi
  record_failure "$label"
  return 1
}

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
# made live. This one stays a hard gate on purpose: every rollout below assumes
# the schema is current, so there is nothing safe to continue to.
echo "Migrating and reconciling database defaults"
if gcloud run jobs describe assistant-migrate --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update assistant-migrate \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/agent:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --command pnpm --args=--filter,@assistant/db,reconcile \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
else
  gcloud run jobs create assistant-migrate \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/agent:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --command pnpm --args=--filter,@assistant/db,reconcile \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
fi
gcloud run jobs execute assistant-migrate --project "$PROJECT" --region "$REGION" --wait --quiet

# This script rolls images only; deploy.sh owns environment and provisioning.
# That split is silent by default: a commit that starts depending on a new env
# var, or on a Scheduler job deploy.sh creates, ships green here and fails in
# production. It has happened — the agent served every Gmail push a 403 for days
# because GMAIL_PUSH_SERVICE_ACCOUNT was only ever set by deploy.sh, while the
# gmail-sync job that would have masked it was silently skipped below. So this
# still blocks the agent rollout and still fails the release; it just no longer
# takes the unrelated web and job rollouts down with it.
verify_agent_configuration() {
  local required agent_env_names missing_env
  local -a REQUIRED_AGENT_ENV
  REQUIRED_AGENT_ENV=(
    AGENT_URL
    BROWSER_JOB_NAME
    CLOUD_TASKS_QUEUE
    CODE_JOB_NAME
    GCP_LOCATION
    GCP_PROJECT
    GMAIL_PUBSUB_TOPIC
    GMAIL_PUSH_SERVICE_ACCOUNT
    INTERNAL_AUTH_MODE
    INTERNAL_OIDC_AUDIENCE
    INTERNAL_OIDC_SERVICE_ACCOUNT
    OWNER_EMAIL
    PROCESSOR_DRIVER
    PROCESSOR_JOB_NAME
    PUBLIC_URL
    QUEUE_DRIVER
    WORKSPACE_BUCKET
  )
  # env[].name yields names only, semicolon separated — never the values, so this
  # stays safe to run with the release log attached to a public build.
  agent_env_names="$(gcloud run services describe assistant-agent \
    --project "$PROJECT" --region "$REGION" \
    --format='value(spec.template.spec.containers[0].env[].name)' | tr ';' '\n')" || return 1
  # Accumulated as a string, not an array: `${#arr[@]}` on an empty array is an
  # unbound-variable error under `set -u` in bash 3.2, which is still what
  # /bin/bash is on macOS — and a release script must not fail differently
  # depending on whose machine runs it.
  missing_env=""
  for required in "${REQUIRED_AGENT_ENV[@]}"; do
    grep -Fxq -- "$required" <<<"$agent_env_names" || missing_env="${missing_env}    - ${required}"$'\n'
  done
  if [[ -n "$missing_env" ]]; then
    echo "  assistant-agent is missing required environment variables:" >&2
    printf '%s' "$missing_env" >&2
    echo "  These are provisioned by infra/gcp/deploy.sh. Run it, then re-run this release." >&2
    return 1
  fi
  return 0
}

# A pinned traffic split is the quiet way a Cloud Run service stops tracking its
# own releases: once traffic points at a named revision (a manual rollback is
# the usual cause), every later `services update --image` creates a revision
# that receives 0% of requests. The release reads clean and the site never
# changes. Re-assert latest on each rollout so a pin cannot outlive one release.
roll_out_service() {
  local service="$1" image="$2"
  gcloud run services update "$service" \
    --project "$PROJECT" --region "$REGION" \
    --image "$image" --quiet || return 1
  gcloud run services update-traffic "$service" \
    --project "$PROJECT" --region "$REGION" --to-latest --quiet || return 1
}

# Scheduler jobs call protected internal endpoints. Keep their authentication
# route-scoped and self-healing on every release so an old static header cannot
# strand retries or silently weaken the boundary after an infrastructure change.
refresh_scheduler_oidc() {
  local agent_url="$1"
  local job_spec job_name job_path describe_output missing_jobs
  missing_jobs=""
  for job_spec in \
    'assistant-sweep:/internal/sweep' \
    'assistant-gmail-sync:/internal/gmail/sync' \
    'assistant-gmail-watch:/internal/gmail/watch' \
    'assistant-canaries:/internal/canaries/run' \
    'assistant-canary-health:/internal/canaries/health'; do
    job_name="${job_spec%%:*}"
    job_path="${job_spec#*:}"
    # A job that does not exist is drift, not a no-op to skip past: these carry the
    # mailbox poll and the canaries, so a missing one removes the very signal that
    # would report it missing.
    if ! describe_output="$(gcloud scheduler jobs describe "$job_name" \
      --project "$PROJECT" --location "$REGION" 2>&1)"; then
      if grep -Eqi 'NOT_FOUND|not found|does not exist' <<<"$describe_output"; then
        missing_jobs="${missing_jobs}    - ${job_name}"$'\n'
        continue
      fi
      echo "  Unable to inspect Cloud Scheduler job ${job_name}:" >&2
      printf '%s\n' "$describe_output" >&2
      return 1
    fi
    gcloud scheduler jobs update http "$job_name" --project "$PROJECT" --location "$REGION" \
      --uri="${agent_url}${job_path}" --http-method=POST --attempt-deadline=300s \
      --max-retry-attempts=0 --clear-headers \
      --oidc-service-account-email="$INTERNAL_INVOKER_SERVICE_ACCOUNT" \
      --oidc-token-audience="${agent_url}${job_path}" --quiet || return 1
  done
  if [[ -n "$missing_jobs" ]]; then
    echo "  Expected Cloud Scheduler jobs are absent:" >&2
    printf '%s' "$missing_jobs" >&2
    echo "  These are created by infra/gcp/deploy.sh. Run it, then re-run this release." >&2
    return 1
  fi
  return 0
}

# Roll a Cloud Run job that deploy.sh owns. `optional` jobs (assistant-code,
# assistant-processor) may not exist yet on the first release after they land,
# so an absent one is reported and skipped; assistant-browser is long since
# provisioned, so its absence is drift and fails the release.
roll_out_job() {
  local job="$1" image="$2" service_account="$3" presence="${4:-required}"
  if ! gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
    if [[ "$presence" == "optional" ]]; then
      echo "  ${job} not provisioned yet — run infra/gcp/deploy.sh; skipping"
      return 0
    fi
    echo "  ${job} does not exist. It is created by infra/gcp/deploy.sh." >&2
    return 1
  fi
  gcloud run jobs update "$job" \
    --project "$PROJECT" --region "$REGION" \
    --image "$image" --service-account "$service_account" --quiet || return 1
}

# The proof that the release actually landed. Everything above reports on the
# control plane's behalf ("the update call succeeded"); this asks the running
# site which commit it is serving. It is what turns a stranded web rollout from
# an invisible non-event into a red release.
verify_web_serving_release() {
  local url payload sha attempt
  url="$(gcloud run services describe assistant-web \
    --project "$PROJECT" --region "$REGION" --format='value(status.url)')" || return 1
  if [[ -z "$url" ]]; then
    echo "  could not resolve the assistant-web URL" >&2
    return 1
  fi
  sha=""
  for attempt in $(seq 1 30); do
    payload="$(curl --fail --silent --max-time 10 "${url}/api/health")" || payload=""
    sha="$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' <<<"$payload")"
    if [[ "$sha" == "$TAG" ]]; then
      echo "  assistant-web is serving ${TAG}"
      return 0
    fi
    sleep 5
  done
  echo "  assistant-web reports '${sha:-no sha}' after the rollout, expected '${TAG}'." >&2
  echo "  The new revision exists but is not the one serving traffic. Inspect with:" >&2
  echo "    gcloud run services describe assistant-web --region ${REGION} --format='value(status.traffic)'" >&2
  return 1
}

# ── rollout ──────────────────────────────────────────────────────────────────
# Agent first (web calls it, so this is the ordering that minimises API skew),
# then web, then the reconciliation tail. Independent, so the tail cannot strand
# either service the way it used to.
if step "Verifying agent configuration" verify_agent_configuration; then
  step "Rolling out agent" roll_out_service assistant-agent "${IMAGE_ROOT}/agent:${TAG}" || true
else
  record_failure "Rolling out agent (skipped — configuration unverified)"
fi

step "Rolling out web" roll_out_service assistant-web "${IMAGE_ROOT}/web:${TAG}" || true

AGENT_URL="$(gcloud run services describe assistant-agent --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
if [[ -n "$AGENT_URL" ]]; then
  step "Refreshing internal scheduler OIDC" refresh_scheduler_oidc "$AGENT_URL" || true
else
  record_failure "Refreshing internal scheduler OIDC (could not resolve the agent URL)"
fi

step "Rolling out browser job" \
  roll_out_job assistant-browser "${IMAGE_ROOT}/browser:${TAG}" "$BROWSER_SERVICE_ACCOUNT" required || true
step "Rolling out code job" \
  roll_out_job assistant-code "${IMAGE_ROOT}/code:${TAG}" "$CODE_SERVICE_ACCOUNT" optional || true
step "Rolling out document processor job" \
  roll_out_job assistant-processor "${IMAGE_ROOT}/processor:${TAG}" "$PROCESSOR_SERVICE_ACCOUNT" optional || true

step "Verifying assistant-web serves ${TAG}" verify_web_serving_release || true

if (( FAILURE_COUNT )); then
  echo "" >&2
  echo "Release ${TAG} finished with ${FAILURE_COUNT} failed step(s):" >&2
  printf '%s' "$FAILURE_LIST" >&2
  echo "Steps not listed above did complete — re-running this release is safe." >&2
  exit 1
fi

echo "Release ${TAG} is live"
gcloud run services describe assistant-web \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)'
