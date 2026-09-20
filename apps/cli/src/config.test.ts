import { expect, it } from "vitest";
import { HELP, readOptions } from "./config.ts";

it("accepts uncapped tasks, retains duration limits, and rejects the removed budget flag", () => {
  expect(readOptions(["--timeout", "300", "Work"])).toMatchObject({ prompt: "Work", timeout: 300 });
  expect(readOptions(["Work"])).not.toHaveProperty("budget");
  expect(() => readOptions(["--budget", "0.2", "Work"])).toThrow("--budget");
  expect(() => readOptions(["--timeout", "0", "Work"])).toThrow("--timeout");
  expect(HELP).not.toContain("--budget");
});
