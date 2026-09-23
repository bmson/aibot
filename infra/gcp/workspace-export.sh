#!/usr/bin/env bash
# Run a read-only source snapshot in Cloud Run. The GitHub runner never sees DATABASE_URL.
set -euo pipefail

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT}"
REGION="${GCP_REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-assistant}"
SHA="${EXPORT_RELEASE_SHA:?Set EXPORT_RELEASE_SHA to the deployed commit}"
SOURCE_AGENT_ID="${MIGRATION_SOURCE_AGENT_ID:?Set MIGRATION_SOURCE_AGENT_ID}"
EMBEDDING_PROVIDER="${MIGRATION_EMBEDDING_PROVIDER:?Set MIGRATION_EMBEDDING_PROVIDER}"
EMBEDDING_MODEL="${MIGRATION_EMBEDDING_MODEL:?Set MIGRATION_EMBEDDING_MODEL}"
EMBEDDING_DIMENSIONS="${MIGRATION_EMBEDDING_DIMENSIONS:?Set MIGRATION_EMBEDDING_DIMENSIONS}"
EMBEDDING_REVISION="${MIGRATION_EMBEDDING_REVISION:?Set MIGRATION_EMBEDDING_REVISION}"
DATABASE_ID="${FIRESTORE_TARGET_DATABASE_ID:-(default)}"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'EXPORT_RELEASE_SHA must be a full commit SHA' >&2; exit 2; }
[[ "$SOURCE_AGENT_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo 'Invalid source agent ID' >&2; exit 2; }
[[ "$EMBEDDING_PROVIDER" =~ ^[a-zA-Z0-9._/-]+$ ]] || { echo 'Invalid embedding provider' >&2; exit 2; }
[[ "$EMBEDDING_MODEL" =~ ^[a-zA-Z0-9._/-]+$ ]] || { echo 'Invalid embedding model' >&2; exit 2; }
[[ "$EMBEDDING_DIMENSIONS" =~ ^[0-9]+$ ]] || { echo 'Invalid embedding dimensions' >&2; exit 2; }
[[ "$EMBEDDING_REVISION" =~ ^[a-zA-Z0-9._/-]+$ ]] || { echo 'Invalid embedding revision' >&2; exit 2; }
[[ "$DATABASE_ID" =~ ^[a-zA-Z0-9_()-]+$ ]] || { echo 'Invalid Firestore database ID' >&2; exit 2; }

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
[[ "$BUCKET" == "${PROJECT}-workspace" ]] || {
  echo 'Agent workspace bucket does not match the installation project' >&2; exit 1;
}
[[ "$WORKSPACE_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Unsafe workspace ID' >&2; exit 1; }

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

export GCP_PROJECT="$PROJECT" WORKSPACE_BUCKET="$BUCKET" ASSISTANT_WORKSPACE_ID="$WORKSPACE_ID"
export MIGRATION_SOURCE_AGENT_ID="$SOURCE_AGENT_ID" FIRESTORE_TARGET_DATABASE_ID="$DATABASE_ID"
export MIGRATION_EMBEDDING_PROVIDER="$EMBEDDING_PROVIDER" MIGRATION_EMBEDDING_MODEL="$EMBEDDING_MODEL"
export MIGRATION_EMBEDDING_DIMENSIONS="$EMBEDDING_DIMENSIONS" MIGRATION_EMBEDDING_REVISION="$EMBEDDING_REVISION"
env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
node -e '
  const fs = require("node:fs");
  const keys = ["GCP_PROJECT", "WORKSPACE_BUCKET", "ASSISTANT_WORKSPACE_ID",
    "MIGRATION_SOURCE_AGENT_ID", "FIRESTORE_TARGET_DATABASE_ID",
    "MIGRATION_EMBEDDING_PROVIDER", "MIGRATION_EMBEDDING_MODEL",
    "MIGRATION_EMBEDDING_DIMENSIONS", "MIGRATION_EMBEDDING_REVISION"];
  fs.writeFileSync(process.argv[1], keys.map((key) => key + ": " + JSON.stringify(process.env[key])).join("\n") + "\n");
' "$env_file"

job_args=(
  --project "$PROJECT" --region "$REGION" --image "$image"
  --service-account "assistant-agent@${PROJECT}.iam.gserviceaccount.com"
  --command pnpm '--args=--filter,@assistant/db,workspace-export-job'
  --env-vars-file "$env_file" --set-secrets DATABASE_URL=database-url:latest
  --memory 2Gi --cpu 2 --task-timeout 3600 --max-retries 0 --quiet
)
if gcloud run jobs describe assistant-workspace-export --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update assistant-workspace-export "${job_args[@]}"
else
  gcloud run jobs create assistant-workspace-export "${job_args[@]}"
fi
echo 'Running read-only workspace snapshot export in Cloud Run'
gcloud run jobs execute assistant-workspace-export --project "$PROJECT" --region "$REGION" --wait --quiet
echo 'Snapshot job completed; inspect its summary and object metadata before import'
