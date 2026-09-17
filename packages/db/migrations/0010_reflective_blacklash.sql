CREATE TABLE "pi_commits" (
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"first_seq" integer NOT NULL,
	"last_seq" integer NOT NULL,
	"digest" text NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "pi_commits_org_id_session_id_commit_id_pk" PRIMARY KEY("org_id","session_id","commit_id")
);
--> statement-breakpoint
CREATE TABLE "pi_entries" (
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"id" text NOT NULL,
	"parent_id" text,
	"seq" integer NOT NULL,
	"timestamp" bigint NOT NULL,
	"type" text NOT NULL,
	"custom_type" text,
	"data" text NOT NULL,
	CONSTRAINT "pi_entries_org_id_session_id_id_pk" PRIMARY KEY("org_id","session_id","id")
);
--> statement-breakpoint
CREATE TABLE "pi_lists" (
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"seq" integer NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "pi_lists_org_id_session_id_namespace_key_seq_pk" PRIMARY KEY("org_id","session_id","namespace","key","seq")
);
--> statement-breakpoint
CREATE TABLE "pi_sessions" (
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"format" text NOT NULL,
	"next_seq" integer NOT NULL,
	"stats" text NOT NULL,
	CONSTRAINT "pi_sessions_org_id_session_id_pk" PRIMARY KEY("org_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "pi_usage" (
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "pi_usage_org_id_session_id_id_pk" PRIMARY KEY("org_id","session_id","id")
);
--> statement-breakpoint
CREATE TABLE "pi_values" (
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"seq" integer NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "pi_values_org_id_session_id_namespace_key_pk" PRIMARY KEY("org_id","session_id","namespace","key")
);
--> statement-breakpoint
ALTER TABLE "pi_commits" ADD CONSTRAINT "pi_commits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_entries" ADD CONSTRAINT "pi_entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_lists" ADD CONSTRAINT "pi_lists_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_sessions" ADD CONSTRAINT "pi_sessions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_usage" ADD CONSTRAINT "pi_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pi_values" ADD CONSTRAINT "pi_values_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pi_commits_first_seq" ON "pi_commits" USING btree ("org_id","session_id","first_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "pi_entries_seq" ON "pi_entries" USING btree ("org_id","session_id","seq");--> statement-breakpoint
CREATE INDEX "pi_entries_type" ON "pi_entries" USING btree ("org_id","session_id","type","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "pi_usage_seq" ON "pi_usage" USING btree ("org_id","session_id","seq");