CREATE TABLE "harnesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"slug" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"end_user_id" uuid,
	"provider" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"last4" text NOT NULL,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "budget_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model" text NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_ref" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_state" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "metering" text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reserved_usd" numeric(12, 6) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "max_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "run_token_hash" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_token_hash" text;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "harnesses_org_slug" ON "harnesses" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "harnesses_builtin_slug" ON "harnesses" USING btree ("slug") WHERE "harnesses"."org_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_keys_org_provider" ON "provider_keys" USING btree ("org_id","provider") WHERE "provider_keys"."end_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_keys_end_user_provider" ON "provider_keys" USING btree ("org_id","end_user_id","provider") WHERE "provider_keys"."end_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_token_hash" ON "runs" USING btree ("run_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_sandbox_token_hash" ON "runs" USING btree ("sandbox_token_hash");