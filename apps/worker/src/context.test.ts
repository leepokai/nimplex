import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExecutorEvent } from "@nimplex/core";
import { describe, expect, it } from "vitest";
import { compactContext, eventDigest, latestCheckpoint, readArchive } from "./context.ts";

describe("durable context projection", () => {
  it("verifies checkpoint digests independent of JSON property order and rejects tampering", () => {
    const events: ExecutorEvent[] = [{ type: "tool.result", payload: { id: "x", content: [] } }];
    const checkpoint = {
      version: 1,
      high_water: 0,
      digest: eventDigest(events),
      strategy: "extractive",
      messages: [],
    };
    const reordered = [
      { payload: { content: [], id: "x" }, type: "tool.result" },
      { type: "context.checkpoint", payload: checkpoint },
    ];
    expect(latestCheckpoint(reordered)).toEqual(checkpoint);
    reordered[0] = { type: "tool.result", payload: { content: [], id: "changed" } };
    expect(latestCheckpoint(reordered)).toBeNull();
  });
  it("keeps recent complete assistant/tool pairs and the original user prompt", () => {
    const messages = [{ role: "user", content: "original goal", timestamp: 0 }];
    for (let i = 0; i < 5; i++) {
      messages.push(
        { role: "assistant", content: `call ${i}`, timestamp: 0 },
        { role: "toolResult", content: `result ${i}`, timestamp: 0 },
      );
    }
    const events = [{ type: "run.started" }];
    const checkpoint = compactContext(messages as unknown as AgentMessage[], events, 1);
    expect(checkpoint?.messages[0]).toEqual(messages[0]);
    expect(checkpoint?.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(checkpoint?.high_water).toBe(0);
  });
  it("pages through full archived output without losing long lines", () => {
    const text = `${"A".repeat(15000)}END`;
    const events = [
      { type: "tool.result", payload: { id: "tool-1", content: [{ type: "text", text }] } },
    ];
    expect(readArchive(events, "tool-1", 14998, 10)).toEqual({
      text: "AAEND",
      offset: 14998,
      next_offset: null,
      total_characters: 15003,
    });
    expect(readArchive(events, "event:0", 0, 10).next_offset).toBe(10);
    expect(() => readArchive(events, "tool-1", -1)).toThrow();
  });
});
