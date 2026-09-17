import { describe, expect, it } from "vitest";
import { continuationMessages } from "./conversation.ts";

describe("continuationMessages", () => {
  it("retains committed tool pairs and removes calls without committed outcomes", () => {
    const source = {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Working" },
          { type: "toolCall", id: "done", name: "write", arguments: {} },
          { type: "toolCall", id: "pending", name: "bash", arguments: {} },
        ],
      },
    };
    const messages = continuationMessages({ input: "First task" }, [
      { type: "model.call", payload: source },
      {
        type: "tool.result",
        payload: {
          id: "done",
          name: "write",
          content: [{ type: "text", text: "OK" }],
          is_error: false,
        },
      },
    ]);
    expect(messages[0]).toMatchObject({ role: "user", content: "First task" });
    expect(messages[1]?.content).toHaveLength(2);
    expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "done" });
    expect(source.message.content).toHaveLength(3);
  });
  it("keeps prior context before a new user prompt without including billing events", () => {
    const prior = [{ role: "user", content: "Earlier" }];
    const messages = continuationMessages({ input: "Next", prior_messages: prior }, [
      { type: "model.reserved", payload: { reserved_usd: 1 } },
    ]);
    expect(messages.map((m) => m.content)).toEqual(["Earlier", "Next"]);
    expect(prior).toHaveLength(1);
  });
});
