ALTER TABLE "credential_refs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "harnesses" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "managed_agent_refs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_servers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skills" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "credential_refs" CASCADE;--> statement-breakpoint
DROP TABLE "harnesses" CASCADE;--> statement-breakpoint
DROP TABLE "managed_agent_refs" CASCADE;--> statement-breakpoint
DROP TABLE "mcp_servers" CASCADE;--> statement-breakpoint
DROP TABLE "skills" CASCADE;--> statement-breakpoint
DROP INDEX "runs_token_hash";--> statement-breakpoint
DROP INDEX "runs_sandbox_token_hash";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "harness";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "metering";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "run_token_hash";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "sandbox_token_hash";