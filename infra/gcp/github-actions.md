# Keyless GitHub deployment setup

The normal release command is `bash infra/gcp/release.sh`. It builds immutable
images, runs the database migrations in a short-lived Cloud Run Job, then
updates the services and browser job. It assumes the Cloud Run services,
service accounts, secrets, queues, and Artifact Registry already exist;
provision or reconcile those once with `bash infra/gcp/deploy.sh`.

The `Deploy production` workflow releases only after the `CI` workflow
succeeds for a push to `main`. It uses GitHub's OIDC token and Google Workload
Identity Federation, not a downloadable service-account key.

## One-time Google Cloud setup

This production project is configured for `bmson/aibot`. The provider condition
is intentionally bound to that repository and the `main` ref; do not loosen it
to all repositories or refs. For another repository or project, replace the
values below before running the setup as a project administrator.

```sh
PROJECT_ID="bmson-assistant"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
REPOSITORY="bmson/aibot"
POOL="github"
PROVIDER="github-actions"
DEPLOY_SA="assistant-github-deploy@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create assistant-github-deploy \
  --project="$PROJECT_ID" --display-name="Assistant GitHub production deployer"

gcloud iam workload-identity-pools create "$POOL" \
  --project="$PROJECT_ID" --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='${REPOSITORY}' && assertion.ref=='refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --project="$PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPOSITORY}"

for ROLE in roles/artifactregistry.writer roles/cloudbuild.builds.editor roles/run.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE"
done
for RUNTIME_SA in assistant-agent assistant-web assistant-browser; do
  gcloud iam service-accounts add-iam-policy-binding \
    "${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser
done
```

The Cloud Build service account must retain permission to push into the
existing Artifact Registry repository. The original bootstrap deploy grants
the required runtime access; if this is a new project, finish that bootstrap
before enabling GitHub deployments.

## GitHub configuration

No GitHub secret or repository variable is needed. The workflow names the
non-secret project, region, deployment service account, and restricted workload
identity provider directly, so it is ready as soon as it reaches `main`. GitHub
will create the `production` environment on first use if it does not already
exist. Do not add required reviewers to that environment if deployments should
remain automatic. The workflow concurrency setting queues releases rather than
cancelling an in-progress deployment.
