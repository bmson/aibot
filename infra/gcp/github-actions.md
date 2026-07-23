# Keyless GitHub deployment setup

The normal release command is `bash infra/gcp/release.sh`. It builds immutable
images with Cloud Build, runs the database migrations in a short-lived Cloud
Run Job, then updates the services and browser job. It assumes the Cloud Run
services, service accounts, secrets, queues, and Artifact Registry already
exist; provision or reconcile those once with `bash infra/gcp/deploy.sh`.

The `Deploy production` workflow releases only after the `CI` workflow
succeeds for a push to `main`. It builds and pushes the immutable images from
GitHub Actions, then runs the migration and Cloud Run rollout. It uses GitHub's
OIDC token and Google Workload Identity Federation, not a downloadable
service-account key.

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

for ROLE in roles/artifactregistry.writer roles/run.admin roles/cloudscheduler.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE"
done
for RUNTIME_SA in assistant-agent assistant-web assistant-browser assistant-code assistant-processor assistant-internal-invoker; do
  gcloud iam service-accounts add-iam-policy-binding \
    "${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser
done
```

The Cloud Build service account is used only by the optional local release
path. GitHub Actions pushes directly to Artifact Registry, so the deployer
does not receive Cloud Build or Cloud Storage permissions. If this is a new
project, finish the bootstrap deploy before enabling GitHub deployments.

## Why a web change reaches production

Every release proves itself: `infra/gcp/release.sh` polls `/api/health` on the
live `assistant-web` URL and fails unless it reports the commit being released.
The commit is baked into the image by the `GIT_SHA` build arg (passed by both
the GitHub workflow and `cloudbuild.yaml`), so "the image was pushed" can no
longer be mistaken for "production is serving it".

Three things used to break that chain silently, and are now closed:

- **The web rollout was last, behind fail-fast gates it did not depend on.** An
  agent env var only `deploy.sh` sets, or one absent Cloud Scheduler job, exited
  the script before web was ever updated. Rollout steps are now attempted
  independently and their failures reported together at the end, so unrelated
  drift still fails the release without stranding a component.
- **Traffic could stay pinned to an old revision.** A manual rollback pins the
  traffic split, after which every `services update --image` creates a revision
  serving 0% of requests. Each rollout now re-asserts `--to-latest`.
- **A skipped or unrelated-red CI run blocked deploys entirely.** Deployment
  keys off a successful `CI` run, so a `[skip ci]` commit produces no deploy,
  and CI can go red for reasons unrelated to the commit (a newly published
  advisory failing `pnpm audit`, a fresh HIGH CVE failing Trivy). Use the
  manual path below rather than pushing an empty commit.

### Forcing a release

`Deploy production` accepts `workflow_dispatch`, with an optional `sha` input
that defaults to the tip of `main`:

```sh
gh workflow run "Deploy production" --ref main
gh workflow run "Deploy production" --ref main -f sha=<commit>
```

This still builds from the given commit and still runs the full verification,
so it is a way to bypass a stuck *trigger* — not to bypass the release's own
checks.

## GitHub configuration

No GitHub secret or repository variable is needed. The workflow names the
non-secret project, region, deployment service account, and restricted workload
identity provider directly, so it is ready as soon as it reaches `main`. GitHub
will create the `production` environment on first use if it does not already
exist. Do not add required reviewers to that environment if deployments should
remain automatic. The workflow concurrency setting queues releases rather than
cancelling an in-progress deployment.
