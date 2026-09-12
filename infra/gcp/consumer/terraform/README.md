# Customer-owned consumer foundation

This directory provisions the first customer-owned resources for a Firestore installation:

- required Google APIs;
- a **named** Firestore Native Standard database;
- private, versioned assets and source archive buckets with uniform access, public access prevention, and seven-day soft-delete retention;
- an immutable-tag Docker Artifact Registry repository; and
- a dedicated runtime service account with access to the named Firestore database and asset object administration. The source archive bucket has no runtime grant.

The configuration intentionally does not manage the project, billing account, Firestore `(default)` database, Cloud Run services, queues, secrets, or a publisher-owned installer. A name collision is allowed to fail during creation rather than silently adopting an existing resource. The database, buckets, and Artifact Registry repository use Terraform `prevent_destroy`. Firestore also enables server-side delete protection, and the buckets refuse forced deletion of their contents. Keep these resources in state; removing their resource blocks also removes Terraform lifecycle protection.

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

The bootstrap bucket is outside this state. Keep its versioning, retention, access policy, and backup procedure under the customer's operational controls. Do not put credentials, secret values, image digests, or owner-claim material in Terraform variables or outputs.

## Configuration

All ownership and collision-sensitive identifiers are explicit. A minimal variable file looks like:

```hcl
project_id             = "customer-project-id"
region                 = "us-central1"
installation_id        = "assistant-prod"
firestore_database_id  = "assistant-prod-db"
firestore_location_id  = "nam5"
assets_bucket_name     = "customer-project-id-assistant-assets"
source_bucket_name     = "customer-project-id-assistant-source"
artifact_repository_id = "assistant-prod"
```

The Firestore database ID cannot be `(default)` or UUID-like. This foundation does not import or adopt an existing database. Choose a Firestore location that is compatible with the customer's region and selected Google model endpoints; the database location is a durable choice.

The Google provider constraint permits compatible 8.x releases. The committed `.terraform.lock.hcl` records the provider version validated for this foundation; refresh that lock file deliberately when upgrading the provider.

This is a foundation only. Cloud Run images and services are deliberately absent until the runtime profile, verified image digests, authentication, queues, secrets, and installation manifest are ready.
