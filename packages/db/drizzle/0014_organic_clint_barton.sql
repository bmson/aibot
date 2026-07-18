ALTER TABLE "application_confirmations" DROP CONSTRAINT "application_confirmations_status_check";--> statement-breakpoint
ALTER TABLE "application_confirmations" ALTER COLUMN "tracker_update" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "application_confirmations" ADD COLUMN "document_update" jsonb;--> statement-breakpoint
ALTER TABLE "application_confirmations" ADD COLUMN "action_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "application_confirmations" ADD CONSTRAINT "application_confirmations_status_check" CHECK ("application_confirmations"."status" IN ('awaiting_confirmation','confirmation_received','updated','partially_updated','update_unknown','update_failed','cancelled','expired'));