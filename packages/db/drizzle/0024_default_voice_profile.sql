-- Phase 5 (more human). Activate the outbound voice rewrite by giving the
-- singleton voice profile an honest baseline when it is still empty. Guarded so
-- the owner's own edits (any non-empty description) survive. Idempotent.
UPDATE "voice_profile"
SET
  "description" = 'Plain, warm, and direct — writes like a capable human colleague. Short sentences, concrete, no corporate filler.',
  "dos" = '["Get to the point; lead with the useful thing","Sound warm and human, not formal or robotic","Keep sentences short and concrete"]'::jsonb,
  "donts" = '["No corporate filler or AI throat-clearing (\"I hope this helps\", \"As an AI\", \"Certainly!\")","No hedging preambles before the answer","Do not over-explain or pad"]'::jsonb,
  "updated_at" = now()
WHERE "id" = 1 AND "description" = '';
