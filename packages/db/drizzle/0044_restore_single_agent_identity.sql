DO $$
DECLARE
  canonical_id uuid;
  desired_email text;
  desired_name text;
  duplicate record;
  fk record;
BEGIN
  IF (SELECT count(*) FROM agents) <= 1 THEN
    RETURN;
  END IF;

  -- The original agent owns the historical goals, memories, conversations, and
  -- tasks. A deploy-time seed reconciliation may have inserted a newer row when
  -- identity environment values drifted. Keep the oldest row and fold every
  -- newer identity back into it.
  SELECT id
    INTO canonical_id
    FROM agents
   ORDER BY created_at ASC, id ASC
   LIMIT 1;

  -- Preserve the identity values from the most recently created row so the next
  -- seed run matches the canonical row by email instead of creating it again.
  SELECT email, name
    INTO desired_email, desired_name
    FROM agents
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  -- Two primary conversations cannot share one agent. The original primary is
  -- retained; duplicate conversations remain available as ordinary history.
  UPDATE conversations
     SET is_primary = false
   WHERE agent_id <> canonical_id
     AND is_primary = true;

  -- Seed-created policies are deterministic defaults and may collide with the
  -- canonical agent's existing defaults when their agent_id is reassigned.
  DELETE FROM approval_policies
   WHERE agent_id <> canonical_id
     AND created_via = 'seed';

  -- Reassign every direct foreign key to agents. Using the catalog keeps this
  -- recovery complete as new agent-owned tables are added.
  FOR fk IN
    SELECT
      conrelid::regclass AS table_name,
      a.attname AS column_name
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = 'agents'::regclass
      AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format(
      'UPDATE %s SET %I = $1 WHERE %I <> $1',
      fk.table_name,
      fk.column_name,
      fk.column_name
    ) USING canonical_id;
  END LOOP;

  -- Free the newest email before applying it to the canonical row.
  FOR duplicate IN
    SELECT id FROM agents WHERE id <> canonical_id
  LOOP
    UPDATE agents
       SET email = concat('recovered-', duplicate.id, '@invalid.local')
     WHERE id = duplicate.id;
  END LOOP;

  UPDATE agents
     SET email = desired_email,
         name = desired_name,
         updated_at = now()
   WHERE id = canonical_id;

  DELETE FROM agents WHERE id <> canonical_id;
END $$;
