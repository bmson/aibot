#!/usr/bin/env bash
# Import a pinned private snapshot inside Cloud Run using the customer runtime identity.
set -euo pipefail

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT}"
REGION="${GCP_REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-assistant}"
SHA="${IMPORT_RELEASE_SHA:?Set IMPORT_RELEASE_SHA to the deployed commit}"
SOURCE_AGENT_ID="${MIGRATION_SOURCE_AGENT_ID:?Set MIGRATION_SOURCE_AGENT_ID}"
DATABASE_ID="${FIRESTORE_TARGET_DATABASE_ID:?Set FIRESTORE_TARGET_DATABASE_ID}"
MODE="${MIGRATION_IMPORT_MODE:-preview}"
SNAPSHOT_URI="${MIGRATION_SNAPSHOT_URI:?Set MIGRATION_SNAPSHOT_URI}"
SNAPSHOT_GENERATION="${MIGRATION_SNAPSHOT_GENERATION:?Set MIGRATION_SNAPSHOT_GENERATION}"
SNAPSHOT_SHA256="${MIGRATION_SNAPSHOT_SHA256:?Set MIGRATION_SNAPSHOT_SHA256}"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'IMPORT_RELEASE_SHA must be a full commit SHA' >&2; exit 2; }
[[ "$SOURCE_AGENT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || { echo 'Invalid source agent ID' >&2; exit 2; }
[[ "$DATABASE_ID" =~ ^[a-zA-Z0-9_()-]+$ ]] || { echo 'Invalid Firestore database ID' >&2; exit 2; }
[[ "$MODE" == preview || "$MODE" == write || "$MODE" == verify ]] || { echo 'Invalid import mode' >&2; exit 2; }
[[ "$SNAPSHOT_GENERATION" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid snapshot generation' >&2; exit 2; }
[[ "$SNAPSHOT_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'Invalid snapshot SHA-256' >&2; exit 2; }

agent_service="$(gcloud run services describe assistant-agent --project "$PROJECT" --region "$REGION" --format=json)"
agent_env_value() {
  printf '%s' "$agent_service" | node -e '
    const fs = require("node:fs");
    const service = JSON.parse(fs.readFileSync(0, "utf8"));
    const env = service.spec?.template?.spec?.containers?.[0]?.env ?? [];
    process.stdout.write(String(env.find((item) => item.name === process.argv[1])?.value ?? ""));
  ' "$1"
}
BUCKET="$(agent_env_value WORKSPACE_BUCKET)"
WORKSPACE_ID="$(agent_env_value ASSISTANT_WORKSPACE_ID)"
WORKSPACE_ID="${WORKSPACE_ID:-assistant}"
[[ "$BUCKET" == "${PROJECT}-workspace" ]] || { echo 'Agent workspace bucket does not match project' >&2; exit 1; }
[[ "$WORKSPACE_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Unsafe workspace ID' >&2; exit 1; }
[[ "$SNAPSHOT_URI" == "gs://${BUCKET}/workspace/${WORKSPACE_ID}/migration/snapshots/"*.json ]] || {
  echo 'Snapshot is outside this installation workspace' >&2; exit 2;
}

image="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/migrate:${SHA}"
deployed_image="$(gcloud run jobs describe assistant-migrate --project "$PROJECT" --region "$REGION" --format=json |
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    const find = (node) => {
      if (!node || typeof node !== "object") return "";
      if (Array.isArray(node.containers)) return node.containers[0]?.image ?? "";
      return Object.values(node).map(find).find(Boolean) ?? "";
    };
    process.stdout.write(find(value));
  ' )"
[[ "$deployed_image" == "$image" ]] || {
  echo 'The released migration job does not use the requested commit image' >&2; exit 1;
}

export GCP_PROJECT="$PROJECT" ASSISTANT_WORKSPACE_ID="$WORKSPACE_ID"
export MIGRATION_SOURCE_AGENT_ID="$SOURCE_AGENT_ID" FIRESTORE_TARGET_DATABASE_ID="$DATABASE_ID"
export MIGRATION_IMPORT_MODE="$MODE" MIGRATION_SNAPSHOT_URI="$SNAPSHOT_URI"
export MIGRATION_SNAPSHOT_GENERATION="$SNAPSHOT_GENERATION" MIGRATION_SNAPSHOT_SHA256="$SNAPSHOT_SHA256"
env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
node -e '
  const fs = require("node:fs");
  const keys = ["GCP_PROJECT", "ASSISTANT_WORKSPACE_ID", "MIGRATION_SOURCE_AGENT_ID",
    "FIRESTORE_TARGET_DATABASE_ID", "MIGRATION_IMPORT_MODE", "MIGRATION_SNAPSHOT_URI",
    "MIGRATION_SNAPSHOT_GENERATION", "MIGRATION_SNAPSHOT_SHA256"];
  fs.writeFileSync(process.argv[1], keys.map((key) => key + ": " + JSON.stringify(process.env[key])).join("\n") + "\n");
' "$env_file"

job_args=(
  --project "$PROJECT" --region "$REGION" --image "$image"
  --service-account "assistant-agent@${PROJECT}.iam.gserviceaccount.com"
  --command pnpm '--args=--filter,@assistant/firestore,workspace-import-job'
  --env-vars-file "$env_file"
  --memory 4Gi --cpu 2 --task-timeout 7200 --max-retries 0 --quiet
)
if gcloud run jobs describe assistant-workspace-import --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update assistant-workspace-import "${job_args[@]}"
else
  gcloud run jobs create assistant-workspace-import "${job_args[@]}"
fi
echo "Running ${MODE} for pinned workspace snapshot inside Cloud Run"
gcloud run jobs execute assistant-workspace-import --project "$PROJECT" --region "$REGION" --wait --quiet
echo "Workspace ${MODE} completed; inspect job summary and source-to-target parity"
