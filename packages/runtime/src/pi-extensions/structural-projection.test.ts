import type { NewEntry } from "@earendil-works/pi-agent-core/harness/session";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiCompatibilityEntry } from "@nimplex/contracts";
import { expect, it } from "vitest";
import { PiSessionView } from "./session-view.ts";
import { projectCompaction } from "./structural-projection.ts";

const timestamp = "2026-09-16T00:00:00.000Z";
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const path: PiCompatibilityEntry[] = [
  { type: "message", id: "old", parentId: null, timestamp, message: user("old") },
  { type: "message", id: "kept", parentId: "old", timestamp, message: user("keep") },
  { type: "custom", id: "state", parentId: "kept", timestamp, customType: "state", data: 1 },
];
function compact(retainedTail: Extract<NewEntry, { type: "compaction" }>["retainedTail"]) {
  return {
    type: "compaction" as const,
    id: "compact",
    parentId: "state",
    summary: "Earlier history",
    retainedTail,
    tokensBefore: 100,
    details: { extension: { version: 1 } },
    fromHook: true,
  };
}
function view(entries: PiCompatibilityEntry[]) {
  return new PiSessionView({
    header: { type: "session", version: 3, id: "session", timestamp, cwd: "/workspace" },
    entries: entries as SessionEntry[],
    leafId: entries.at(-1)?.id ?? null,
  });
}

it("matches stored messages with absent optional fields without minting replacement identities", () => {
  const message = {
    role: "toolResult" as const,
    toolCallId: "call",
    toolName: "probe",
    content: [],
    isError: false,
    timestamp: 2,
    details: undefined,
  };
  const entry: PiCompatibilityEntry = {
    type: "message",
    id: "result",
    parentId: "state",
    timestamp,
    message: JSON.parse(JSON.stringify(message)),
  };
  const projected = projectCompaction(compact([message]), "result", timestamp, [...path, entry]);
  expect(projected.mapping.firstKeptEntryId).toBe("result");
  expect(projected.mapping.derivedEntryIds).toEqual([]);
});

it("rejects non-finite retained content instead of silently rewriting it to null", () => {
  expect(() =>
    projectCompaction(
      compact([{ role: "user", content: "bad timestamp", timestamp: Number.NaN }]),
      "state",
      timestamp,
      path,
    ),
  ).toThrow("finite JSON numbers");
});

it.each([
  { version: 99, firstKeptEntryId: "kept" },
  { version: 1, firstKeptEntryId: "missing" },
  { version: 1, firstKeptEntryId: "old" },
])("rejects invalid extension retention envelopes: %j", (fields) => {
  const raw = {
    ...compact([user("keep")]),
    details: { kind: "nimplex.pi.extension.compaction", ...fields },
  };
  expect(() => projectCompaction(raw, "state", timestamp, path)).toThrow();
});

it("reuses the original retained entry and matches the public legacy reader", () => {
  const raw = compact([user("keep")]);
  const projected = projectCompaction(raw, "state", timestamp, path);
  expect(projected.mapping).toEqual({
    version: 1,
    nativeEntryId: "compact",
    firstKeptEntryId: "kept",
    derivedEntryIds: [],
  });
  const actual = view([...path, ...projected.entries]);
  const baseline = SessionManager.inMemory("/workspace");
  baseline.appendMessage(user("old"));
  const kept = baseline.appendMessage(user("keep"));
  baseline.appendCustomEntry("state", 1);
  baseline.appendCompaction(raw.summary, kept, 100, raw.details, true);
  const withoutSummaryTime = (
    messages: ReturnType<SessionManager["buildSessionContext"]>["messages"],
  ) => messages.map((m) => (m.role === "compactionSummary" ? { ...m, timestamp: 0 } : m));
  expect(withoutSummaryTime(actual.manager.buildSessionContext().messages)).toEqual(
    withoutSummaryTime(baseline.buildSessionContext().messages),
  );
  expect(actual.manager.getEntry("kept")).toEqual(path[1]);
});

it.each([
  { name: "empty", tail: [] },
  { name: "rewritten", tail: [user("replacement")] },
  { name: "reordered", tail: [user("keep"), user("old")] },
  {
    name: "multimodal",
    tail: [
      {
        role: "user" as const,
        content: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }],
        timestamp: 2,
      },
    ],
  },
])(
  "preserves $name retained context and maps derived records without changing history",
  ({ tail }) => {
    const raw = compact(tail),
      original = structuredClone(raw);
    const projected = projectCompaction(raw, "state", timestamp, path);
    const actual = view([...path, ...projected.entries]);
    expect(actual.manager.buildSessionContext().messages.slice(1)).toEqual(tail);
    expect(raw).toEqual(original);
    for (const entry of path) expect(actual.manager.getEntry(entry.id)).toEqual(entry);
    expect(projected.mapping.derivedEntryIds).toEqual(
      projected.entries.filter((e) => e.type === "message").map((e) => e.id),
    );
    expect(projectCompaction(raw, "state", timestamp, path)).toEqual(projected);
    if (!tail.length) expect(projected.mapping.firstKeptEntryId).toBe("compact");
  },
);
