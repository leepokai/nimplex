CREATE TABLE "workspace_files" (
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_files_run_id_path_pk" PRIMARY KEY("run_id","path")
);
--> statement-breakpoint
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;