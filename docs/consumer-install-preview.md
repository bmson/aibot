# Offline consumer installation preview

`pnpm install:plan --input install-input.json` validates a proposed installation and prints JSON. It needs no Google sign-in, runtime environment file, database credentials, or model API key. It does not call a provisioner, enable APIs, create resources, or write a manifest to disk. `pnpm install:plan --help` shows usage.

This is a developer preview, not the finished single-click installer. The response always contains `mode: "preview-only"` and `runtimeGated: true`, plus the remaining implementation and live-validation gates.

## Input

Provide these fields in a local JSON file:

- `identity`: `installationId`, `projectId`, `region`, `databaseId`, and `release` containing `commitSha` (40 hexadecimal characters) and `archiveDigest` (`sha256:` plus 64 hexadecimal characters).
- `modules`: module names from the repository registry; `[]` selects no optional modules.
- `modelProvider`: `google` or `openrouter`.
- `resources`: recorded resource declarations; use `[]` for a new preview.
- `createdAt`: an ISO UTC timestamp, such as `2026-09-12T00:00:00.000Z`.
- Optional `embeddingModel` and `embeddingDimension` record the planned embedding space. They do not verify model availability or migrate existing vectors.

Use a named database (4–63 characters), an installation ID of 4–21 characters, and a standard Google region. The preview rejects `(default)` and UUID-like database IDs.

Use the exact source archive's digest and its full release commit. Validation checks syntax and identity consistency; it does not establish the source archive's authenticity or verify its contents against a remote release. Do not include credentials or environment variables. Unknown fields are rejected.

For machine-readable output without pnpm's command heading:

```sh
pnpm --silent install:plan --input install-input.json > install-preview.json
```

The command does not create `install-input.json`. A caller must deliberately create that file from the intended installation choices. Reusing an identical input produces identical output.

## Manifest and resume behavior

The versioned manifest records the target identity, selected modules/provider, resource declarations, and an ordered stage prefix. The pure `advanceInstallationStage` and `resumeInstallation` helpers support idempotent stage retries and invalidate a resume when the expected immutable identity changes. These helpers are data transformations; they do not authorize a Google account, execute stages, or prove that a stage ran successfully. A future orchestrator must record a completed stage only after verifying its real result.

Resources declare an owner of `bootstrap`, `terraform`, or `preexisting`. Installation-owned resources must match the installation identity; preexisting resources require a null installation ID. Duplicate physical resource identities and foreign-project ownership claims are rejected. These declarations are not proof of cloud ownership. Provisioning and uninstall must additionally verify actual resource names, labels, and state before adopting or deleting anything. Existing/default resources must not be silently adopted or removed.

The preview derives optional workers, API intent, scheduler declarations, and module billing metadata from the existing module registry. Base Google APIs are reported separately. This is an intended configuration, not a cloud readiness check, a priced quote, or a guarantee that an installation can run yet. Terraform/bootstrap execution, the remaining Firestore application adapters, Google model configuration, owner authentication, and live IAM/index/model validation are separate gates.
