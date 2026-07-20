-- Preserve the oldest enabled copy of each semantic rule, and repoint approval
-- history before removing duplicates so the new unique index can be installed
-- safely on databases that already received repeated Always/Never choices.
WITH ranked AS (
  SELECT
    "id",
    first_value("id") OVER (
      PARTITION BY "agent_id", "tool_name", "template_key", "match", "effect"
      ORDER BY "enabled" DESC, "created_at" ASC, "id" ASC
    ) AS "keep_id",
    row_number() OVER (
      PARTITION BY "agent_id", "tool_name", "template_key", "match", "effect"
      ORDER BY "enabled" DESC, "created_at" ASC, "id" ASC
    ) AS "duplicate_number"
  FROM "approval_policies"
)
UPDATE "approvals" a
SET "created_policy_id" = ranked."keep_id"
FROM ranked
WHERE ranked."duplicate_number" > 1
  AND a."created_policy_id" = ranked."id";

WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "agent_id", "tool_name", "template_key", "match", "effect"
      ORDER BY "enabled" DESC, "created_at" ASC, "id" ASC
    ) AS "duplicate_number"
  FROM "approval_policies"
)
DELETE FROM "approval_policies" p
USING ranked
WHERE ranked."duplicate_number" > 1
  AND p."id" = ranked."id";

CREATE UNIQUE INDEX "approval_policies_identity_idx" ON "approval_policies" USING btree ("agent_id","tool_name","template_key","match","effect");
