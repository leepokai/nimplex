import { describe, expect, it } from "vitest";
import { needsNativeSandbox } from "./bash-routing.ts";

describe("pre-execution bash routing", () => {
  it("keeps supported pipelines in the VFS", () => {
    expect(needsNativeSandbox("echo hello > a; cat a | grep hello")).toBe(false);
    expect(needsNativeSandbox("for i in 1 2; do echo $i; done")).toBe(false);
  });
  it("escalates the whole script before its first write", () => {
    expect(needsNativeSandbox("echo once >> a; npm test")).toBe(true);
  });
  it("finds native commands inside command substitutions and branches", () => {
    expect(needsNativeSandbox('echo "$(node -v)"')).toBe(true);
    expect(needsNativeSandbox("if true; then git status; fi")).toBe(true);
  });
  it("handles dynamic execution conservatively", () => {
    for (const command of [
      "$CMD",
      "eval 'npm test'",
      "echo node | xargs",
      "command node -v",
      "env node -v",
      "find . -exec node {} \\;",
    ]) {
      expect(needsNativeSandbox(command)).toBe(true);
    }
  });
});
