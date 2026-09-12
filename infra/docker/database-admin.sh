#!/usr/bin/env bash

# Neon pooler connections are appropriate for application traffic but not for
# maintenance commands. This helper changes only the recognized Neon pooler
# endpoint in a PostgreSQL URI; credentials, path, query, and every other URI
# are kept byte-for-byte unchanged.
database_admin_direct_url() {
  local input="${1-}" scheme authority suffix userinfo hostport host port first direct

  if [[ "$input" =~ ^(postgres|postgresql)://([^/?#]*)(.*)$ ]]; then
    scheme="${BASH_REMATCH[1]}://"
    authority="${BASH_REMATCH[2]}"
    suffix="${BASH_REMATCH[3]}"
  else
    printf '%s\n' "$input"
    return 0
  fi

  userinfo=""
  hostport="$authority"
  if [[ "$authority" == *@* ]]; then
    userinfo="${authority%@*}@"
    hostport="${authority##*@}"
  fi

  host="$hostport"
  port=""
  if [[ "$hostport" =~ ^(.+)(:[0-9]+)$ ]]; then
    host="${BASH_REMATCH[1]}"
    port="${BASH_REMATCH[2]}"
  fi

  first="${host%%.*}"
  direct=""
  if [[ "$first" =~ ^ep-[a-z0-9-]+-pooler$ ]]; then
    # Reject a second pooler marker in the endpoint portion. This keeps a
    # crafted name such as ep-real-pooler-pooler... outside the rewrite.
    if [[ "${first%-pooler}" != *-pooler* && "$host" =~ ^[^.]+\.[a-z0-9-]+(\.[a-z0-9-]+)*\.aws\.neon\.tech$ ]]; then
      direct="${first%-pooler}${host:${#first}}${port}"
    fi
  fi

  if [[ -n "$direct" ]]; then
    printf '%s%s%s%s\n' "$scheme" "$userinfo" "$direct" "$suffix"
  else
    printf '%s\n' "$input"
  fi
}

database_admin_run() {
  local direct_url
  : "${DATABASE_URL:?DATABASE_URL is required}"
  (($# > 0)) || { echo "usage: database_admin.sh command [args ...]" >&2; return 2; }
  direct_url="$(database_admin_direct_url "$DATABASE_URL")"
  database_admin_run_url "$direct_url" "$@"
}

database_admin_run_url() {
  local direct_url="$1"
  shift
  (($# > 0)) || { echo "usage: database-admin.sh command [args ...]" >&2; return 2; }
  DATABASE_URL="$direct_url" "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  database_admin_run "$@"
fi
