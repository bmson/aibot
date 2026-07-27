# Backup, restore, and migration safety

Every production release creates a PostgreSQL custom-format dump before applying migrations. The
release stops if the backup fails. Backups are stored at:

```text
gs://WORKSPACE_BUCKET/workspace/WORKSPACE_ID/backups/pre-migration/RELEASE_SHA.dump
```

The backup job uses PostgreSQL 17 tooling, the agent's existing database secret, and object-only
workspace access. Serving containers never receive backup tooling.

## Restore drill

Test restores against a new, empty database. Never test by overwriting production.

```sh
gcloud storage cp \
  gs://YOUR_BUCKET/workspace/YOUR_WORKSPACE/backups/pre-migration/YOUR_SHA.dump \
  ./assistant-restore.dump

docker run --rm \
  --network host \
  -v "$PWD/assistant-restore.dump:/backup.dump:ro" \
  postgres:17 \
  pg_restore --clean --if-exists --no-owner --no-acl \
  --dbname="postgres://USER:PASSWORD@HOST:PORT/EMPTY_DATABASE" \
  /backup.dump
```

Then point a temporary Assistant deployment at the restored database and verify:

```sh
curl --fail https://TEMP_WEB_URL/api/ready
curl --fail https://TEMP_AGENT_URL/ready
```

Run a restore drill at least quarterly and before a high-risk schema migration. Record the backup
object, restore duration, row-count checks, and any manual steps.

## Migration rules

- Prefer additive changes: add nullable columns/tables first, deploy readers/writers, then enforce
  constraints in a later release.
- Do not rename or drop a column in the same release that stops writing the old shape.
- Data backfills must be resumable and bounded; they should not hold a long table lock.
- A migration failure stops deployment before either serving revision changes.
- Application rollback is safe only while the previous revision understands the migrated schema.
  If it does not, restore the pre-migration dump into a new database and repoint services.

## Retention

Workspace object versioning is enabled. Configure a provider lifecycle rule appropriate to the data
policy—for example, keep daily pre-migration dumps for 30 days and monthly recovery points for one
year. Do not delete the last verified restore point.
