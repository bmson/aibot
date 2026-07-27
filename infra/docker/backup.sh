#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
: "${BACKUP_WORKSPACE_ID:?BACKUP_WORKSPACE_ID is required}"
: "${BACKUP_RELEASE:?BACKUP_RELEASE is required}"

backup_file="/tmp/assistant-${BACKUP_RELEASE}.dump"
object_name="workspace/${BACKUP_WORKSPACE_ID}/backups/pre-migration/${BACKUP_RELEASE}.dump"
encoded_object="${object_name//\//%2F}"

echo "Creating a consistent pre-migration PostgreSQL backup"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$backup_file"

token="$(
  curl --fail --silent --show-error \
    -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' |
    sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
)"
[ -n "$token" ] || { echo "Could not obtain a Google access token" >&2; exit 1; }

curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@${backup_file}" \
  "https://storage.googleapis.com/upload/storage/v1/b/${BACKUP_BUCKET}/o?uploadType=media&name=${encoded_object}" \
  >/dev/null

sha256sum "$backup_file"
echo "Backup stored at gs://${BACKUP_BUCKET}/${object_name}"
