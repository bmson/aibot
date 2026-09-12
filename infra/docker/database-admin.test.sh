#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/docker/database-admin.sh
source "$ROOT/database-admin.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_url() {
  local actual expected
  actual="$(database_admin_direct_url "$1")"
  expected="$2"
  [[ "$actual" == "$expected" ]] || fail "URL mismatch: expected ${expected}, got ${actual}"
}

assert_url \
  'postgres://user:p%40ss%2Fword@ep-snowy-bird-a1b2c3-pooler.c-2.us-west-2.aws.neon.tech:5432/app/path?sslmode=require&options=x%40y' \
  'postgres://user:p%40ss%2Fword@ep-snowy-bird-a1b2c3.c-2.us-west-2.aws.neon.tech:5432/app/path?sslmode=require&options=x%40y'
assert_url \
  'postgresql://user:password@ep-snowy-bird-a1b2c3-pooler.us-east-2.aws.neon.tech/db?sslmode=require' \
  'postgresql://user:password@ep-snowy-bird-a1b2c3.us-east-2.aws.neon.tech/db?sslmode=require'

# Non-Neon URLs, malformed Neon-looking suffixes, and endpoint names with a
# second pooler marker must pass through unchanged.
assert_url 'postgres://user:password@db.example.test:5432/app?sslmode=require' \
  'postgres://user:password@db.example.test:5432/app?sslmode=require'
assert_url 'postgres://user:password@ep-real-pooler.c-2.us-west-2.aws.neon.tech.evil/app' \
  'postgres://user:password@ep-real-pooler.c-2.us-west-2.aws.neon.tech.evil/app'
assert_url 'postgres://user:password@ep-real-pooler-pooler.c-2.us-west-2.aws.neon.tech/app' \
  'postgres://user:password@ep-real-pooler-pooler.c-2.us-west-2.aws.neon.tech/app'
assert_url 'postgres://user:password@ep-real_pooler-pooler.c-2.us-west-2.aws.neon.tech/app' \
  'postgres://user:password@ep-real_pooler-pooler.c-2.us-west-2.aws.neon.tech/app'
assert_url 'not-a-postgres-url' 'not-a-postgres-url'

captured_url=""
capture_database_url() {
  captured_url="$DATABASE_URL"
}

DATABASE_URL='postgres://user:secret@ep-snowy-bird-a1b2c3-pooler.c-2.us-west-2.aws.neon.tech/app'
run_output_file="$(mktemp "${TMPDIR:-/tmp}/assistant-database-admin-output.XXXXXX")"
trap 'rm -f "$run_output_file"' EXIT
database_admin_run capture_database_url >"$run_output_file" 2>&1
run_output="$(cat "$run_output_file")"
[[ -z "$run_output" ]] || fail "helper logged the database URL"
[[ "$captured_url" == 'postgres://user:secret@ep-snowy-bird-a1b2c3.c-2.us-west-2.aws.neon.tech/app' ]] || fail "command did not receive direct URL"

return_status() {
  return 23
}
if database_admin_run return_status; then
  fail "helper swallowed command exit status"
else
  status=$?
  [[ "$status" -eq 23 ]] || fail "expected command status 23, got ${status}"
fi

echo "database admin shell tests passed"
