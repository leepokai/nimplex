import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { RuntimeStore } from "./store.ts";

it("rolls events and workspace back together if a transaction fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-store-"));
  const store = new RuntimeStore(dir);
  try {
    store.transaction(() => {
      store.saveWorkspace("turn", { files: {}, metadata: {} });
      store.append("turn", [{ type: "before" }]);
    });
    expect(() =>
      store.transaction(() => {
        store.saveWorkspace("turn", {
          files: { "/workspace/test": new Uint8Array([1, 2]) },
          metadata: {},
        });
        store.append("turn", [{ type: "tool.result" }]);
        throw new Error("injected commit failure");
      }),
    ).toThrow("injected");
    expect(store.workspace("turn").files).toEqual({});
    expect(store.events("turn").map((e) => e.type)).toEqual(["before"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects a future schema without changing it or retaining the root lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-schema-"));
  const seed = new RuntimeStore(dir);
  seed.close();
  const db = new DatabaseSync(join(dir, "runtime.sqlite"));
  db.exec("PRAGMA user_version=99");
  try {
    expect(() => new RuntimeStore(dir)).toThrow("Unsupported runtime database version");
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(99);
    db.exec("PRAGMA user_version=1");
    const reopened = new RuntimeStore(dir);
    reopened.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
