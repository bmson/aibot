-- Phase 17 (occasions). Teach the already-seeded morning-brief schedule to
-- surface upcoming occasions (birthdays/anniversaries) at lead time via
-- occasions.list. morning-brief is NOT a seed-owned schedule (so re-seed does
-- not overwrite owner customizations), so update the live row here — guarded on
-- the exact previous instruction so an owner-edited brief is left untouched.
-- Idempotent: after the update the instruction no longer matches the guard.
UPDATE "schedules"
SET
  "task_template" = jsonb_set(
    "task_template",
    '{instruction}',
    to_jsonb(
      'Prepare the owner''s morning brief. Check: (1) today''s events on your calendar and the owner''s free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) upcoming occasions in the next several days (occasions.list) — birthdays or anniversaries to prepare for, (5) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, any upcoming occasion, and what you plan to do today. No fluff.'::text
    )
  ),
  "updated_at" = now()
WHERE
  "name" = 'morning-brief'
  AND "task_template"->>'instruction' = 'Prepare the owner''s morning brief. Check: (1) today''s events on your calendar and the owner''s free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, and what you plan to do today. No fluff.';
