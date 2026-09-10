CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"status" text NOT NULL,
	"reserved_usd" numeric(12, 6) NOT NULL,
	"cost_usd" numeric(12, 6),
	"input_token_bound" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workspace_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_calls_run" ON "model_calls" USING btree ("org_id","run_id");