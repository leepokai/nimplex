import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { describe, it } from "vitest";
import { SqlitePiStorage } from "./sqlite.ts";

describe("Pi public Storage conformance: SQLite", () => {
  for (const test of createStorageConformance(async () => {
    const db = new DatabaseSync(":memory:");
    const storage = new SqlitePiStorage(
      db,
      { tenantId: "test-tenant", sessionId: "test-session" },
      () => {},
    );
    return {
      storage,
      async [Symbol.asyncDispose]() {
        await storage.close(BACKGROUND_CONTEXT);
        db.close();
      },
    };
  }))
    it(`${test.group}: ${test.name}`, test.run);
});
