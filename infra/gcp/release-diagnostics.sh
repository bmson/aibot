#!/usr/bin/env bash

# Execute the migration gate while retaining the exact Cloud Run execution
# name for bounded failure diagnostics. PROJECT and REGION are supplied by
# release.sh (or by the focused shell tests).
run_migration_job() {
  local output execution status
  output="$(mktemp "${TMPDIR:-/tmp}/assistant-migration.XXXXXX")"

  # Keep the normal gcloud output intact, but retain it long enough to extract
  # the execution that failed. Do not ask gcloud to print the job environment;
  # the job contains DATABASE_URL via Secret Manager.
  if gcloud run jobs execute assistant-migrate \
    --project "$PROJECT" --region "$REGION" --wait --quiet >"$output" 2>&1; then
    status=0
  else
    status=$?
  fi
  if (( status == 0 )); then
    cat "$output"
    rm -f "$output"
    return 0
  fi

  cat "$output" >&2
  execution="$(sed -nE 's/.*gcloud run jobs executions describe ([A-Za-z0-9][A-Za-z0-9-]*).*/\1/p' "$output" | tail -n 1)"
  if [[ ! "$execution" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]]; then
    echo "  Migration failed, but gcloud did not return a usable execution name; skipping diagnostics." >&2
    rm -f "$output"
    return "$status"
  fi

  echo "  Migration execution ${execution} failed; collecting bounded diagnostics." >&2
  if ! gcloud run jobs executions describe "$execution" \
    --project "$PROJECT" --region "$REGION" \
    --format='yaml(metadata.name,status.conditions,status.failedCount,status.logUri)' >&2; then
    echo "  Could not describe migration execution ${execution}." >&2
  fi

  # Cloud Run labels each job log entry with its execution name. Limit the
  # query to recent ERROR entries and print fields useful for diagnosis only.
  # A missing Logging Viewer permission must not hide the original failure.
  if ! gcloud run jobs logs read assistant-migrate \
    --project "$PROJECT" --region "$REGION" --freshness=15m --limit=50 \
    --log-filter="severity>=ERROR AND labels.\"run.googleapis.com/execution_name\"=\"${execution}\"" \
    --format='value(timestamp,severity,textPayload,jsonPayload.message)' >&2; then
    echo "  Could not read logs for migration execution ${execution}." >&2
  fi

  rm -f "$output"
  return "$status"
}
