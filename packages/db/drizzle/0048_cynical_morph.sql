ALTER TABLE "response_checks" ADD COLUMN "output_verification_attempted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "response_checks" ADD COLUMN "output_verification_revised" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "response_checks" ADD COLUMN "output_verification_unavailable" boolean DEFAULT false NOT NULL;