# Audits — historical records

The documents in this folder are **point-in-time review reports**, each
accurate as of the commit it was written against. They are kept as decision
records: they explain *why* the codebase has the guards it has (the fork-PR
deploy fix, the boundary checker, the OIDC release hardening) and what was
deliberately deferred at the time.

They are **not current documentation**. File names, line numbers, and
"current state" claims inside them refer to the code as it was then — check
the living references in the parent folder instead:

- [architecture.md](../architecture.md) — package boundaries and data flow
- [modules.md](../modules.md) — optional capability modules
- [operations.md](../operations.md) — monitoring, verification, releases
- [self-hosting.md](../self-hosting.md) — Cloud Run deployment

| Document | Date | Subject |
| --- | --- | --- |
| [platform-review.md](platform-review.md) | 2026-07 | Feasibility review of the composable-platform shift |
| [codebase-review.md](codebase-review.md) | 2026-07 | Full review: security, performance, capability, process |
| [codebase-review-2.md](codebase-review-2.md) | 2026-07 | Second pass: release-script injection, drift detection |
| [codebase-review-3.md](codebase-review-3.md) | 2026-08 | Dead-code removal and verification tooling |
| [codebase-review-4.md](codebase-review-4.md) | 2026-08 | Writing and organization: naming, comments, file layout |
