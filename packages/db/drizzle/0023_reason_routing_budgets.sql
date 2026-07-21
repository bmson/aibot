-- Phase 3 (model quality). Data-only; guarded so any value the owner has since
-- edited via the dashboard is left untouched (only rows still at the previous
-- default are lifted). Idempotent — safe to re-run.

-- Structured-output roles run at temperature 0 for deterministic, schema-valid
-- JSON (mitigates AI_NoObjectGeneratedError). Only rows whose params are still
-- the empty default are set.
UPDATE "model_roles"
SET "params" = '{"temperature":0}'::jsonb
WHERE "role" IN ('plan', 'classify', 'extract')
  AND ("params" IS NULL OR "params" = '{}'::jsonb);

-- Raise the spend ceilings to match interactive owner actions now running on the
-- reasoning model. Each row moves only if it still holds the prior default.
UPDATE "budgets" SET "limit_usd" = '0.50' WHERE "scope" = 'task_default' AND "limit_usd" = '0.25';
UPDATE "budgets" SET "limit_usd" = '4.00' WHERE "scope" = 'daily' AND "limit_usd" = '2.00';
UPDATE "budgets" SET "limit_usd" = '50.00' WHERE "scope" = 'monthly' AND "limit_usd" = '20.00';
