ALTER TABLE "model_roles" DROP CONSTRAINT "model_roles_role_check";--> statement-breakpoint
ALTER TABLE "model_roles" ADD CONSTRAINT "model_roles_role_check" CHECK ("model_roles"."role" IN ('plan','classify','extract','draft','reason','rewrite','embed','batch'));--> statement-breakpoint
-- The reason fallback must still drive the tool-calling loop (deepseek answers
-- with prose instead of tool calls); classify gets the same reliability upgrade
-- extract got in 0019. Only rows still at the old seeded values are touched, so
-- an owner's explicit routing choices survive.
UPDATE "model_roles" SET "fallback_model" = 'openai/gpt-oss-120b', "updated_at" = now()
  WHERE "role" = 'reason' AND "fallback_model" = 'deepseek/deepseek-chat';--> statement-breakpoint
UPDATE "model_roles" SET "primary_model" = 'deepseek/deepseek-chat', "updated_at" = now()
  WHERE "role" = 'classify' AND "primary_model" = 'qwen/qwen3-30b-a3b-instruct-2507';--> statement-breakpoint
-- Nightly synthesis (skill reflection, dreams, self-improvement) moves off the
-- most expensive model onto a capable cheap one. Guarded on the referenced
-- models existing: on a FRESH database this migration runs before seed, the
-- models table is empty, and seed inserts the role itself moments later.
INSERT INTO "model_roles" ("role", "primary_model", "fallback_model", "params")
  SELECT 'batch', 'openai/gpt-oss-120b', 'deepseek/deepseek-chat', '{}'
  WHERE EXISTS (SELECT 1 FROM "models" WHERE "id" = 'openai/gpt-oss-120b')
    AND EXISTS (SELECT 1 FROM "models" WHERE "id" = 'deepseek/deepseek-chat')
  ON CONFLICT ("role") DO NOTHING;
