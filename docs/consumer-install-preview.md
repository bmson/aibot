# Offline consumer installation preview

`pnpm install:plan --input install-input.json` validates a proposed installation and prints JSON. It needs no Google sign-in, runtime environment file, database credentials, or model API key. It does not call a provisioner, enable APIs, create resources, or write a manifest to disk. `pnpm install:plan --help` shows usage.

This is a developer preview, not the finished single-click installer. The response always contains `mode: "preview-only"` and `runtimeGated: true`, plus the remaining implementation and live-validation gates.

The response also contains `databaseCreationIntent`, which identifies the selected database and records a create-only, no-adoption intent. Its `absenceVerification.requiredBeforeProvisioning` value is `true` while `performed` remains `false`: a future authenticated provisioner must verify that the selected database is absent before attempting creation. This applies equally to `(default)` and named databases.

## Input

Provide these fields in a local JSON file:

- `identity`: `installationId`, `projectId`, `region`, `databaseId`, and `release` containing `commitSha` (40 hexadecimal characters) and `archiveDigest` (`sha256:` plus 64 hexadecimal characters).
- `modules`: module names from the repository registry; `[]` selects no optional modules.
- `modelProvider`: `google` or `openrouter`.
- `resources`: recorded resource declarations; use `[]` for a new preview.
- `createdAt`: an ISO UTC timestamp, such as `2026-09-12T00:00:00.000Z`.
- Optional `embeddingModel` and `embeddingDimension` record the planned embedding space. They do not verify model availability or migrate existing vectors.

Use `(default)` for a new eligible project or a valid named database (4–63 characters), an installation ID of 4–21 characters, and a standard Google region. A future creator must verify that `(default)` is absent before creating it and must never adopt an existing database; this offline preview performs neither check. UUID-like database IDs remain rejected.

Use the exact source archive's digest and its full release commit. Validation checks syntax and identity consistency; it does not establish the source archive's authenticity or verify its contents against a remote release. Do not include credentials or environment variables. Unknown fields are rejected.

For machine-readable output without pnpm's command heading:

```sh
pnpm --silent install:plan --input install-input.json > install-preview.json
```

The command does not create `install-input.json`. A caller must deliberately create that file from the intended installation choices. Reusing an identical input produces identical output.

## Local state and archive verification

The preview remains read-only. An explicit local-state command can persist a validated preview manifest after checking the selected source archive:

```sh
node --input-type=module -e "import fs from 'node:fs'; const preview = JSON.parse(fs.readFileSync('install-preview.json', 'utf8')); fs.writeFileSync('install-manifest.json', JSON.stringify(preview.manifest, null, 2));"
pnpm install:state --write --state .assistant-install/manifest.json \
  --manifest install-manifest.json --archive assistant-source.tar.gz
```

The archive is streamed for SHA-256 verification against `identity.release.archiveDigest`; it is never extracted or executed. The digest binds the bytes in the local regular file at verification time and does not prove Git provenance or prevent a later file replacement. The state file is written through a same-directory temporary file, fsynced, and atomically renamed. Directory fsync is best effort on supported filesystems, so this does not guarantee persistence across every power-loss scenario. A lock and expected-previous-manifest comparison prevent concurrent or stale overwrites. A leftover lock fails closed; after confirming no writer is active, remove the `.lock` file manually and retry. Use `--expected PATH` for a compare-and-swap retry with the same immutable identity and selection; preview reconfiguration has no implicit overwrite path.

Resume is an explicit read operation:

```sh
pnpm install:state --resume --state .assistant-install/manifest.json \
  --input install-input.json
```

Resume checks the immutable identity and selected modules/provider/embedding settings. It does not advance stages, call Google Cloud, execute source, or claim that a commit hash proves provenance. Cloud stages remain unverified until a future orchestrator performs and records them.

## Manifest and resume behavior

The versioned manifest records the target identity, selected modules/provider, resource declarations, and an ordered stage prefix. The pure `advanceInstallationStage` and `resumeInstallation` helpers support idempotent stage retries and invalidate a resume when the expected immutable identity changes. These helpers are data transformations; they do not authorize a Google account, execute stages, or prove that a stage ran successfully. A future orchestrator must record a completed stage only after verifying its real result.

Resources declare an owner of `bootstrap`, `terraform`, or `preexisting`. Installation-owned resources must match the installation identity; preexisting resources require a null installation ID. Duplicate physical resource identities and foreign-project ownership claims are rejected. These declarations are not proof of cloud ownership. Provisioning and uninstall must additionally verify actual resource names, labels, and state before adopting or deleting anything. Existing/default resources must not be silently adopted or removed.

The preview derives optional workers, API intent, scheduler declarations, and module billing metadata from the existing module registry. Base Google APIs are reported separately. This is an intended configuration, not a cloud readiness check, a priced quote, or a guarantee that an installation can run yet. Terraform/bootstrap execution, the remaining Firestore application adapters, Google model configuration, owner authentication, and live IAM/index/model validation are separate gates.

## Authenticated foundation provisioning

`consumer:install` builds the customer-owned infrastructure foundation. Supplying both `--images` and `--runtime-config` also opts in to the minimal Cloud Run web and agent profile after the foundation is provisioned. It still reports `runtimeReady: false`: a ready Cloud Run revision does not prove owner sign-in, a model response, or complete onboarding.

Before a later runtime stage starts containers, `pnpm firestore:runtime-data-preflight` can read the selected installation's configured owner agent, budget policy, and eight model roles/catalog entries. It requires explicit `GCP_PROJECT`, `ASSISTANT_WORKSPACE_ID`, `FIRESTORE_AGENT_ID`, `FIRESTORE_EMBEDDING_SPACE`, and `LLM_PROVIDER` environment values. The JSON result identifies missing or inconsistent records without printing owner content; a non-ready result exits nonzero. This is a read-only data check, not an authenticated model call, IAM test, or readiness claim.

For a fresh installation, the [minimal runtime seed](consumer-runtime-seed.md) can create this data from an explicit customer plan. Pass `--seed-plan /private/path/runtime-seed.json` to `consumer:install` to run it after the foundation and before the optional Cloud Run runtime stage. The same create-only seed remains available as a standalone command. It does not mark the runtime ready.

Use Node/pnpm, gcloud credentials for the target project, Application Default Credentials for Terraform, and Terraform 1.14.5. The target project must have billing available. Generate a canonical source archive from the selected release checkout:

```sh
git archive --format=tar.gz --output=assistant-source.tar.gz HEAD
shasum -a 256 assistant-source.tar.gz
git rev-parse HEAD
```

Put that full SHA and digest into the installation input, then generate the preview and manifest using the commands above. The provisioner checks the digest and compares the five consumer Terraform foundation files against the trusted checkout. It rejects archive path overrides and links and executes only those verified files in an isolated directory. Archives with a top-level repository prefix are unsupported; use the canonical archive command above. Source hashing binds local bytes and does not independently authenticate the release publisher.

From the matching repository root, preview the cloud foundation:

```sh
pnpm consumer:install --manifest install-manifest.json \
  --archive assistant-source.tar.gz --state .assistant-install/manifest.json \
  --state-bucket YOUR_PROJECT-YOUR_INSTALLATION-state \
  --terraform-dir infra/gcp/consumer/terraform
```

The preview performs read-only cloud checks and reports missing APIs. Add `--apply` to enable required APIs, create the private state bucket, upload the release receipt, and apply the foundation, including Firestore indexes and single-field exemptions. The installer verifies `firestore-indexes.tf` and its shared JSON specification against the selected archive and trusted checkout, then copies both into the isolated Terraform workspace at their original relative paths. Resources and Terraform state stay in the selected customer's project. It refuses adoption of an existing selected Firestore database and requires a matching receipt, project number, region, and enforced access protection before reusing a bootstrap bucket. The backend bucket and receipt are recorded in the installation inventory.

To include the seed, add `--seed-plan` to both preview and apply commands. The plan's project, installation, Google provider, and embedding model and dimensions must match the installation manifest; supply `embeddingModel` and `embeddingDimension` when creating that manifest. If `--runtime-config` is also supplied, its agent ID, owner email, and full embedding space must match the seed plan. The preview validates these inputs without creating seed records. Apply provisions the foundation, runs the create-only seed, then deploys the optional runtime. A failed seed leaves the saved foundation stage intact; rerunning the identical plan resumes only its own marker and refuses foreign records. An initialized runtime can only be retried with its existing seed marker. Keep the seed plan private: it contains the owner email and explicitly verified model prices, which the installer does not print.

Repeat the identical command to resume from persisted stages. Terraform state is remote and the last local completed stage is updated atomically. If creation of the state bucket succeeds but upload of its ownership receipt fails, the next run stops for manual ownership verification; it must not automatically adopt that unverified bucket. Failed Terraform work directories are retained for recovery. After Terraform apply, the installer reads the selected Firestore database's composite indexes and explicit field exemptions through the authenticated `gcloud` CLI. It compares their definitions with the verified archive manifest and requires every composite index to be `READY` before recording `provisioned`. Missing, building, extra, or foreign-scoped configurations leave a new install at `bootstrapped` for an explicit retry; the verification makes no cloud changes. A resumed `provisioned` install is rechecked and fails closed if its indexes have drifted, without another foundation Terraform apply. An archive from before index packaging fails the trusted-file check and requires an explicit recovery decision.

For the optional runtime, first publish images with `pnpm consumer:publish-images` as described in [customer image publishing](consumer-image-publish.md). Its JSON manifest must match the installation's source SHA, project, region, and repository. Create three enabled, numbered Secret Manager versions and configure the owner Google OAuth client for the intended HTTPS origin. Then supply a JSON runtime config containing only these fields:

```json
{
  "firestoreAgentId": "11111111-1111-4111-8111-111111111111",
  "firestoreEmbeddingSpace": {
    "provider": "vertex",
    "model": "text-embedding-005",
    "dimensions": 768,
    "revision": "customer-seed-v1"
  },
  "ownerEmail": "owner@example.com",
  "webAuthUrl": "https://assistant.example.com",
  "authSecretVersion": 1,
  "googleClientIdVersion": 1,
  "googleClientSecretVersion": 1
}
```

Run the foundation command with `--images ./customer-image-digests.json --runtime-config ./runtime-config.json --apply`. The installer verifies the two immutable image references exist in the customer repository and that each secret version is enabled. It copies the archive's `runtime.tf` only after checking that its bytes match the trusted checkout, then applies the profile with the same customer state backend. It checks both Cloud Run services have a ready revision using the expected digest before recording `initialized`. Failed checks leave `provisioned` for a retry with the same inputs. An initialized checkpoint records an input fingerprint and refuses a changed image or runtime config on resume. No secret value is read, passed to Terraform, written to state, or printed. The runtime remains private by default; owner OAuth, public access, and a real authenticated conversation require separate verification before a `ready` claim.

To make the initialized web service reachable for owner sign-in, finish the customer-owned Google Auth Platform setup first. In **Google Auth Platform → Clients**, create a **Web application** client in the same customer project, configure its consent screen and owner/test-user access, and add the exact authorized redirect URI `https://assistant.example.com/api/auth/callback/google` (substitute the `webAuthUrl` origin). Store its client ID and secret in the numbered `<installation_id>-google-client-id` and `<installation_id>-google-client-secret` Secret Manager versions referenced by the unchanged runtime config. Route the configured HTTPS origin to the deployed web service and verify the certificate and host routing; the installer reports the service's `run.app` URL so the customer can establish the mapping. This OAuth client and domain setup is a customer console step, not a single-click installer action. Google requires an [exact redirect URI match](https://developers.google.com/identity/protocols/oauth2/web-server), and its [Web client setup](https://developers.google.com/workspace/guides/create-credentials) is performed in Google Auth Platform.

Resume the same install command with `--owner-access-callback https://assistant.example.com/api/auth/callback/google`. Without `--apply`, this is a read-only preview: it verifies the matching initialized runtime, enabled numbered secret versions, web URL, owner auth environment, and service IAM, and returns the URL/callback handoff. After checking the OAuth client configuration and HTTPS routing, add `--apply`; the installer reapplies the verified customer Terraform archive with `allow_public_web_invoker=true`, grants `allUsers` Cloud Run invocation to **web only**, and checks that the agent has no service-level public invoker binding. The agent's own Cloud Run IAM check stays enabled. This follows Google's [service-specific public invoker binding](https://cloud.google.com/run/docs/authenticating/public) and [IAM policy inspection](https://cloud.google.com/run/docs/securing/managing-access). Audit inherited project-level grants separately. The step is safe to retry, never reads secret payloads, keeps the installation at `initialized`, and continues to report `runtimeReady: false` until owner sign-in and an authenticated chat/model response are verified.
