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

echo "Building release ${TAG}"
gcloud builds submit . \
  --project "$PROJECT" \
  --config infra/gcp/cloudbuild.yaml \
  --substitutions "_REGION=${REGION},_REPO=${REPO},_TAG=${TAG}" \
  --quiet

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

echo "Rolling out agent"
gcloud run services update assistant-agent \
  --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE_ROOT}/agent:${TAG}" --quiet

echo "Rolling out browser job"
gcloud run jobs update assistant-browser \
  --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE_ROOT}/browser:${TAG}" --quiet

echo "Rolling out web"
gcloud run services update assistant-web \
  --project "$PROJECT" --region "$REGION" \
  --image "${IMAGE_ROOT}/web:${TAG}" --quiet

echo "Release ${TAG} is live"
gcloud run services describe assistant-web \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)'
