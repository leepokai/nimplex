UPDATE "model_calls" SET "status" = 'started' WHERE "status" = 'reserved';--> statement-breakpoint
ALTER TABLE "model_calls" DROP COLUMN "reserved_usd";--> statement-breakpoint
ALTER TABLE "model_calls" DROP COLUMN "input_token_bound";--> statement-breakpoint
ALTER TABLE "model_calls" DROP COLUMN "max_output_tokens";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "budget_usd";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "reserved_usd";
