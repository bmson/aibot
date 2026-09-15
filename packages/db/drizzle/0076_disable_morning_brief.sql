-- 'morning-brief' is retired in favor of 'daily-briefing' (see seed.ts): the
-- two ran fifteen minutes apart over the same calendar/mail tables with no
-- cross-surface dedupe, and daily-briefing already covers every category
-- morning-brief did (calendar, mail, goals, upcoming dates) as a deterministic
-- job rather than unverifiable free text. The seeder never deletes/disables a
-- row dropped from scheduleSeed, so disable any already-seeded instance here
-- rather than deleting it — history stays, and an owner can re-enable it.
UPDATE "schedules"
SET
  "enabled" = false,
  "updated_at" = now()
WHERE
  "name" = 'morning-brief';
