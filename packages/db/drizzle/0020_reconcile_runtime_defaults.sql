-- Runtime defaults are part of the deployed behavior, not one-time demo data.
-- Normal releases historically ran migrations without seed.ts, so existing
-- production databases could miss the owner-calendar autonomy rule indefinitely.
-- Install/repair the safety-scoped policy from durable owner contact data here;
-- release.sh now also runs the idempotent seed after every migration; that
-- reconciliation likewise prefers these durable contact values over env defaults.
INSERT INTO "approval_policies" (
  "agent_id",
  "tool_name",
  "template_key",
  "match",
  "effect",
  "created_via"
)
SELECT
  a."id",
  'calendar.create_event',
  'calendar.owner_attendee_only',
  jsonb_build_object(
    'emails',
    COALESCE(
      (SELECT to_jsonb(c."emails") FROM "contacts" c WHERE c."trust" = 'owner' LIMIT 1),
      '[]'::jsonb
    )
  ),
  'allow',
  'seed'
FROM "agents" a
WHERE NOT EXISTS (
  SELECT 1
  FROM "approval_policies" p
  WHERE p."agent_id" = a."id"
    AND p."template_key" = 'calendar.owner_attendee_only'
);

UPDATE "approval_policies" p
SET "match" = jsonb_build_object(
      'emails',
      COALESCE(
        (SELECT to_jsonb(c."emails") FROM "contacts" c WHERE c."trust" = 'owner' LIMIT 1),
        '[]'::jsonb
      )
    ),
    "updated_at" = now()
WHERE p."template_key" = 'calendar.owner_attendee_only'
  AND p."created_via" = 'seed';

UPDATE "approval_policies" p
SET "match" = jsonb_build_object(
      'phone',
      COALESCE(
        (SELECT c."phones"[1] FROM "contacts" c WHERE c."trust" = 'owner' LIMIT 1),
        ''
      )
    ),
    "updated_at" = now()
WHERE p."template_key" = 'sms.reply_to_owner'
  AND p."created_via" = 'seed';
