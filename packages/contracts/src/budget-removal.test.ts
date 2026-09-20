import { expect, it } from "vitest";
import { modelAttempt, startTurnRequest } from "./index.ts";

it("accepts turn requests without a budget and strips the obsolete input field", () => {
  const local = { prompt: "Do the work" };
  expect(startTurnRequest.parse(local)).not.toHaveProperty("budget");
  expect(startTurnRequest.parse({ ...local, budget: 0.000001 })).toEqual(
    startTurnRequest.parse(local),
  );
  expect(startTurnRequest.safeParse({ ...local, timeout: 0 }).success).toBe(false);
});

it("keeps durable model identity without a monetary reservation", () => {
  const call_id = "11111111-1111-4111-8111-111111111111";
  expect(modelAttempt.parse({ call_id })).toEqual({ call_id });
  expect(modelAttempt.safeParse({ call_id: "" }).success).toBe(false);
});
