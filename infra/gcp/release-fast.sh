#!/usr/bin/env bash
# Fast single-service release for day-to-day iteration:
#   bash infra/gcp/release-fast.sh web
#   bash infra/gcp/release-fast.sh agent
#
# Builds ONE image, rolls out ONE service, and verifies the rollout. It skips
# the database backup, the migration job, and every unrelated image, which is
# what makes it fast — so it is only safe when the change cannot have touched
# the schema (packages/db), seed data, or environment/provisioning. When in
# doubt, use infra/gcp/release.sh; it stays the source of truth for releases.
set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  web|agent) ;;
  *)
    echo "usage: bash infra/gcp/release-fast.sh [web|agent]" >&2
    echo "" >&2
    echo "Builds and rolls out a single service without backup or migration." >&2
    echo "Use infra/gcp/release.sh instead when the schema, seed data, or" >&2
    echo "environment variables changed." >&2
    exit 2
    ;;
esac

# Resolve the project the same way deploy.sh does: an explicit shell variable
# wins, then the repo .env, then the gcloud CLI's configured project. Reading
# .env here means the fast path works from the same file the full provisioner
# uses, with nothing extra to export.
ENV_FILE="${ASSISTANT_ENV_FILE:-.env}"
envval() {
  [ -f "$ENV_FILE" ] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | head -1 | cut -d= -f2-
}
PROJECT="${GCP_PROJECT:-$(envval GCP_PROJECT)}"
if [ -z "$PROJECT" ]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
fi
[ -n "$PROJECT" ] || { echo "Set GCP_PROJECT in ${ENV_FILE}, your shell, or gcloud config" >&2; exit 1; }
REGION="${GCP_REGION:-$(envval GCP_LOCATION)}"
REGION="${REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-$(envval ARTIFACT_REPOSITORY)}"
REPO="${REPO:-assistant}"
TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"

if [[ ! "$TAG" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "IMAGE_TAG may contain only letters, digits, '.', '_' and '-'." >&2
  exit 2
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${TARGET}:${TAG}"
SERVICE="assistant-${TARGET}"

echo "── building ${TARGET}:${TAG} (single image)"
gcloud builds submit . \
  --project "$PROJECT" \
  --config "infra/gcp/cloudbuild-${TARGET}.yaml" \
  --substitutions "^@@^_REGION=${REGION}@@_REPO=${REPO}@@_TAG=${TAG}" \
  --quiet

echo "── rolling out ${SERVICE}"
gcloud run services update "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" --quiet
# Re-assert latest so a pinned traffic split cannot outlive the rollout.
gcloud run services update-traffic "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --to-latest --quiet

if [[ "$TARGET" == "web" ]]; then
  echo "── verifying ${SERVICE} serves ${TAG}"
  URL="$(gcloud run services describe "$SERVICE" \
    --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
  SHA=""
  for _attempt in $(seq 1 30); do
    PAYLOAD="$(curl --fail --silent --max-time 10 "${URL}/api/health")" || PAYLOAD=""
    SHA="$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' <<<"$PAYLOAD")"
    if [[ "$SHA" == "$TAG" ]]; then
      echo "   ${SERVICE} is serving ${TAG}"
      break
    fi
    sleep 5
  done
  if [[ "$SHA" != "$TAG" ]]; then
    echo "  ${SERVICE} reports '${SHA:-no sha}', expected '${TAG}'." >&2
    echo "  The new revision exists but is not serving traffic. Inspect with:" >&2
    echo "    gcloud run services describe ${SERVICE} --region ${REGION} --format='value(status.traffic)'" >&2
    exit 1
  fi
fi

echo ""
echo "${SERVICE} ${TAG} is live"
gcloud run services describe "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)'
