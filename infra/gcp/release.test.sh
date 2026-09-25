#!/usr/bin/env bash
# Offline tests for release-path selection, the deploy.sh Firestore guard, and
# the Firestore release. gcloud, pnpm, and curl are stubs; nothing leaves the
# machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/assistant-release-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/dispatch"

export GCP_PROJECT="test-project"
export GCP_REGION="test-region"
export STUB_CALLS="$TEST_ROOT/calls"

# ── stubs ────────────────────────────────────────────────────────────────────
cat >"$TEST_ROOT/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
set -u
printf 'gcloud %s\n' "$*" >>"$STUB_CALLS"
args="$*"

service_json() {
  local driver="$1" extra="${2:-}" env='[]'
  local names="AGENT_URL BROWSER_JOB_NAME CLOUD_TASKS_QUEUE CODE_JOB_NAME FIRESTORE_AGENT_ID FIRESTORE_EMBEDDING_SPACE GCP_LOCATION GCP_PROJECT GMAIL_PUBSUB_TOPIC GMAIL_PUSH_SERVICE_ACCOUNT INTERNAL_AUTH_MODE INTERNAL_OIDC_AUDIENCE INTERNAL_OIDC_SERVICE_ACCOUNT OWNER_EMAIL PROCESSOR_DRIVER PROCESSOR_JOB_NAME PUBLIC_URL QUEUE_DRIVER WORKSPACE_BUCKET"
  env="["
  for name in $names; do env="${env}{\"name\":\"${name}\",\"value\":\"x\"},"; done
  env="${env}{\"name\":\"ASSISTANT_MODULES\",\"value\":\"${STUB_MODULES:-google,browser}\"},"
  env="${env}{\"name\":\"FIRESTORE_DATABASE_ID\",\"value\":\"${STUB_DATABASE:-assistant-production}\"}"
  if [[ -n "$driver" ]]; then env="${env},{\"name\":\"PERSISTENCE_DRIVER\",\"value\":\"${driver}\"}"; fi
  if [[ -n "$extra" ]]; then env="${env},${extra}"; fi
  env="${env}]"
  printf '{"metadata":{"name":"svc"},"status":{"url":"https://svc.example"},"spec":{"template":{"spec":{"containers":[{"env":%s}]}}}}\n' "$env"
}

case "$args" in
  *'run services describe assistant-agent'*'value(metadata.name)'*)
    if [[ "${STUB_AGENT_DESCRIBE:-ok}" == "missing" ]]; then echo 'ERROR: Service [assistant-agent] could not be found.' >&2; exit 1; fi
    if [[ "${STUB_AGENT_DESCRIBE:-ok}" == "denied" ]]; then echo 'ERROR: PERMISSION_DENIED' >&2; exit 1; fi
    echo assistant-agent ;;
  *'run services describe assistant-agent'*'env[].name'*)
    echo 'AGENT_URL;BROWSER_JOB_NAME;CLOUD_TASKS_QUEUE;CODE_JOB_NAME;FIRESTORE_AGENT_ID;FIRESTORE_DATABASE_ID;FIRESTORE_EMBEDDING_SPACE;GCP_LOCATION;GCP_PROJECT;GMAIL_PUBSUB_TOPIC;GMAIL_PUSH_SERVICE_ACCOUNT;INTERNAL_AUTH_MODE;INTERNAL_OIDC_AUDIENCE;INTERNAL_OIDC_SERVICE_ACCOUNT;OWNER_EMAIL;PERSISTENCE_DRIVER;PROCESSOR_DRIVER;PROCESSOR_JOB_NAME;PUBLIC_URL;QUEUE_DRIVER;WORKSPACE_BUCKET' ;;
  *'run services describe'*'value(status.url)'*) echo 'https://svc.example' ;;
  *'run services describe assistant-agent'*'--format=json'*)
    service_json "${STUB_AGENT_DRIVER-firestore}" "${STUB_AGENT_EXTRA_ENV:-}" ;;
  *'run services describe assistant-web'*'--format=json'*)
    service_json "${STUB_WEB_DRIVER-firestore}" ;;
  *'firestore databases describe'*)
    if [[ "${STUB_PITR:-on}" == "on" ]]; then
      echo '{"pointInTimeRecoveryEnablement":"POINT_IN_TIME_RECOVERY_ENABLED","earliestVersionTime":"2026-09-17T00:00:00Z","versionRetentionPeriod":"604800s"}'
    else
      echo '{"pointInTimeRecoveryEnablement":"POINT_IN_TIME_RECOVERY_DISABLED"}'
    fi ;;
  *'firestore backups list'*)
    snapshot="$(node -e 'process.stdout.write(new Date(Date.now() - Number(process.argv[1]) * 3600000).toISOString())' "${STUB_BACKUP_AGE_HOURS:-2}")"
    printf '[{"name":"projects/test-project/locations/us/backups/b1","database":"projects/test-project/databases/assistant-production","state":"READY","snapshotTime":"%s"}]\n' "$snapshot" ;;
  *'scheduler jobs describe'*) echo 'name: job' ;;
  *'scheduler jobs update'*) ;;
  *'run services update'*) ;;
  *'run jobs describe assistant-browser'*'--format=json'*)
    extra=''
    if [[ "${STUB_JOB_DB:-0}" == "1" ]]; then
      extra=',{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"database-url","key":"latest"}}}'
    fi
    printf '{"spec":{"template":{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"X","value":"y"}%s]}]}}}}}}\n' "$extra" ;;
  *'run jobs describe assistant-browser'*) ;;
  *'run jobs update'*) ;;
  *)
    echo "unexpected gcloud call: $args" >&2
    exit 99 ;;
esac
STUB

cat >"$TEST_ROOT/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
printf 'pnpm %s\n' "$*" >>"$STUB_CALLS"
exit "${STUB_INDEX_STATUS:-0}"
STUB

cat >"$TEST_ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$STUB_CALLS"
printf '{"ok":true,"service":"web","sha":"%s"}' "$IMAGE_TAG"
STUB
chmod +x "$TEST_ROOT/bin/gcloud" "$TEST_ROOT/bin/pnpm" "$TEST_ROOT/bin/curl"
export PATH="$TEST_ROOT/bin:$PATH"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

reset() {
  : >"$STUB_CALLS"
  unset STUB_AGENT_DRIVER STUB_WEB_DRIVER STUB_AGENT_EXTRA_ENV STUB_PITR STUB_BACKUP_AGE_HOURS \
    STUB_INDEX_STATUS STUB_JOB_DB STUB_AGENT_DESCRIBE RELEASE_PERSISTENCE_DRIVER
}

# ── release.sh selects the path from the live services ──────────────────────
cp "$ROOT/release.sh" "$ROOT/release-persistence.sh" "$TEST_ROOT/dispatch/"
printf '#!/usr/bin/env bash\necho SELECTED:postgres\n' >"$TEST_ROOT/dispatch/release-postgres.sh"
printf '#!/usr/bin/env bash\necho SELECTED:firestore\n' >"$TEST_ROOT/dispatch/release-firestore.sh"

dispatch() {
  bash "$TEST_ROOT/dispatch/release.sh" 2>&1
}

reset
export STUB_AGENT_DRIVER='' STUB_WEB_DRIVER=''
out="$(dispatch)" || fail "unset drivers should release"
grep -q 'SELECTED:postgres' <<<"$out" || fail "unset PERSISTENCE_DRIVER must select the PostgreSQL path: $out"

reset
export STUB_AGENT_DRIVER=firestore STUB_WEB_DRIVER=firestore
out="$(dispatch)" || fail "firestore services should release"
grep -q 'SELECTED:firestore' <<<"$out" || fail "firestore services must select the Firestore path: $out"

reset
export STUB_AGENT_DRIVER=firestore STUB_WEB_DRIVER=postgres
if out="$(dispatch)"; then fail "mixed services must not release"; fi
grep -q 'SELECTED' <<<"$out" && fail "mixed services started a release path"
grep -q 'cutover is in progress' <<<"$out" || fail "mixed services need an explanation: $out"

reset
export STUB_AGENT_DRIVER=postgres STUB_WEB_DRIVER=postgres RELEASE_PERSISTENCE_DRIVER=firestore
if out="$(dispatch)"; then fail "an explicit flag contradicting the live services must stop"; fi
grep -q 'SELECTED' <<<"$out" && fail "a contradicted flag started a release path"

reset
export STUB_AGENT_DRIVER=postgres STUB_WEB_DRIVER=postgres RELEASE_PERSISTENCE_DRIVER=postgres
out="$(dispatch)" || fail "matching explicit flag should release"
grep -q 'SELECTED:postgres' <<<"$out" || fail "explicit postgres must select PostgreSQL: $out"

reset
export RELEASE_PERSISTENCE_DRIVER=mysql
set +e
dispatch >/dev/null
status=$?
set -e
[[ "$status" == 2 ]] || fail "an invalid flag must exit 2, got $status"

# The PostgreSQL path is the original release script, renamed without edits.
grep -q 'set-secrets "DATABASE_URL=database-url:latest"' "$ROOT/release-postgres.sh" ||
  fail "release-postgres.sh no longer carries the original PostgreSQL release"

# ── deploy.sh refuses a Firestore installation ───────────────────────────────
guard() {
  (
    export PROJECT="$GCP_PROJECT" REGION="$GCP_REGION"
    # shellcheck source=infra/gcp/release-persistence.sh
    source "$ROOT/release-persistence.sh"
    refuse_firestore_installation
  ) 2>&1
}
reset
export STUB_AGENT_DRIVER=firestore
if out="$(guard)"; then fail "deploy.sh guard must refuse a Firestore installation"; fi
grep -q 'would reattach' <<<"$out" || fail "guard must explain the refusal: $out"
reset
export STUB_AGENT_DRIVER=postgres
guard >/dev/null || fail "deploy.sh guard must allow a PostgreSQL installation"
reset
export STUB_AGENT_DESCRIBE=missing
guard >/dev/null || fail "deploy.sh guard must allow a fresh project"
reset
export STUB_AGENT_DESCRIBE=denied
if guard >/dev/null; then fail "deploy.sh guard must not treat a permission error as a fresh project"; fi
grep -q 'refuse_firestore_installation || exit 1' "$ROOT/deploy.sh" || fail "deploy.sh does not call the guard"

# ── release-firestore.sh ─────────────────────────────────────────────────────
export IMAGE_TAG="abc123" SKIP_IMAGE_BUILD=true RELEASE_HEALTH_INTERVAL_SECONDS=0 RELEASE_HEALTH_ATTEMPTS=2
export ASSISTANT_MODULES="google,browser"

firestore_release() {
  bash "$ROOT/release-firestore.sh" 2>&1
}

assert_no_database_calls() {
  if grep -Eiq 'database-url|DATABASE_URL|assistant-migrate|assistant-backup|secrets|neon|pg_dump' "$STUB_CALLS"; then
    grep -Ei 'database-url|DATABASE_URL|assistant-migrate|assistant-backup|secrets|neon|pg_dump' "$STUB_CALLS" >&2
    fail "the Firestore release made a database call"
  fi
}

reset
out="$(firestore_release)" || fail "Firestore release should succeed: $out"
grep -q 'Firestore release abc123 is live' <<<"$out" || fail "release did not finish: $out"
grep -q 'Recovery point: assistant-production at .* (point-in-time recovery' <<<"$out" ||
  fail "release must print its PITR recovery point: $out"
grep -q 'pnpm -s firestore:indexes verify --project=test-project --database=assistant-production' "$STUB_CALLS" ||
  fail "release must verify Firestore indexes"
grep -q 'run services update assistant-agent' "$STUB_CALLS" || fail "agent not rolled out"
grep -q 'run services update assistant-web' "$STUB_CALLS" || fail "web not rolled out"
grep -q 'run jobs update assistant-browser' "$STUB_CALLS" || fail "browser job not rolled out"
assert_no_database_calls

reset
export STUB_AGENT_EXTRA_ENV='{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"database-url","key":"latest"}}}'
if out="$(firestore_release)"; then fail "a template with a database secret must stop the release"; fi
grep -q 'not a database-free Firestore composition' <<<"$out" || fail "missing composition error: $out"
grep -q 'DATABASE_URL from secret database-url' <<<"$out" || fail "the offending reference must be named: $out"
grep -q 'run services update' "$STUB_CALLS" && fail "a mixed composition was rolled out"

reset
export STUB_PITR=off STUB_BACKUP_AGE_HOURS=3
out="$(firestore_release)" || fail "a recent managed backup should satisfy the recovery gate: $out"
grep -q 'Recovery point: projects/test-project/locations/us/backups/b1' <<<"$out" ||
  fail "release must name the backup it relies on: $out"
assert_no_database_calls

reset
export STUB_PITR=off STUB_BACKUP_AGE_HOURS=48
if out="$(firestore_release)"; then fail "no recent recovery point must stop the release"; fi
grep -q 'No READY managed backup' <<<"$out" || fail "missing recovery-point error: $out"
grep -q 'run services update' "$STUB_CALLS" && fail "rolled out without a recovery point"

reset
export STUB_INDEX_STATUS=1
if firestore_release >/dev/null; then fail "an index mismatch must stop the release"; fi
grep -q 'run services update' "$STUB_CALLS" && fail "rolled out before indexes matched"

reset
export STUB_JOB_DB=1
if out="$(firestore_release)"; then fail "a module job with a database secret must fail the release"; fi
grep -q 'job assistant-browser is not a database-free' <<<"$out" || fail "missing job composition error: $out"
grep -q 'run jobs update assistant-browser' "$STUB_CALLS" && fail "a job with a database secret was updated"
grep -q 'run services update assistant-web' "$STUB_CALLS" || fail "web rollout should not be stranded by job drift"

echo "release path tests passed"
