import type { Write } from "@earendil-works/pi-agent-core/harness/session";
import { afterEach, expect, it } from "vitest";
import { deferred } from "./testing/pi-composition-fixture.ts";
import {
  context,
  getOrThrow,
  harnessFixture,
  hasMessage,
  workspaceValue,
} from "./testing/pi-harness-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await harnessFixture();
  cleanup.push(f.close);
  return f;
}

function modelIntent(writes: Write[]) {
  return writes.some(
    (write) =>
      write.kind === "value" &&
      write.op === "set" &&
      write.namespace === "pi.op.state" &&
      (write.value as { at?: string }).at === "assistant.effect_pending",
  );
}

it("commits model intent before provider dispatch and rejects failed admission", async () => {
  const f = await fixture();
  const { lane } = await f.open();
  const reached = deferred(),
    release = deferred();
  f.beforeCommit = async (writes) => {
    if (!modelIntent(writes)) return;
    reached.resolve();
    await release.promise;
    throw new Error("model reservation rejected");
  };
  const run = lane.prompt("must not dispatch", undefined, context);
  const rejected = expect(run).rejects.toThrow();
  try {
    await reached.promise;
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
  } finally {
    release.resolve();
  }
  await rejected;
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  expect(f.effects).toBe(0);
});

it("records why before_request hooks must not authorize spending", async () => {
  const f = await fixture();
  const { harness, lane } = await f.open();
  const errors: string[] = [];
  harness.events.on("handler_error", (event) => {
    errors.push(event.error);
  });
  harness.hooks.on("before_request", () => {
    throw new Error("reservation refused in hook");
  });
  expect(getOrThrow(await lane.prompt("Write once", undefined, context)).status).toBe("completed");
  expect(errors).toContain("reservation refused in hook");
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
  expect(f.effects).toBe(1);
});

it("awaits the public Storage response commit before tools without modifying Pi", async () => {
  const f = await fixture();
  const { lane } = await f.open();
  const reached = deferred(),
    release = deferred();
  f.beforeCommit = async (writes) => {
    if (hasMessage(writes, "assistant")) {
      reached.resolve();
      await release.promise;
    }
  };
  const run = lane.prompt("Write once", undefined, context);
  try {
    await reached.promise;
    expect(f.effects).toBe(0);
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
  } finally {
    release.resolve();
  }
  expect(getOrThrow(await run).status).toBe("completed");
  expect(f.effects).toBe(1);
});

it("awaits an atomic workspace/outcome commit before the next model request", async () => {
  const f = await fixture();
  const { lane, storage } = await f.open();
  const reached = deferred(),
    release = deferred();
  f.beforeCommit = async (writes) => {
    if (hasMessage(writes, "toolResult")) {
      reached.resolve();
      await release.promise;
    }
  };
  const run = lane.prompt("Write once", undefined, context);
  try {
    await reached.promise;
    expect(f.effects).toBe(1);
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
    expect(await storage.getValue(workspaceValue, context)).toBeUndefined();
  } finally {
    release.resolve();
  }
  expect(getOrThrow(await run).status).toBe("completed");
  expect((await storage.getValue(workspaceValue, context))?.value).toEqual({
    "/workspace/probe.txt": "ONCE",
  });
});

it.each(["assistant", "toolResult"] as const)(
  "halts dependent effects when the %s commit fails",
  async (role) => {
    const f = await fixture();
    const { lane, storage } = await f.open();
    f.beforeCommit = async (writes) => {
      if (hasMessage(writes, role)) throw new Error("required commit rejected");
    };
    await expect(lane.prompt("Write once", undefined, context)).rejects.toThrow();
    expect(f.effects).toBe(role === "assistant" ? 0 : 1);
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
    expect(await storage.getValue(workspaceValue, context)).toBeUndefined();
  },
);

it("restores a committed assistant response and executes only its pending tools", async () => {
  const f = await fixture();
  const first = await f.open();
  let cut = false;
  f.afterCommit = async (writes) => {
    if (!cut && hasMessage(writes, "assistant")) {
      cut = true;
      throw new Error("executor disappeared after response commit");
    }
  };
  await expect(first.lane.prompt("Write once", undefined, context)).rejects.toThrow();
  expect(f.effects).toBe(0);
  const entries = await first.session.findEntries(undefined, context);
  await first.harness.close(context);
  await first.session.close(context);
  f.afterCommit = undefined;
  const second = await f.open();
  expect(second.open).toHaveLength(1);
  expect(await second.session.findEntries(undefined, context)).toEqual(entries);
  expect(getOrThrow(await second.lane.resume(context)).status).toBe("completed");
  expect(f.effects).toBe(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
});

it("restores a committed tool outcome and workspace without replaying its effect", async () => {
  const f = await fixture();
  const first = await f.open();
  let cut = false;
  f.afterCommit = async (writes) => {
    if (!cut && hasMessage(writes, "toolResult")) {
      cut = true;
      throw new Error("executor disappeared after result commit");
    }
  };
  await expect(first.lane.prompt("Write once", undefined, context)).rejects.toThrow();
  expect(f.effects).toBe(1);
  await first.harness.close(context);
  await first.session.close(context);
  f.afterCommit = undefined;
  const second = await f.open();
  expect(await second.bash.fs.readFile("/workspace/probe.txt")).toBe("ONCE");
  expect(getOrThrow(await second.lane.resume(context)).status).toBe("completed");
  expect(f.effects).toBe(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
});
