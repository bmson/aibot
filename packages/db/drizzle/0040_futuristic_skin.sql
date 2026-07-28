CREATE INDEX "tasks_conversation_idx" ON "tasks" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "tasks_goal_idx" ON "tasks" USING btree ("goal_id");