# Prepare a fresh customer-owned installation

`pnpm consumer:prepare` checks one exact local release archive and writes a private local installation manifest, an incomplete runtime-seed template, and the future local state-file path. It does not read credentials, call Google Cloud, inspect or modify a database, extract or run the archive, or create cloud resources.

Supply the target project, region, a new installation ID, owner details, a full release commit SHA, and the archive's SHA-256 digest:

```sh
pnpm consumer:prepare \
  --project-id customer-project \
  --region us-west1 \
  --installation-id my-assistant \
  --owner-name 'Assistant Owner' \
  --owner-email owner@example.com \
  --timezone America/Los_Angeles \
  --embedding-model gemini-embedding-001 \
  --embedding-dimension 1536 \
  --archive ./assistant-source.tar.gz \
  --commit-sha FULL_40_CHARACTER_GIT_SHA \
  --archive-sha256 FULL_64_CHARACTER_SHA256 \
  --daily-backup-retention-days 7
```

The optional `--daily-backup-retention-days` selects a daily managed Firestore backup schedule and accepts whole days from 1 through 98. It is omitted by default to avoid adding backup-storage charges. The choice is validated and stored in the private manifest, then reused by `consumer:install` whenever it resumes or reapplies Terraform. Backup storage, PITR, and restores are billed to the customer project; see the [backup cost and restore runbook](../infra/gcp/consumer/terraform/README.md#managed-backups-and-restore).

Create the archive from the selected release checkout with `git archive --format=tar.gz --output=assistant-source.tar.gz HEAD`, and obtain its digest with `shasum -a 256 assistant-source.tar.gz`. The command recomputes the digest from the local regular file and refuses a mismatch. This verifies the archive bytes against the supplied digest; it does not authenticate who produced the archive or prove that the commit is its source.

By default, artifacts go under `.assistant-install/<installation-id>/`. The directory is created with mode `0700`; the manifest, seed template, and notes use mode `0600`. The generated manifest starts at `previewed`, selects the Google provider and no optional modules, binds the project/region/installation/database/release identity, and declares no preexisting resources. The database ID is `assistant-<installation-id>`. It records a create-only installation intent; the later provisioner must verify the database is absent and refuse to adopt it. Selection values, including optional backup retention, are immutable installation inputs; a later retention change requires a reviewed operator transition that keeps manifest and Terraform state aligned. The generated state path is reserved for later `consumer:install` use and is not created or advanced by preparation.

`consumer-install-command.txt` records the matching read-only `consumer:install` preview command, including the derived customer state-bucket name and the exact archive/manifest/state paths. Run it from the matching Assistant release checkout. Review the preview before adding `--apply` to provision resources.

The seed template includes the owner's name, email, and timezone, so keep the output directory private. The explicitly selected embedding model and current runtime dimension are recorded in both the immutable manifest and seed template. The model name is an operator choice, not a claim that the model is available or priced for the intended Vertex location. Verify its current regional availability, capabilities, and token prices against Vertex sources before completing the model catalog, role assignments, and budget. The template remains intentionally invalid input to `consumer:seed-runtime` until those prices and assignments are reviewed. The current runtime accepts only 1,536-dimensional embeddings.

The output directory is create-only. Choose a new installation ID or a different output directory to prepare another installation; this avoids overwriting existing local identity or state. Preparation is still a local input-generation step, not a finished one-entry installer: customer authorization, absence checks, provisioning, current model review, owner authentication, and runtime readiness remain later stages.
