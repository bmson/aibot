ALTER TABLE "tasks" ADD COLUMN "queue_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_events_reservation_idx" ON "cost_events" USING btree ("reservation_id") WHERE "cost_events"."reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cost_reservations_task_idx" ON "cost_reservations" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_task_created_idx" ON "messages" USING btree ("task_id","created_at") WHERE "messages"."task_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_embedding_backfill_idx" ON "messages" USING btree ("created_at") WHERE "messages"."embedding" IS NULL AND "messages"."role" IN ('user','assistant') AND length("messages"."text") > 20;--> statement-breakpoint
CREATE INDEX "tool_calls_rate_idx" ON "tool_calls" USING btree ("tool_name","status","created_at");--> statement-breakpoint
CREATE INDEX "approvals_task_requested_idx" ON "approvals" USING btree ("task_id","requested_at");--> statement-breakpoint
CREATE INDEX "tasks_pending_updated_idx" ON "tasks" USING btree ("updated_at") WHERE "tasks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tasks_sleeping_run_after_idx" ON "tasks" USING btree ("run_after") WHERE "tasks"."status" IN ('sleeping','waiting_budget');--> statement-breakpoint
CREATE INDEX "tasks_running_locked_idx" ON "tasks" USING btree ("locked_until") WHERE "tasks"."status" = 'running';
