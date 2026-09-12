CREATE TABLE "maintenance_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
