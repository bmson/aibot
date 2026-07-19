-- Data migration: the `extract` role's primary model (qwen/qwen3-30b) intermittently
-- returns JSON that fails schema parsing (AI_NoObjectGeneratedError), which was
-- dead-lettering the nightly memory extraction/consolidation jobs. Promote the
-- stronger structured-output model to primary and keep a distinct, capable fallback.
-- Runtime code already retries an unparseable object on the fallback and skips a
-- single stubborn item; this removes the wasted first attempt for the common case.
-- Idempotent — safe to re-run.
UPDATE "model_roles"
SET "primary_model" = 'deepseek/deepseek-chat',
    "fallback_model" = 'openai/gpt-oss-120b'
WHERE "role" = 'extract';
