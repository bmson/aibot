ALTER TABLE "watches" DROP CONSTRAINT "watches_tier_check";--> statement-breakpoint
ALTER TABLE "watch_fires" ADD COLUMN "excerpt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_tier_check" CHECK ("watches"."tier" IN ('notify','suggest'));