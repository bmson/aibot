# Customer-owned consumer foundation

With no image digests supplied, this directory provisions only the first customer-owned resources for a Firestore installation:

- required Google APIs;
- an explicitly selected Firestore Native Standard database with point-in-time recovery (PITR), required for consistent managed snapshot exports;
- application composite/vector indexes and large-payload single-field exemptions from the shared `infra/gcp/firestore/firestore.indexes.json` specification;
- private, versioned assets and source archive buckets with uniform access, public access prevention, and seven-day soft-delete retention;
- an immutable-tag Docker Artifact Registry repository; and
- a dedicated runtime service account with access to the selected Firestore database and asset object administration. The source archive bucket has no runtime grant.

The foundation does not manage the project, billing account, existing Firestore databases, Cloud Run services, queues, secrets, or a publisher-owned installer. A name collision is allowed to fail during creation rather than silently adopting an existing resource. The database, buckets, and Artifact Registry repository use Terraform `prevent_destroy`. Firestore also enables server-side delete protection, and the buckets refuse forced deletion of their contents. Keep these resources in state; removing their resource blocks also removes Terraform lifecycle protection.

## State bootstrap

The GCS backend is configured without a bucket value because the state bucket must be customer-owned and created before this configuration is initialized. Creating that bucket from this same configuration would make the first state write circular. Bootstrap it with an authenticated customer workflow, apply the bucket's own retention/versioning/IAM policy, and then initialize this directory with the resulting bucket:

```sh
gcloud storage buckets create gs://CUSTOMER_STATE_BUCKET \
  --project=CUSTOMER_PROJECT \
  --location=CUSTOMER_REGION \
  --uniform-bucket-level-access \
  --public-access-prevention

terraform init \
  -backend-config="bucket=CUSTOMER_STATE_BUCKET" \
  -backend-config="prefix=assistant/CUSTOMER_INSTALLATION_ID"
```

The bootstrap bucket is outside this state. Keep its versioning, retention, access policy, and backup procedure under the customer's operational controls. Do not put credentials, secret values, or owner-claim material in Terraform variables or outputs. The optional runtime accepts immutable image digests as non-secret inputs.

## Configuration

All ownership and collision-sensitive identifiers are explicit. A minimal variable file looks like:

```hcl
project_id             = "customer-project-id"
region                 = "us-central1"
installation_id        = "assistant-prod"
firestore_database_id  = "(default)"
create_default_database = true
firestore_location_id  = "nam5"
assets_bucket_name     = "customer-project-id-assistant-assets"
source_bucket_name     = "customer-project-id-assistant-source"
artifact_repository_id = "assistant-prod"
```

The default consumer path creates `(default)` in a fresh customer-owned project. It requires explicit `create_default_database = true`; a future installer must verify absence under the authenticated customer identity before applying. The opt-in is creation intent, not evidence that a cloud check ran. An existing database must cause installation to stop: never import it, adopt it, or silently switch to a named database. Terraform creation also fails on an existing resource. A named 4–63 character non-UUID ID remains available for deliberately isolated installations; omit the opt-in for that path.

Google currently grants free quota only to the eligible default database; named databases are usage-billed. The free quota does not cover all features or the rest of the application. See [Firestore pricing](https://cloud.google.com/firestore/pricing?hl=en). The named-only isolation rule in the real-cloud validation harness is separate and remains unchanged. Choose a Firestore location that is compatible with the customer's region and selected Google model endpoints; the database location is a durable choice.

PITR retains seven days of document history and is billed to the customer's project outside the free storage tier. It is enabled here so managed backups can export the same consistent snapshot used for checksum verification. Disabling PITR prevents that backup workflow; the backup CLI checks the prerequisite before reading the inventory. See [PITR behavior and billing](https://docs.cloud.google.com/firestore/native/docs/pitr).

The Google provider constraint permits compatible 8.x releases. The committed `.terraform.lock.hcl` records the provider version and package checksums validated for local Apple Silicon and Linux CI/Cloud Shell. Refresh both platform checksums deliberately when upgrading: `terraform providers lock -platform=darwin_arm64 -platform=linux_amd64`. Read-only initialization must be followed by successful validation on the target platform.

With these variables alone, this remains a foundation-only apply. The installer copies only its verified foundation files into an isolated Terraform directory and does not set the runtime digest variables or advance a runtime-ready stage.

## Optional minimal Firestore runtime

`runtime.tf` is a separate, direct Terraform opt-in for a customer who has already built and verified `web` and `agent` images in this installation's Artifact Registry repository. Both inputs are **immutable image digests**, for example:

```hcl
web_image_digest   = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
agent_image_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

firestore_agent_id = "11111111-1111-4111-8111-111111111111"
firestore_embedding_space = {
  provider   = "vertex"
  model      = "text-embedding-005"
  dimensions = 768
  revision   = "customer-seed-v1"
}
owner_email  = "owner@example.com"
web_auth_url = "https://assistant.example.com"

# Versions of existing, customer-populated Secret Manager secrets.
auth_secret_version          = 1
google_client_id_version     = 1
google_client_secret_version = 1
```

The digest examples are placeholders, not published images. Terraform constructs `REGION-docker.pkg.dev/PROJECT/REPOSITORY/web@sha256:...` and the matching `agent` URL, so tags and other registries cannot be selected by these inputs. Both digests must be supplied together. The current application composition opens Firestore's `(default)` database only; a named database remains available for a foundation-only apply but cannot enable this runtime. `firestore_agent_id` must identify a seeded owner agent, and embedding provenance must match the existing data. The selected Vertex model must be available in `region`; Terraform cannot prove model access or embedding compatibility.

Before supplying digests, create and populate these exact secrets in the customer project, outside Terraform state:

| Secret ID | Cloud Run web environment variable |
| --- | --- |
| `<installation_id>-auth-secret` | `AUTH_SECRET` |
| `<installation_id>-google-client-id` | `AUTH_GOOGLE_ID` |
| `<installation_id>-google-client-secret` | `AUTH_GOOGLE_SECRET` |

Supply positive, numbered versions. Terraform grants only the web service account `secretAccessor` on those three secrets and injects those pinned versions; it never reads, outputs, or stores secret values. Configure the Google OAuth client for the owner account and the callback `${web_auth_url}/api/auth/callback/google` before exposing the service. `web_auth_url` must be a real HTTPS origin under customer control; Terraform neither provisions DNS/custom domains nor derives it from a service URI.

The web service requires Cloud Run IAM invocation by default, even with application Google OAuth configured. After testing the owner sign-in and callback, a separate `allow_public_web_invoker = true` grants `allUsers` invocation **to web only**; application routes still enforce the verified owner email. The agent remains internal-ingress and IAM-private. No dev or localhost auth bypass is enabled. The agent uses a single minimum Cloud Run instance with CPU allocated while idle so its local Firestore poller can run; this has customer-billed cost even when no one is chatting. The web service can scale to zero.

This profile enables the Cloud Run, Secret Manager, and Vertex APIs; creates a dedicated web service account with selected-database Firestore access; grants Vertex access to web (for direct chat replies) and the existing runtime service account (for background turns); and creates both Cloud Run services. It does not build or scan images, seed the agent/models, check a live model response, configure OAuth or public DNS, provision backup/update/uninstall workflows, or connect to installer stages. Applying these resources is **not** evidence that the installation is runtime-ready or that PostgreSQL can be retired. Mobile bootstrap and non-chat web surfaces are still outside the minimal Firestore profile.

## Offline validation

CI uses Terraform 1.14.5 and the locked Google provider to validate this foundation without credentials:

```sh
terraform fmt -check -recursive
terraform init -backend=false -lockfile=readonly
terraform validate
terraform test
```

The tests use a mocked provider. They cover the explicit default-database creation guard, exact database-scoped IAM, retained delete protection, named database selection, invalid IDs, index deployment, foundation-only behavior without images, runtime digest and auth wiring, private defaults, and invalid runtime inputs. They do not establish that a customer project is empty, billing is enabled, a location or Vertex model is available, secrets exist, Cloud Run starts, OAuth works, or IAM works in Google Cloud. The live Firestore validation harness deploys the same indexes and exemptions into an isolated temporary database and waits for index operations before exercising queries.
