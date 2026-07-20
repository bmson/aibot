#!/usr/bin/env bash
# Idempotent GCP deploy for the assistant. Run from the repo root:
#   bash infra/gcp/deploy.sh
# Requires: gcloud authenticated (gcloud auth login), .env with PROD_DATABASE_URL etc.
set -euo pipefail

PROJECT="bmson-assistant"
REGION="us-west1"
REPO="assistant"
QUEUE="agent-steps"
TOPIC="gmail-events"
# Custom domain for the web dashboard (Cloud Run domain mapping; DNS: bot CNAME ghs.googlehosted.com.)
WEB_DOMAIN="bot.bmson.com"

# ── read .env ────────────────────────────────────────────────────────────────
envval() { { grep -E "^$1=" .env || true; } | head -1 | cut -d= -f2-; }
PROD_DATABASE_URL="$(envval PROD_DATABASE_URL)"
OPENROUTER_API_KEY="$(envval OPENROUTER_API_KEY)"
GOOGLE_OAUTH_CLIENT_ID="$(envval GOOGLE_OAUTH_CLIENT_ID)"
GOOGLE_OAUTH_CLIENT_SECRET="$(envval GOOGLE_OAUTH_CLIENT_SECRET)"
BOT_GOOGLE_REFRESH_TOKEN="$(envval BOT_GOOGLE_REFRESH_TOKEN)"
TWILIO_ACCOUNT_SID="$(envval TWILIO_ACCOUNT_SID)"
TWILIO_AUTH_TOKEN="$(envval TWILIO_AUTH_TOKEN)"
TWILIO_FROM_NUMBER="$(envval TWILIO_FROM_NUMBER)"
OWNER_PHONE="$(envval OWNER_PHONE)"
OWNER_EMAIL="$(envval OWNER_EMAIL)"

[ -n "$PROD_DATABASE_URL" ] || { echo "PROD_DATABASE_URL missing from .env"; exit 1; }
[ -n "$OPENROUTER_API_KEY" ] || { echo "OPENROUTER_API_KEY missing from .env"; exit 1; }

# Stable generated secrets (persisted in .env on first run)
AUTH_SECRET="$(envval PROD_AUTH_SECRET)"
if [ -z "$AUTH_SECRET" ]; then
  AUTH_SECRET="$(openssl rand -base64 32)"
  printf 'PROD_AUTH_SECRET=%s\n' "$AUTH_SECRET" >> .env
fi
PROFILE_ENC_KEY="$(envval PROD_PROFILE_ENC_KEY)"
if [ -z "$PROFILE_ENC_KEY" ]; then
  PROFILE_ENC_KEY="$(openssl rand -hex 32)"
  printf 'PROD_PROFILE_ENC_KEY=%s\n' "$PROFILE_ENC_KEY" >> .env
fi

# ── database schema (idempotent: drizzle journal skips applied migrations; seed upserts) ──
echo "── migrating prod database"
DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @assistant/db migrate
DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @assistant/db seed

gcloud config set project "$PROJECT" --quiet

echo "── enabling APIs"
gcloud services enable run.googleapis.com cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com pubsub.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com --quiet

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
LEGACY_RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
WEB_SA="assistant-web@${PROJECT}.iam.gserviceaccount.com"
AGENT_SA="assistant-agent@${PROJECT}.iam.gserviceaccount.com"
BROWSER_SA="assistant-browser@${PROJECT}.iam.gserviceaccount.com"
INTERNAL_INVOKER_SA="assistant-internal-invoker@${PROJECT}.iam.gserviceaccount.com"
GMAIL_PUSH_SA="assistant-gmail-push@${PROJECT}.iam.gserviceaccount.com"
CLOUD_TASKS_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
SCHEDULER_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
PUBSUB_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

ensure_service_account() {
  local id="$1" display_name="$2"
  gcloud iam service-accounts describe "${id}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$id" --display-name="$display_name" --quiet
}

grant_service_account_role() {
  local target="$1" member="$2" role="$3"
  gcloud iam service-accounts add-iam-policy-binding "$target" \
    --member="serviceAccount:${member}" --role="$role" --quiet >/dev/null
}

# --condition=None is required, not optional: this script also installs
# condition-scoped bindings (browser objects, traces), and gcloud refuses to add
# an unconditional binding to a policy containing conditions in non-interactive
# mode unless the empty condition is stated explicitly. Without it every run
# after the first aborts here.
grant_bucket_role() {
  local bucket="$1" member="$2" role="$3"
  gcloud storage buckets add-iam-policy-binding "gs://${bucket}" \
    --member="serviceAccount:${member}" --role="$role" --condition=None --quiet >/dev/null
}

echo "── service accounts"
# Force creation of the Google-managed identities before binding them below.
for managed_service in cloudtasks.googleapis.com cloudscheduler.googleapis.com pubsub.googleapis.com; do
  gcloud beta services identity create --service="$managed_service" --project="$PROJECT" \
    --quiet >/dev/null
done
ensure_service_account assistant-web "Assistant web runtime"
ensure_service_account assistant-agent "Assistant agent runtime"
ensure_service_account assistant-browser "Assistant sandboxed browser runtime"
ensure_service_account assistant-internal-invoker "Assistant internal OIDC invoker"
ensure_service_account assistant-gmail-push "Assistant Gmail Pub/Sub push identity"

# Cloud Tasks callers may request only an ID token for the unprivileged internal
# invoker identity. Google-managed service agents mint the actual signed tokens.
grant_service_account_role "$INTERNAL_INVOKER_SA" "$WEB_SA" roles/iam.serviceAccountUser
grant_service_account_role "$INTERNAL_INVOKER_SA" "$AGENT_SA" roles/iam.serviceAccountUser
grant_service_account_role \
  "$INTERNAL_INVOKER_SA" "$CLOUD_TASKS_SERVICE_AGENT" roles/iam.serviceAccountOpenIdTokenCreator
grant_service_account_role \
  "$INTERNAL_INVOKER_SA" "$SCHEDULER_SERVICE_AGENT" roles/iam.serviceAccountOpenIdTokenCreator
grant_service_account_role \
  "$GMAIL_PUSH_SA" "$PUBSUB_SERVICE_AGENT" roles/iam.serviceAccountOpenIdTokenCreator

echo "── artifact registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --location="$REGION" --repository-format=docker --quiet

echo "── workspace bucket"
BUCKET="${PROJECT}-workspace"
gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --quiet

# Runtimes can access objects, not bucket IAM/configuration. The browser job
# gets the same object-level access only because profiles live in this bucket.
grant_bucket_role "$BUCKET" "$WEB_SA" roles/storage.objectUser
grant_bucket_role "$BUCKET" "$AGENT_SA" roles/storage.objectUser
# A compromised browser process can reach only its encrypted profile and
# screenshots, never imports, memories, or other Workspace objects.
gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectUser --condition=None \
  --quiet >/dev/null 2>&1 || true
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectUser \
  --condition="expression=resource.name.startsWith(\"projects/_/buckets/${BUCKET}/objects/workspace/b-bot/browser/\"),title=browser-objects-only,description=Browser profile and screenshots only" \
  --quiet >/dev/null
# Remove the broad binding installed by older deploys that used the Compute SA.
gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role=roles/storage.objectAdmin \
  --quiet >/dev/null 2>&1 || true

echo "── traces bucket (30-day lifecycle)"
TRACES_BUCKET="${PROJECT}-traces"
if ! gcloud storage buckets describe "gs://${TRACES_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${TRACES_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --quiet
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' > /tmp/traces-lifecycle.json
  gcloud storage buckets update "gs://${TRACES_BUCKET}" --lifecycle-file=/tmp/traces-lifecycle.json --quiet
fi
gcloud storage buckets remove-iam-policy-binding "gs://${TRACES_BUCKET}" \
  --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectCreator --condition=None \
  --quiet >/dev/null 2>&1 || true
gcloud storage buckets add-iam-policy-binding "gs://${TRACES_BUCKET}" \
  --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectCreator \
  --condition="expression=resource.name.startsWith(\"projects/_/buckets/${TRACES_BUCKET}/objects/b-bot/traces/\"),title=browser-traces-only,description=Browser trace uploads only" \
  --quiet >/dev/null
gcloud storage buckets remove-iam-policy-binding "gs://${TRACES_BUCKET}" \
  --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role=roles/storage.objectAdmin \
  --quiet >/dev/null 2>&1 || true

echo "── secrets"
make_secret() {
  local name="$1" value="$2"
  [ -n "$value" ] || { echo "   (skipping $name — empty)"; return 0; }
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --quiet >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --quiet >/dev/null
  fi
}

grant_secret() {
  local name="$1" member="$2"
  gcloud secrets describe "$name" >/dev/null 2>&1 || return 0
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${member}" --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null
}

revoke_legacy_secret_access() {
  local name="$1"
  gcloud secrets describe "$name" >/dev/null 2>&1 || return 0
  gcloud secrets remove-iam-policy-binding "$name" \
    --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null 2>&1 || true
}

make_secret database-url "$PROD_DATABASE_URL"
make_secret openrouter-api-key "$OPENROUTER_API_KEY"
make_secret google-oauth-client-id "$GOOGLE_OAUTH_CLIENT_ID"
make_secret google-oauth-client-secret "$GOOGLE_OAUTH_CLIENT_SECRET"
make_secret bot-google-refresh-token "$BOT_GOOGLE_REFRESH_TOKEN"
make_secret auth-secret "$AUTH_SECRET"
make_secret twilio-auth-token "$TWILIO_AUTH_TOKEN"
make_secret profile-enc-key "$PROFILE_ENC_KEY"

# Explicit per-runtime secret grants. In particular, the browser can read only
# its profile key and never receives database, model, OAuth, or Twilio secrets.
for secret in database-url openrouter-api-key google-oauth-client-id google-oauth-client-secret; do
  grant_secret "$secret" "$AGENT_SA"
done
grant_secret bot-google-refresh-token "$AGENT_SA"
grant_secret twilio-auth-token "$AGENT_SA"
for secret in database-url openrouter-api-key google-oauth-client-id google-oauth-client-secret auth-secret; do
  grant_secret "$secret" "$WEB_SA"
done
grant_secret profile-enc-key "$BROWSER_SA"
for secret in database-url openrouter-api-key google-oauth-client-id google-oauth-client-secret \
  bot-google-refresh-token internal-api-secret auth-secret twilio-auth-token profile-enc-key; do
  revoke_legacy_secret_access "$secret"
done

echo "── building images (Cloud Build)"
gcloud builds submit --config=infra/gcp/cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_REPO=${REPO}" --quiet .

echo "── deploying agent service"
TWILIO_ENV=""
AGENT_SECRETS="DATABASE_URL=database-url:latest,OPENROUTER_API_KEY=openrouter-api-key:latest,GOOGLE_OAUTH_CLIENT_ID=google-oauth-client-id:latest,GOOGLE_OAUTH_CLIENT_SECRET=google-oauth-client-secret:latest,BOT_GOOGLE_REFRESH_TOKEN=bot-google-refresh-token:latest"
if [ -n "$TWILIO_ACCOUNT_SID" ] && [ -n "$TWILIO_AUTH_TOKEN" ]; then
  TWILIO_ENV=",TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID},TWILIO_FROM_NUMBER=${TWILIO_FROM_NUMBER},OWNER_PHONE=${OWNER_PHONE}"
  AGENT_SECRETS="${AGENT_SECRETS},TWILIO_AUTH_TOKEN=twilio-auth-token:latest"
fi
gcloud run deploy assistant-agent \
  --image "${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/agent:latest" \
  --region "$REGION" --allow-unauthenticated --service-account "$AGENT_SA" \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 4 --timeout 900 \
  --set-env-vars "QUEUE_DRIVER=cloudtasks,FILES_DRIVER=gcs,WORKSPACE_BUCKET=${PROJECT}-workspace,GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},CLOUD_TASKS_QUEUE=${QUEUE},OWNER_EMAIL=${OWNER_EMAIL},GMAIL_PUBSUB_TOPIC=projects/${PROJECT}/topics/${TOPIC},GMAIL_PUSH_SERVICE_ACCOUNT=${GMAIL_PUSH_SA},INTERNAL_AUTH_MODE=oidc,INTERNAL_OIDC_SERVICE_ACCOUNT=${INTERNAL_INVOKER_SA},BROWSER_DRIVER=cloudrun,BROWSER_JOB_NAME=assistant-browser,TRACES_BUCKET=${TRACES_BUCKET},CANARY_ENABLED=true,CANARY_MAX_COST_USD=0.03,CHAT_RECALL_ENABLED=true,OTEL_EXPORTER=none${TWILIO_ENV}" \
  --set-secrets "$AGENT_SECRETS" \
  --quiet

AGENT_URL="$(gcloud run services describe assistant-agent --region "$REGION" --format='value(status.url)')"
echo "   agent: $AGENT_URL"

# second pass: the service needs to know its own URL (Cloud Tasks callbacks, Pub/Sub aud)
gcloud run services update assistant-agent --region "$REGION" \
  --update-env-vars "AGENT_URL=${AGENT_URL},PUBLIC_URL=${AGENT_URL},INTERNAL_OIDC_AUDIENCE=${AGENT_URL}" --quiet

echo "── browser job (Cloud Run Job — no DB creds)"
BROWSER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/browser:latest"
if gcloud run jobs describe assistant-browser --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update assistant-browser --region "$REGION" \
    --image "$BROWSER_IMAGE" --service-account "$BROWSER_SA" \
    --memory 2Gi --cpu 2 --task-timeout 900 --max-retries 0 \
    --set-secrets "PROFILE_ENC_KEY=profile-enc-key:latest" --quiet
else
  gcloud run jobs create assistant-browser --region "$REGION" \
    --image "$BROWSER_IMAGE" --service-account "$BROWSER_SA" \
    --memory 2Gi --cpu 2 --task-timeout 900 --max-retries 0 \
    --set-secrets "PROFILE_ENC_KEY=profile-enc-key:latest" --quiet
fi
# the agent service launches executions with per-run env overrides
gcloud run jobs add-iam-policy-binding assistant-browser --region "$REGION" \
  --member="serviceAccount:${AGENT_SA}" --role="roles/run.jobsExecutorWithOverrides" --quiet >/dev/null
gcloud run jobs remove-iam-policy-binding assistant-browser --region "$REGION" \
  --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role="roles/run.jobsExecutorWithOverrides" \
  --quiet >/dev/null 2>&1 || true

echo "── cloud tasks queue"
if gcloud tasks queues describe "$QUEUE" --location="$REGION" >/dev/null 2>&1; then
  gcloud tasks queues update "$QUEUE" --location="$REGION" \
    --max-dispatches-per-second=5 --max-concurrent-dispatches=8 \
    --max-attempts=8 --min-backoff=10s --quiet
else
  gcloud tasks queues create "$QUEUE" --location="$REGION" \
    --max-dispatches-per-second=5 --max-concurrent-dispatches=8 \
    --max-attempts=8 --min-backoff=10s --quiet
fi
for runtime_sa in "$WEB_SA" "$AGENT_SA"; do
  gcloud tasks queues add-iam-policy-binding "$QUEUE" --location="$REGION" \
    --member="serviceAccount:${runtime_sa}" --role=roles/cloudtasks.enqueuer \
    --quiet >/dev/null
done

echo "── scheduler jobs"
make_job() {
  local name="$1" schedule="$2" path="$3"
  if gcloud scheduler jobs describe "$name" --location="$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$name" --location="$REGION" --schedule="$schedule" \
      --uri="${AGENT_URL}${path}" --http-method=POST \
      --attempt-deadline=300s --max-retry-attempts=0 \
      --clear-headers --oidc-service-account-email="$INTERNAL_INVOKER_SA" \
      --oidc-token-audience="${AGENT_URL}${path}" --quiet
  else
    gcloud scheduler jobs create http "$name" --location="$REGION" --schedule="$schedule" \
      --uri="${AGENT_URL}${path}" --http-method=POST \
      --attempt-deadline=300s --max-retry-attempts=0 \
      --oidc-service-account-email="$INTERNAL_INVOKER_SA" \
      --oidc-token-audience="${AGENT_URL}${path}" --quiet
  fi
}
make_job assistant-sweep "* * * * *" "/internal/sweep"
make_job assistant-gmail-sync "* * * * *" "/internal/gmail/sync"
make_job assistant-gmail-watch "0 4 * * *" "/internal/gmail/watch"
make_job assistant-canaries "17 15 * * *" "/internal/canaries/run"
make_job assistant-canary-health "30 * * * *" "/internal/canaries/health"

echo "── pub/sub (gmail push)"
gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 ||
  gcloud pubsub topics create "$TOPIC" --quiet
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" --quiet >/dev/null
if gcloud pubsub subscriptions describe gmail-events-push >/dev/null 2>&1; then
  gcloud pubsub subscriptions update gmail-events-push \
    --push-endpoint="${AGENT_URL}/webhooks/gmail/pubsub" \
    --push-auth-service-account="$GMAIL_PUSH_SA" \
    --push-auth-token-audience="${AGENT_URL}/webhooks/gmail/pubsub" \
    --ack-deadline=600 --quiet
else
  gcloud pubsub subscriptions create gmail-events-push --topic="$TOPIC" \
    --push-endpoint="${AGENT_URL}/webhooks/gmail/pubsub" \
    --push-auth-service-account="$GMAIL_PUSH_SA" \
    --push-auth-token-audience="${AGENT_URL}/webhooks/gmail/pubsub" \
    --ack-deadline=600 --quiet
fi

echo "── deploying web service"
gcloud run deploy assistant-web \
  --image "${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/web:latest" \
  --region "$REGION" --allow-unauthenticated --service-account "$WEB_SA" \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 2 --timeout 300 \
  --set-env-vars "QUEUE_DRIVER=cloudtasks,FILES_DRIVER=gcs,WORKSPACE_BUCKET=${PROJECT}-workspace,GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},CLOUD_TASKS_QUEUE=${QUEUE},OWNER_EMAIL=${OWNER_EMAIL},AUTH_TRUST_HOST=true,AUTH_DEV_BYPASS=false,INTERNAL_AUTH_MODE=oidc,INTERNAL_OIDC_SERVICE_ACCOUNT=${INTERNAL_INVOKER_SA},CHAT_RECALL_ENABLED=true,OTEL_EXPORTER=none" \
  --set-secrets "DATABASE_URL=database-url:latest,OPENROUTER_API_KEY=openrouter-api-key:latest,AUTH_SECRET=auth-secret:latest,AUTH_GOOGLE_ID=google-oauth-client-id:latest,AUTH_GOOGLE_SECRET=google-oauth-client-secret:latest" \
  --quiet

WEB_URL="$(gcloud run services describe assistant-web --region "$REGION" --format='value(status.url)')"
AUTH_URL="${WEB_URL}"
if [ -n "$WEB_DOMAIN" ]; then
  AUTH_URL="https://${WEB_DOMAIN}"
  gcloud beta run domain-mappings describe --domain "$WEB_DOMAIN" --region "$REGION" >/dev/null 2>&1 ||
    gcloud beta run domain-mappings create --service assistant-web --domain "$WEB_DOMAIN" --region "$REGION" --quiet
fi
gcloud run services update assistant-web --region "$REGION" \
  --update-env-vars "AGENT_URL=${AGENT_URL},PUBLIC_URL=${AGENT_URL},INTERNAL_OIDC_AUDIENCE=${AGENT_URL},AUTH_URL=${AUTH_URL}" --quiet

echo ""
echo "══════════════════════════════════════════════════════"
echo " agent: ${AGENT_URL}"
echo " web:   ${WEB_URL}"
echo ""
echo " REMAINING MANUAL STEPS:"
echo " 1. Add OAuth redirect URI in the Google console:"
echo "    ${AUTH_URL}/api/auth/callback/google"
echo " 1b. DNS for the custom domain (wherever bmson.com DNS is managed):"
echo "    bot  CNAME  ghs.googlehosted.com."
echo " 2. Kick the Gmail watch (uses the Scheduler OIDC identity):"
echo "    gcloud scheduler jobs run assistant-gmail-watch --location=${REGION}"
echo " 3. Point the Twilio number's webhook at:"
echo "    ${AGENT_URL}/webhooks/twilio/sms"
echo "══════════════════════════════════════════════════════"
