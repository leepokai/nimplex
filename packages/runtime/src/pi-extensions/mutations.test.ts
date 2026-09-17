import { expect, it } from "vitest";
import { deferred } from "../testing/pi-composition-fixture.ts";
import { PiExtensionMutations } from "./mutations.ts";

it("drains admitted mutations in order and includes work staged while flushing", async () => {
  const mutations = new PiExtensionMutations(),
    hold = deferred();
  const effects: number[] = [];
  void mutations.stage(async () => {
    await hold.promise;
    effects.push(1);
  });
  const flushed = mutations.flush();
  void mutations.stage(async () => {
    effects.push(2);
  });
  hold.resolve();
  await flushed;
  expect(effects).toEqual([1, 2]);
});

it("latches ignored persistence errors and prevents every subsequent queued mutation", async () => {
  const mutations = new PiExtensionMutations();
  let later = false;
  void mutations.stage(async () => {
    throw new Error("commit failed");
  });
  void mutations.stage(async () => {
    later = true;
  });
  await expect(mutations.flush()).rejects.toThrow("commit failed");
  await expect(
    mutations.stage(async () => {
      later = true;
    }),
  ).rejects.toThrow("commit failed");
  expect(() => mutations.assertHealthy()).toThrow("commit failed");
  expect(later).toBe(false);
  await expect(mutations.close()).rejects.toThrow("commit failed");
});

it("seals admission on close while draining already staged commits", async () => {
  const mutations = new PiExtensionMutations(),
    hold = deferred();
  let committed = false;
  void mutations.stage(async () => {
    await hold.promise;
    committed = true;
  });
  const closing = mutations.close();
  expect(() => mutations.stage(async () => {})).toThrow("closed");
  hold.resolve();
  await closing;
  expect(committed).toBe(true);
  expect(() => mutations.assertHealthy()).toThrow("closed");
});

it("drains notifications that await nested mutations without holding the mutation line", async () => {
  const mutations = new PiExtensionMutations(),
    hold = deferred();
  const events: string[] = [];
  void mutations.track(
    mutations
      .stage(async () => {
        events.push("first commit");
      })
      .then(async () => {
        await hold.promise;
        await mutations.stage(async () => {
          events.push("nested commit");
        });
        events.push("notification complete");
      }),
  );
  let flushed = false;
  const pending = mutations.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  expect(flushed).toBe(false);
  hold.resolve();
  await pending;
  expect(events).toEqual(["first commit", "nested commit", "notification complete"]);
});

it("latches notification failures and drains admitted notifications during close", async () => {
  const mutations = new PiExtensionMutations(),
    hold = deferred();
  void mutations.track(
    hold.promise.then(() => {
      throw new Error("notification failed");
    }),
  );
  const close = mutations.close();
  const failure = expect(close).rejects.toThrow("notification failed");
  hold.resolve();
  await failure;
  await expect(mutations.flush()).rejects.toThrow("notification failed");
});
