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
INTERNAL_API_SECRET="$(envval PROD_INTERNAL_API_SECRET)"
if [ -z "$INTERNAL_API_SECRET" ]; then
  INTERNAL_API_SECRET="$(openssl rand -hex 32)"
  printf '\nPROD_INTERNAL_API_SECRET=%s\n' "$INTERNAL_API_SECRET" >> .env
fi
AUTH_SECRET="$(envval PROD_AUTH_SECRET)"
if [ -z "$AUTH_SECRET" ]; then
  AUTH_SECRET="$(openssl rand -base64 32)"
  printf 'PROD_AUTH_SECRET=%s\n' "$AUTH_SECRET" >> .env
fi

gcloud config set project "$PROJECT" --quiet

echo "── enabling APIs"
gcloud services enable run.googleapis.com cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com pubsub.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com --quiet

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

grant_bucket() {
  gcloud storage buckets add-iam-policy-binding "gs://${PROJECT}-workspace" \
    --member="serviceAccount:${RUNTIME_SA}" --role="roles/storage.objectAdmin" --quiet >/dev/null
}

echo "── artifact registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --location="$REGION" --repository-format=docker --quiet

echo "── workspace bucket"
BUCKET="${PROJECT}-workspace"
gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --quiet

echo "── secrets"
make_secret() {
  local name="$1" value="$2"
  [ -n "$value" ] || { echo "   (skipping $name — empty)"; return 0; }
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --quiet >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --quiet >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor" --quiet >/dev/null
}
make_secret database-url "$PROD_DATABASE_URL"
make_secret openrouter-api-key "$OPENROUTER_API_KEY"
make_secret google-oauth-client-id "$GOOGLE_OAUTH_CLIENT_ID"
make_secret google-oauth-client-secret "$GOOGLE_OAUTH_CLIENT_SECRET"
make_secret bot-google-refresh-token "$BOT_GOOGLE_REFRESH_TOKEN"
make_secret internal-api-secret "$INTERNAL_API_SECRET"
make_secret auth-secret "$AUTH_SECRET"
make_secret twilio-auth-token "$TWILIO_AUTH_TOKEN"

echo "── building images (Cloud Build)"
gcloud builds submit --config=infra/gcp/cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_REPO=${REPO}" --quiet .

echo "── deploying agent service"
TWILIO_ENV=""
AGENT_SECRETS="DATABASE_URL=database-url:latest,OPENROUTER_API_KEY=openrouter-api-key:latest,GOOGLE_OAUTH_CLIENT_ID=google-oauth-client-id:latest,GOOGLE_OAUTH_CLIENT_SECRET=google-oauth-client-secret:latest,BOT_GOOGLE_REFRESH_TOKEN=bot-google-refresh-token:latest,INTERNAL_API_SECRET=internal-api-secret:latest"
if [ -n "$TWILIO_ACCOUNT_SID" ] && [ -n "$TWILIO_AUTH_TOKEN" ]; then
  TWILIO_ENV=",TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID},TWILIO_FROM_NUMBER=${TWILIO_FROM_NUMBER},OWNER_PHONE=${OWNER_PHONE}"
  AGENT_SECRETS="${AGENT_SECRETS},TWILIO_AUTH_TOKEN=twilio-auth-token:latest"
fi
gcloud run deploy assistant-agent \
  --image "${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/agent:latest" \
  --region "$REGION" --allow-unauthenticated \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 20 --timeout 900 \
  --set-env-vars "QUEUE_DRIVER=cloudtasks,FILES_DRIVER=gcs,WORKSPACE_BUCKET=${PROJECT}-workspace,GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},CLOUD_TASKS_QUEUE=${QUEUE},OWNER_EMAIL=${OWNER_EMAIL},GMAIL_PUBSUB_TOPIC=projects/${PROJECT}/topics/${TOPIC},OTEL_EXPORTER=none${TWILIO_ENV}" \
  --set-secrets "$AGENT_SECRETS" \
  --quiet

AGENT_URL="$(gcloud run services describe assistant-agent --region "$REGION" --format='value(status.url)')"
echo "   agent: $AGENT_URL"

# second pass: the service needs to know its own URL (Cloud Tasks callbacks, Pub/Sub aud)
gcloud run services update assistant-agent --region "$REGION" \
  --update-env-vars "AGENT_URL=${AGENT_URL},PUBLIC_URL=${AGENT_URL}" --quiet

grant_bucket

echo "── cloud tasks queue"
gcloud tasks queues describe "$QUEUE" --location="$REGION" >/dev/null 2>&1 ||
  gcloud tasks queues create "$QUEUE" --location="$REGION" \
    --max-dispatches-per-second=5 --max-attempts=8 --min-backoff=10s --quiet

echo "── scheduler jobs"
make_job() {
  local name="$1" schedule="$2" path="$3"
  if gcloud scheduler jobs describe "$name" --location="$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$name" --location="$REGION" --schedule="$schedule" \
      --uri="${AGENT_URL}${path}" --http-method=POST \
      --update-headers "Authorization=Bearer ${INTERNAL_API_SECRET}" --quiet
  else
    gcloud scheduler jobs create http "$name" --location="$REGION" --schedule="$schedule" \
      --uri="${AGENT_URL}${path}" --http-method=POST \
      --headers "Authorization=Bearer ${INTERNAL_API_SECRET}" --quiet
  fi
}
make_job assistant-sweep "* * * * *" "/internal/sweep"
make_job assistant-gmail-watch "0 4 * * *" "/internal/gmail/watch"

echo "── pub/sub (gmail push)"
gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 ||
  gcloud pubsub topics create "$TOPIC" --quiet
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" --quiet >/dev/null
if ! gcloud pubsub subscriptions describe gmail-events-push >/dev/null 2>&1; then
  gcloud pubsub subscriptions create gmail-events-push --topic="$TOPIC" \
    --push-endpoint="${AGENT_URL}/webhooks/gmail/pubsub" \
    --push-auth-service-account="$RUNTIME_SA" \
    --push-auth-token-audience="${AGENT_URL}/webhooks/gmail/pubsub" --quiet
fi

echo "── deploying web service"
gcloud run deploy assistant-web \
  --image "${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/web:latest" \
  --region "$REGION" --allow-unauthenticated \
  --memory 512Mi --cpu 1 --min-instances 0 --max-instances 2 --timeout 300 \
  --set-env-vars "QUEUE_DRIVER=cloudtasks,GCP_PROJECT=${PROJECT},GCP_LOCATION=${REGION},CLOUD_TASKS_QUEUE=${QUEUE},OWNER_EMAIL=${OWNER_EMAIL},AUTH_TRUST_HOST=true,OTEL_EXPORTER=none" \
  --set-secrets "DATABASE_URL=database-url:latest,OPENROUTER_API_KEY=openrouter-api-key:latest,AUTH_SECRET=auth-secret:latest,AUTH_GOOGLE_ID=google-oauth-client-id:latest,AUTH_GOOGLE_SECRET=google-oauth-client-secret:latest,INTERNAL_API_SECRET=internal-api-secret:latest" \
  --quiet

WEB_URL="$(gcloud run services describe assistant-web --region "$REGION" --format='value(status.url)')"
gcloud run services update assistant-web --region "$REGION" \
  --update-env-vars "AGENT_URL=${AGENT_URL},PUBLIC_URL=${AGENT_URL},AUTH_URL=${WEB_URL}" --quiet

echo ""
echo "══════════════════════════════════════════════════════"
echo " agent: ${AGENT_URL}"
echo " web:   ${WEB_URL}"
echo ""
echo " REMAINING MANUAL STEPS:"
echo " 1. Add OAuth redirect URI in the Google console:"
echo "    ${WEB_URL}/api/auth/callback/google"
echo " 2. Kick the Gmail watch:"
echo "    curl -X POST ${AGENT_URL}/internal/gmail/watch -H 'Authorization: Bearer <PROD_INTERNAL_API_SECRET from .env>'"
echo " 3. Point the Twilio number's webhook at:"
echo "    ${AGENT_URL}/webhooks/twilio/sms"
echo "══════════════════════════════════════════════════════"
