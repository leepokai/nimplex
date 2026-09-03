CREATE TABLE "managed_agent_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"remote_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_agent_refs" ADD CONSTRAINT "managed_agent_refs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_agent_refs_org_kind_key" ON "managed_agent_refs" USING btree ("org_id","kind","key");