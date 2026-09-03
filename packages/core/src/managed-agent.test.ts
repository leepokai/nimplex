import { describe, expect, it } from "vitest";
import { parseListCostUsd, translateManagedAgentEvent, usdToCents } from "./managed-agent.ts";

describe("usdToCents", () => {
  it("美元轉成分的整數字串，至少 1 分", () => {
    expect(usdToCents(0.3)).toBe("30");
    expect(usdToCents(25)).toBe("2500");
    expect(usdToCents(0.001)).toBe("1");
    expect(usdToCents(0.125)).toBe("13");
  });
});

describe("parseListCostUsd", () => {
  it("整數字串視為分；帶小數點視為美元；壞輸入回 null", () => {
    expect(parseListCostUsd({ amount: "123", currency: "USD" })).toBe(1.23);
    expect(parseListCostUsd({ amount: "0.36", currency: "USD" })).toBe(0.36);
    expect(parseListCostUsd({ amount: 50, currency: "USD" })).toBe(0.5);
    expect(parseListCostUsd(null)).toBeNull();
    expect(parseListCostUsd({ amount: "abc" })).toBeNull();
  });
});

describe("translateManagedAgentEvent", () => {
  it("agent.message 的每個 text block → message.delta", () => {
    const out = translateManagedAgentEvent({
      type: "agent.message",
      content: [{ type: "text", text: "哈囉" }, { type: "image" }, { type: "text", text: "世界" }],
    });
    expect(out.events).toEqual([
      { type: "message.delta", payload: { text: "哈囉" } },
      { type: "message.delta", payload: { text: "世界" } },
    ]);
    expect(out.outcome.kind).toBe("continue");
  });

  it("tool_use / tool_result 翻成 tool.call / tool.result，超長內容截斷", () => {
    const call = translateManagedAgentEvent({
      type: "agent.tool_use",
      id: "tu_1",
      name: "bash",
      input: { command: "ls" },
    });
    const callEvent = call.events[0];
    if (!callEvent) throw new Error("沒有翻出 tool.call");
    expect(callEvent.type).toBe("tool.call");
    expect((callEvent.payload as Record<string, unknown>).name).toBe("bash");

    const big = "x".repeat(10_000);
    const result = translateManagedAgentEvent({
      type: "agent.tool_result",
      tool_use_id: "tu_1",
      content: big,
    });
    const resultEvent = result.events[0];
    if (!resultEvent) throw new Error("沒有翻出 tool.result");
    const content = (resultEvent.payload as Record<string, unknown>).content as string;
    expect(content.length).toBeLessThan(big.length);
    expect(content.endsWith("…")).toBe(true);
  });

  it("session.usage 回填 spentUsd 並發 spend.updated", () => {
    const out = translateManagedAgentEvent({
      type: "session.usage",
      list_cost: { amount: "36", currency: "USD" },
      active_seconds: 12,
    });
    expect(out.spentUsd).toBe(0.36);
    expect(out.events[0]?.type).toBe("spend.updated");
  });

  it("status_idle 依 stop_reason 決定 run 走向", () => {
    const idle = (reason: string) =>
      translateManagedAgentEvent({ type: "session.status_idle", stop_reason: { type: reason } })
        .outcome;
    expect(idle("end_turn")).toEqual({ kind: "completed" });
    expect(idle("budget_reached")).toEqual({ kind: "budget_exceeded" });
    expect(idle("requires_action")).toEqual({ kind: "requires_action" });
    expect(idle("retries_exhausted").kind).toBe("failed");
  });

  it("terminated / error / 噪音事件", () => {
    expect(translateManagedAgentEvent({ type: "session.status_terminated" }).outcome.kind).toBe(
      "terminated",
    );
    const err = translateManagedAgentEvent({
      type: "session.error",
      error: { message: "boom" },
    });
    expect(err.outcome).toEqual({ kind: "failed", error: "boom" });
    expect(translateManagedAgentEvent({ type: "user.message" }).events).toEqual([]);
    expect(translateManagedAgentEvent({ type: "event_delta" }).events).toEqual([]);
    expect(translateManagedAgentEvent(null).events).toEqual([]);
  });
});
