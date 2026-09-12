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

The new `consumer:install` command builds the customer-owned infrastructure foundation. It does **not** deploy the application or finish owner onboarding. It always reports `runtimeReady: false`.

Use Node/pnpm, gcloud credentials for the target project, Application Default Credentials for Terraform, and Terraform 1.14.5. The target project must have billing available. Generate a canonical source archive from the selected release checkout:

```sh
git archive --format=tar --output=assistant-source.tar HEAD
shasum -a 256 assistant-source.tar
git rev-parse HEAD
```

Put that full SHA and digest into the installation input, then generate the preview and manifest using the commands above. The provisioner checks the digest and compares the five consumer Terraform foundation files against the trusted checkout. It rejects archive path overrides and links and executes only those verified files in an isolated directory. Archives with a top-level repository prefix are unsupported; use the canonical archive command above. Source hashing binds local bytes and does not independently authenticate the release publisher.

From the matching repository root, preview the cloud foundation:

```sh
pnpm consumer:install --manifest install-manifest.json \
  --archive assistant-source.tar --state .assistant-install/manifest.json \
  --state-bucket YOUR_PROJECT-YOUR_INSTALLATION-state \
  --terraform-dir infra/gcp/consumer/terraform
```

The preview performs read-only cloud checks and reports missing APIs. Add `--apply` to enable required APIs, create the private state bucket, upload the release receipt, and apply the foundation. Resources and Terraform state stay in the selected customer's project. It refuses adoption of an existing selected Firestore database and requires matching receipts before reusing a bootstrap bucket.

Repeat the identical command to resume from persisted stages. Terraform state is remote and the last local completed stage is updated atomically. If creation of the state bucket succeeds but upload of its ownership receipt fails, the next run stops for manual ownership verification; it must not automatically adopt that unverified bucket. Failed Terraform work directories are retained for recovery. No initialized/ready stage is recorded until future runtime deployment and readiness work exists.
