# Private Vertex model probe

The agent exposes `POST /internal/model-probe/vertex` for a one-shot connectivity check on a customer-owned Firestore installation. The route remains hidden unless `VERTEX_MODEL_PROBE_ENABLED=true`, `PERSISTENCE_DRIVER=firestore`, and `LLM_PROVIDER=vertex`. It uses the seeded `draft` model role and the normal model router, including its cost reservation and usage metering. It creates no task, schedule, conversation, or message; a successful call does write the normal model usage and cost records.

The request has no body and accepts no caller-supplied prompt or model options. The call has a fixed 16-token output limit, an 8-second deadline, and a $0.005 estimated-cost ceiling. It fails closed when the selected seeded model cannot fit that estimate. The ceiling follows configured model prices and is not a provider invoice guarantee. Responses omit generated text and provider error details.

Use only during a private rehearsal after an operator has reviewed the seeded model rates and authorized the agent service account for Vertex AI. Keep Cloud Run ingress private and grant `roles/run.invoker` only to the existing internal caller. Do not enable the flag on a public service. Enabling it updates the Cloud Run service and creates a revision; turn it back off after the probe:

```sh
gcloud run services update "$AGENT_SERVICE" \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --update-env-vars VERTEX_MODEL_PROBE_ENABLED=true

# The existing OIDC contract binds the token audience to this exact route path.
AGENT_ID_TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account "$INTERNAL_CALLER_SERVICE_ACCOUNT" \
  --audiences "$AGENT_URL/internal/model-probe/vertex")
curl --fail-with-body \
  -H "Authorization: Bearer $AGENT_ID_TOKEN" \
  -X POST "$AGENT_URL/internal/model-probe/vertex"

gcloud run services update "$AGENT_SERVICE" \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --update-env-vars VERTEX_MODEL_PROBE_ENABLED=false
```

The caller must already be authorized by the existing internal OIDC contract; the route does not add an identity or IAM grant. Cloud Run should return only `{ "ok": true, "matched": true, "modelId": "..." }` for the expected fixed response. No live IAM grant or Vertex request is performed by this repository change.
