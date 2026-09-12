#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/gcp/release-diagnostics.sh
source "$ROOT/release-diagnostics.sh"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/assistant-release-diagnostics.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
export PROJECT="test-project"
export REGION="test-region"
export STUB_MODE="success"
export STUB_EXECUTE_STATUS="1"
export STUB_CALLS="$TEST_ROOT/calls"
export STUB_OUTPUT="$TEST_ROOT/output"

cat >"$TEST_ROOT/gcloud" <<'STUB'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"$STUB_CALLS"
case "$STUB_MODE:$*" in
  success:*'run jobs execute assistant-migrate'*)
    echo 'Execution [assistant-migrate-test01] has successfully completed.'
    exit 0
    ;;
  failure:*'run jobs execute assistant-migrate'*)
    echo 'ERROR: (gcloud.run.jobs.execute) The execution failed.'
    echo 'gcloud run jobs executions describe assistant-migrate-test01'
    exit "$STUB_EXECUTE_STATUS"
    ;;
  noexecution:*'run jobs execute assistant-migrate'*)
    echo 'ERROR: (gcloud.run.jobs.execute) The execution failed.'
    exit "$STUB_EXECUTE_STATUS"
    ;;
  failure:*'run jobs executions describe assistant-migrate-test01'*)
    if [[ "$STUB_OUTPUT" == *describe-fails* ]]; then
      exit 7
    fi
    echo 'metadata:'
    echo '  name: assistant-migrate-test01'
    echo 'status:'
    echo '  failedCount: 1'
    exit 0
    ;;
  failure:*'run jobs logs read assistant-migrate'*)
    if [[ "$STUB_OUTPUT" == *logs-fail* ]]; then
      exit 7
    fi
    echo '2026-09-12T21:40:05Z ERROR relation "agents" does not exist'
    exit 0
    ;;
esac
echo "unexpected gcloud call: $*" >&2
exit 99
STUB
chmod +x "$TEST_ROOT/gcloud"
export PATH="$TEST_ROOT:$PATH"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

: >"$STUB_CALLS"
if ! output="$(run_migration_job 2>&1)"; then
  fail "successful migration returned nonzero"
fi
grep -Fq 'successfully completed' <<<"$output" || fail "success output was lost"
grep -Fq 'run jobs execute assistant-migrate' "$STUB_CALLS" || fail "execution was not invoked"
if grep -Fq 'executions describe' "$STUB_CALLS"; then
  fail "success path ran diagnostics"
fi

export STUB_MODE="failure"
export STUB_OUTPUT=""
export STUB_EXECUTE_STATUS="13"
: >"$STUB_CALLS"
if output="$(run_migration_job 2>&1)"; then
  fail "failed migration returned zero"
else
  status=$?
  [[ "$status" -eq 13 ]] || fail "migration status changed from 13 to ${status}"
fi
grep -Fq 'collecting bounded diagnostics' <<<"$output" || fail "failure diagnostics were not announced"
grep -Fq 'failedCount: 1' <<<"$output" || fail "execution status was not emitted"
grep -Fq 'relation "agents" does not exist' <<<"$output" || fail "bounded error log was not emitted"
grep -Fq 'executions describe assistant-migrate-test01' "$STUB_CALLS" || fail "execution describe was not invoked"
grep -Fq 'jobs logs read assistant-migrate' "$STUB_CALLS" || fail "job logs were not invoked"
grep -Fq -- '--limit=50' "$STUB_CALLS" || fail "diagnostic log limit was not bounded"
grep -Fq -- 'labels."run.googleapis.com/execution_name"="assistant-migrate-test01"' "$STUB_CALLS" || fail "diagnostic logs were not scoped to the failed execution"
if grep -Fq 'DATABASE_URL' <<<"$output"; then
  fail "failure diagnostics exposed a secret name/value"
fi

export STUB_OUTPUT="describe-fails-logs-fail"
: >"$STUB_CALLS"
if output="$(run_migration_job 2>&1)"; then
  fail "diagnostic failures masked the original migration failure"
else
  status=$?
  [[ "$status" -eq 13 ]] || fail "diagnostic failures changed migration status to ${status}"
fi
grep -Fq 'Could not describe migration execution' <<<"$output" || fail "describe failure was not reported"
grep -Fq 'Could not read logs for migration execution' <<<"$output" || fail "log failure was not reported"

export STUB_MODE="noexecution"
: >"$STUB_CALLS"
if output="$(run_migration_job 2>&1)"; then
  fail "failure without an execution name returned zero"
else
  status=$?
  [[ "$status" -eq 13 ]] || fail "missing execution name changed migration status to ${status}"
fi
grep -Fq 'skipping diagnostics' <<<"$output" || fail "missing execution name was not reported"
if grep -Eq 'executions describe|jobs logs read' "$STUB_CALLS"; then
  fail "diagnostics ran without a validated execution name"
fi

echo "release diagnostics shell tests passed"
