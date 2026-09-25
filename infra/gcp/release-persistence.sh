#!/usr/bin/env bash

# Resolve which persistence driver a release (or a provisioning run) targets.
# PROJECT and REGION are supplied by the caller. Sourced by release.sh and
# deploy.sh, and by infra/gcp/release.test.sh with a stubbed gcloud.

# Print the PERSISTENCE_DRIVER set on a Cloud Run service template. An absent
# variable prints nothing: the application's configuration default is
# postgres. Returns non-zero when the service cannot be described.
service_persistence_driver() {
  local service="$1" description
  description="$(gcloud run services describe "$service" \
    --project "$PROJECT" --region "$REGION" --format=json)" || return 1
  printf '%s' "$description" | node -e '
    const fs = require("node:fs");
    const service = JSON.parse(fs.readFileSync(0, "utf8"));
    const env = service.spec?.template?.spec?.containers?.[0]?.env ?? [];
    process.stdout.write(String(env.find((entry) => entry.name === "PERSISTENCE_DRIVER")?.value ?? ""));
  '
}

# The live driver of both serving services, or the explicit
# RELEASE_PERSISTENCE_DRIVER when it agrees with them. A release never guesses:
# services that disagree (a cutover in progress) or a flag that contradicts the
# live services stop the release before anything is built or rolled out.
resolve_release_persistence() {
  local requested="${RELEASE_PERSISTENCE_DRIVER:-auto}" agent web
  case "$requested" in
    auto|postgres|firestore) ;;
    *)
      echo "RELEASE_PERSISTENCE_DRIVER must be auto, postgres, or firestore (got '${requested}')." >&2
      return 2
      ;;
  esac
  agent="$(service_persistence_driver assistant-agent)" || {
    echo "Could not read PERSISTENCE_DRIVER from assistant-agent." >&2
    return 1
  }
  web="$(service_persistence_driver assistant-web)" || {
    echo "Could not read PERSISTENCE_DRIVER from assistant-web." >&2
    return 1
  }
  agent="${agent:-postgres}"
  web="${web:-postgres}"
  if [[ "$agent" != "postgres" && "$agent" != "firestore" ]] ||
    [[ "$web" != "postgres" && "$web" != "firestore" ]]; then
    echo "Unsupported live PERSISTENCE_DRIVER (agent '${agent}', web '${web}')." >&2
    return 1
  fi
  if [[ "$agent" != "$web" ]]; then
    echo "assistant-agent runs ${agent} but assistant-web runs ${web}." >&2
    echo "A persistence cutover is in progress; finish or roll it back before releasing." >&2
    return 1
  fi
  if [[ "$requested" != "auto" && "$requested" != "$agent" ]]; then
    echo "RELEASE_PERSISTENCE_DRIVER=${requested}, but the live services run ${agent}." >&2
    return 1
  fi
  printf '%s' "$agent"
}

# Provisioning guard: prints "firestore" when an existing assistant-agent
# already runs the Firestore composition, and nothing for a fresh project
# (no service yet) or a PostgreSQL installation.
live_installation_persistence() {
  local driver output
  if ! output="$(gcloud run services describe assistant-agent \
    --project "$PROJECT" --region "$REGION" --format='value(metadata.name)' 2>&1)"; then
    # Only a service that does not exist means a fresh project; any other
    # failure (permissions, network) must not be mistaken for one.
    grep -Eqi 'NOT_FOUND|not found|could not be found|does not exist' <<<"$output" && return 0
    printf '%s\n' "$output" >&2
    return 1
  fi
  driver="$(service_persistence_driver assistant-agent)" || return 1
  [[ "$driver" == "firestore" ]] && printf 'firestore'
  return 0
}

# deploy.sh provisions the PostgreSQL composition: it creates the database
# secret, migrates, and mounts that secret on both services. Run against an
# installation that already cut over, it would silently make the retired
# database a runtime dependency again, so it refuses.
refuse_firestore_installation() {
  local driver
  driver="$(live_installation_persistence)" || {
    echo "Could not read PERSISTENCE_DRIVER from assistant-agent." >&2
    return 1
  }
  if [[ "$driver" == "firestore" ]]; then
    echo "assistant-agent runs PERSISTENCE_DRIVER=firestore; deploy.sh provisions the PostgreSQL" >&2
    echo "composition and would reattach its database secret. Release with infra/gcp/release.sh;" >&2
    echo "Firestore infrastructure is managed by infra/gcp/consumer/terraform." >&2
    return 1
  fi
  return 0
}
