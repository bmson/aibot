CREATE TABLE "model_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"api_key_encrypted" text,
	"vertex_project" text,
	"vertex_location" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connections_kind_check" CHECK ("model_connections"."kind" IN ('openrouter','openai','vertex','openai_compatible'))
);
