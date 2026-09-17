import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { PiSessionView } from "./session-view.ts";

function snapshot(manager: SessionManager) {
  const header = manager.getHeader();
  if (!header) throw new Error("Missing fixture session header");
  return { header, entries: manager.getEntries(), leafId: manager.getLeafId() };
}

it("can cross an async boundary without being mistaken for a thenable", async () => {
  const baseline = SessionManager.inMemory("/workspace");
  baseline.appendCustomEntry("state", 1);
  const view = new PiSessionView(snapshot(baseline));
  const resolved = await Promise.resolve(view.manager);
  expect(resolved).toBe(view.manager);
  expect(resolved.getEntries()).toEqual(baseline.getEntries());
  expect(() => resolved.appendSessionInfo("forbidden")).toThrow("Read-only");
});

it("matches Pi's read projection across compaction, labels, branch selection and metadata", () => {
  const baseline = SessionManager.inMemory("/workspace");
  baseline.appendModelChange("anthropic", "fixture-model");
  baseline.appendThinkingLevelChange("low");
  const user = baseline.appendMessage({ role: "user", content: "retain me", timestamp: 1 });
  baseline.appendCustomEntry("extension-state", { nested: { count: 1 } });
  baseline.appendCompaction("summary", user, 100, { fixture: true }, true);
  baseline.appendSessionInfo("named session");
  baseline.appendLabelChange(user, "bookmark");
  const view = new PiSessionView(snapshot(baseline));
  expect(view.manager.getEntries()).toEqual(baseline.getEntries());
  expect(view.manager.getTree()).toEqual(baseline.getTree());
  expect(view.manager.getHeader()).toEqual(baseline.getHeader());
  expect(view.manager.getLabel(user)).toBe("bookmark");
  expect(view.manager.getSessionName()).toBe("named session");
  expect(view.manager.buildContextEntries()).toEqual(baseline.buildContextEntries());
  expect(view.manager.buildSessionContext()).toEqual(baseline.buildSessionContext());
  const readBranch = view.manager.getBranch;
  baseline.branch(user);
  view.replace(snapshot(baseline));
  expect(readBranch()).toEqual(baseline.getBranch());
  expect(view.manager.getLeafId()).toBe(user);
  expect(view.manager.getSessionFile()).toBeUndefined();
  expect(view.manager.isPersisted()).toBe(false);
});

it("does not expose writable Pi state through methods or returned objects", () => {
  const baseline = SessionManager.inMemory("/workspace");
  baseline.appendCustomEntry("state", { count: 1 });
  const source = snapshot(baseline);
  const view = new PiSessionView(source);
  const returned = view.manager.getEntries()[0];
  if (returned?.type !== "custom") throw new Error("Missing custom entry");
  (returned.data as { count: number }).count = 99;
  const originalEntry = source.entries[0];
  if (!originalEntry) throw new Error("Missing source entry");
  originalEntry.id = "modified";
  expect(view.manager.getEntries()[0]).toMatchObject({ data: { count: 1 } });
  expect(view.manager.getEntries()[0]?.id).not.toBe("modified");
  expect(() => view.manager.appendCustomEntry("bypass", {})).toThrow("Read-only");
  expect(() => view.manager.setSessionFile("/tmp/bypass.jsonl")).toThrow("Read-only");
  expect(() => Reflect.get(view.manager, "fileEntries")).toThrow("Read-only");
  expect(() => Object.assign(view.manager, { getEntries: () => [] })).toThrow();
});

it("keeps the last valid view on invalid replacement and invalidates captured readers", () => {
  const baseline = SessionManager.inMemory("/workspace");
  baseline.appendCustomEntry("state", {});
  const original = snapshot(baseline),
    view = new PiSessionView(original);
  const read = view.manager.getEntries;
  expect(() => view.replace({ ...original, leafId: "missing" })).toThrow("Missing Pi leaf");
  expect(() =>
    view.replace({ ...original, entries: [...original.entries, ...original.entries] }),
  ).toThrow("Duplicate Pi entry");
  expect(view.manager.getEntries()).toEqual(original.entries);
  view.invalidate();
  expect(() => read()).toThrow("no longer active");
  expect(() => view.replace(original)).toThrow("no longer active");
});
