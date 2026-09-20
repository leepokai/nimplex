import { expect, it } from "vitest";
import { createRunRequest, modelAttempt, startTurnRequest } from "./index.ts";

it("accepts local and hosted requests without budget and strips obsolete input fields", () => {
  const local = { prompt: "Do the work" };
  expect(startTurnRequest.parse(local)).not.toHaveProperty("budget");
  expect(startTurnRequest.parse({ ...local, budget: 0.000001 })).toEqual(
    startTurnRequest.parse(local),
  );
  const hosted = {
    instructions: "Do the work",
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
  };
  expect(createRunRequest.parse(hosted)).not.toHaveProperty("budget_usd");
  expect(createRunRequest.parse({ ...hosted, budget_usd: 0.000001 })).toEqual(
    createRunRequest.parse(hosted),
  );
  expect(startTurnRequest.safeParse({ ...local, timeout: 0 }).success).toBe(false);
  expect(createRunRequest.safeParse({ ...hosted, max_duration_seconds: 0 }).success).toBe(false);
});

it("keeps durable model identity without a monetary reservation", () => {
  const call_id = "11111111-1111-4111-8111-111111111111";
  expect(modelAttempt.parse({ call_id })).toEqual({ call_id });
  expect(modelAttempt.safeParse({ call_id: "" }).success).toBe(false);
});
