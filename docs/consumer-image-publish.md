# Publish customer-owned minimal runtime images

This manual step builds the existing `infra/docker/web.Dockerfile` and `infra/docker/agent.Dockerfile` from **one explicit committed source SHA**. It pushes only `web` and `agent` into the customer project, region, and Artifact Registry Docker repository supplied on the command line. It does not deploy Cloud Run, change installer stages, or mark an installation ready.

The publisher exports that Git commit to a temporary Docker context. Uncommitted files, including `apps/web/.env.local`, never enter the build. It rejects committed `.env` files, credential files, symlinks, missing `.dockerignore` env rules, or Dockerfiles that do not stamp `BUILD_SHA`. Both images receive `GIT_SHA` as a build argument. After each push, the publisher pulls the image by its returned SHA-256 digest and checks the remote image configuration for the exact `BUILD_SHA` before writing a manifest.

Use a customer-owned identity with permission to describe and push to an **existing Docker repository with immutable tags**. Sign in with `gcloud auth login` using that identity and ensure Docker Buildx and gcloud are on the same `PATH`. The publisher configures the gcloud Docker credential helper for only `REGION-docker.pkg.dev` in a private temporary Docker configuration, uses it for build, push, pull, and digest inspection, then removes it. It does not change the customer's normal Docker configuration or store access tokens in the release manifest. A separate `gcloud auth configure-docker` step is unnecessary. Supply the same project, region, and repository IDs as the customer Terraform foundation.

First validate the committed source and destination names without Google auth or Docker:

```sh
pnpm consumer:publish-images \
  --project CUSTOMER_PROJECT \
  --region CUSTOMER_REGION \
  --repository CUSTOMER_REPOSITORY \
  --source-sha FULL_40_CHARACTER_COMMIT_SHA \
  --dry-run
```

The dry run extracts and checks the exact committed archive, then prints the archive digest and two planned source-SHA tags. It writes no manifest and makes no Google or Docker calls. A local env override is neither archived nor loaded, even if it exists in the checkout.

To publish, omit `--dry-run` and give a **new** local manifest path:

```sh
pnpm consumer:publish-images \
  --project CUSTOMER_PROJECT \
  --region CUSTOMER_REGION \
  --repository CUSTOMER_REPOSITORY \
  --source-sha FULL_40_CHARACTER_COMMIT_SHA \
  --output ./customer-image-digests.json
```

The command confirms the exact repository name, Docker format, and immutable-tag setting before pushing. It builds `linux/amd64` images without Buildx provenance attestations so Cloud Run receives a runnable image manifest, tags them with the source SHA, captures the registry digests from Docker Buildx metadata, pulls those digests, verifies `BUILD_SHA`, and writes a new mode-0600 JSON manifest. The `terraform.web_image_digest` and `terraform.agent_image_digest` fields are the optional Cloud Run Terraform inputs. Image digests and source SHA are provenance, not secrets; the manifest contains no credentials or secret payloads. Keep it under customer control. If the second build fails, the first image may already exist, but no complete manifest is written and no service is changed.

The command writes fixed phase updates to stderr while building and verifying each image. It suppresses Docker and credential-helper output, which may contain sensitive data; a build may still take several minutes between phase updates.

This is a build/publish step, not a release or runtime-readiness check. It does not scan or sign images, provision OAuth or Secret Manager versions, seed Firestore, test a live model response, or verify a Cloud Run rollout. The ordinary production release pipeline remains separate. The optional Firestore Terraform runtime still requires its own authentication and database prerequisites before these digests can be applied.
