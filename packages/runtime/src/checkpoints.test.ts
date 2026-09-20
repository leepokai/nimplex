import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurnRequest } from "@nimplex/contracts";
import { afterEach, expect, it } from "vitest";
import { commitModelIn, startModelIn } from "./checkpoints.ts";
import { RuntimeStore, type StoredTurn } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-model-attempt-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RuntimeStore(directory);
  cleanup.push(() => store.close());
  const id = randomUUID();
  const turn: StoredTurn = {
    sessionId: "session",
    request: startTurnRequest.parse({ prompt: "Work" }),
    config: {
      instructions: "Work",
      input: "Work",
      prior_messages: [],
      execution_mode: "build",
      compact_context: false,
    },
    result: {
      id,
      status: "running",
      external_user_id: null,
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      sandbox: { provider: "docker" },
      sandbox_ref: null,
      spent_usd: 0,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    },
  };
  store.saveTurn(turn);
  return { store, id };
}

it("settles unlimited model cost once and preserves a terminal cancellation", () => {
  const { store, id } = fixture();
  const attempt = store.transaction(() => startModelIn(store, id));
  const turn = store.turn(id);
  turn.result.status = "canceled";
  store.saveTurn(turn);
  for (let i = 0; i < 2; i++) {
    store.transaction(() =>
      commitModelIn(
        store,
        id,
        attempt,
        [{ type: "model.unknown", payload: attempt }],
        1.1234567,
        true,
      ),
    );
  }
  expect(store.turn(id).result).toMatchObject({ status: "canceled", spent_usd: 1.123457 });
  expect(store.events(id).filter((event) => event.type === "model.unknown")).toHaveLength(1);
  expect(store.events(id).filter((event) => event.type === "spend.updated")).toHaveLength(1);
  expect(() => startModelIn(store, id)).toThrow("turn is canceled");
});

it("recognizes legacy intent events and reads obsolete budget JSON without enforcing it", () => {
  const { store, id } = fixture();
  const turn = store.turn(id);
  const legacy = {
    ...turn,
    request: { ...turn.request, budget: 0.000001 },
    result: { ...turn.result, budget_usd: 0.000001, reserved_usd: 0.01 },
  };
  store.db.prepare("UPDATE turns SET data=? WHERE id=?").run(JSON.stringify(legacy), id);
  const attempt = { call_id: randomUUID() };
  store.append(id, [
    {
      type: "model.reserved",
      payload: { ...attempt, reserved_usd: 0.01, max_output_tokens: 1, input_token_bound: 1 },
    },
  ]);
  store.transaction(() =>
    commitModelIn(store, id, attempt, [{ type: "model.call", payload: attempt }], 0.5, false),
  );
  expect(store.turn(id).request).not.toHaveProperty("budget");
  expect(store.turn(id).result).toMatchObject({ status: "running", spent_usd: 0.5 });
  expect(store.turn(id).result).not.toHaveProperty("budget_usd");
  expect(store.turns()[0]?.result).not.toHaveProperty("reserved_usd");
  expect(store.events(id)[0]?.type).toBe("model.reserved");
});

it("rejects invalid accounting and rolls failed dispatch-intent transactions back", () => {
  const { store, id } = fixture();
  expect(() =>
    store.transaction(() => {
      startModelIn(store, id);
      throw new Error("disk failed");
    }),
  ).toThrow("disk failed");
  expect(store.events(id)).toEqual([]);
  const attempt = store.transaction(() => startModelIn(store, id));
  for (const cost of [NaN, Infinity, -1]) {
    expect(() =>
      store.transaction(() => commitModelIn(store, id, attempt, [], cost, false)),
    ).toThrow("Invalid model cost");
  }
  expect(() => commitModelIn(store, id, { call_id: randomUUID() }, [], 1, false)).toThrow(
    "Unknown model attempt",
  );
  expect(store.turn(id).result.spent_usd).toBe(0);
  expect(store.events(id)).toHaveLength(1);
});
