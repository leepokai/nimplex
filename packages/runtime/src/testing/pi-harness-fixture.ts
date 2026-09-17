import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentHarness, getOrThrow } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core/harness/context";
import {
  StorageBackedSession,
  setValue,
  value,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import { StorageDecorator } from "@earendil-works/pi-agent-core/harness/session/testing";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createWriteTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type FakeAnthropicOptions, startFakeAnthropic } from "@nimplex/testkit";
import { Bash } from "just-bash";
import { PiCompatibilityStore } from "../pi-extensions/compatibility-store.ts";
import { SqlitePiStorage } from "../pi-storage/sqlite.ts";
import { PiSummaryResponses } from "../pi-storage/summary-responses.ts";
import { piSummaryModels } from "../pi-summary-models.ts";

export const context = BACKGROUND_CONTEXT;
export const workspaceValue = value<Record<string, string>>("nimplex.fixture.workspace");

export function hasMessage(writes: Write[], role: "assistant" | "toolResult") {
  return writes.some((write) => {
    if (write.kind === "entry")
      return write.entry.type === "message" && write.entry.message.role === role;
    if (write.kind !== "value" || write.op !== "set" || write.namespace !== "pi.pending.entry")
      return false;
    return (write.value as { payload?: { role?: string } })?.payload?.role === role;
  });
}

/** Uses only public Pi exports, without patching its loop or session implementation. */
export async function harnessFixture(
  options: {
    directory?: string;
    compatibility?: boolean;
    upstream?: FakeAnthropicOptions;
    rawSummaryModels?: boolean;
  } = {},
) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "nimplex-public-pi-"));
  const upstream = await startFakeAnthropic(0, {
    script: [{ name: "probe", input: { path: "/workspace/probe.txt", content: "ONCE" } }],
    ...options.upstream,
  });
  const db = new DatabaseSync(join(directory, "pi.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const models = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerProvider("anthropic", { baseUrl: upstream.url });
  await models.setRuntimeApiKey("anthropic", "synthetic-public-harness-key");
  const model = getBuiltinModels("anthropic")[0];
  if (!model) throw new Error("Missing pinned model catalog");
  const selectedModel = model;
  let effects = 0;
  let beforeCommit: ((writes: Write[]) => Promise<void>) | undefined;
  let afterCommit: ((writes: Write[]) => Promise<void>) | undefined;
  const stores: SqlitePiStorage[] = [];
  const harnesses: Awaited<ReturnType<typeof AgentHarness.create>>["harness"][] = [];
  let authority = true;
  function assertAuthority() {
    if (!authority) throw new Error("Ownership lost");
  }
  async function open() {
    const storage = new SqlitePiStorage(
      db,
      { tenantId: "test", sessionId: "session" },
      assertAuthority,
    );
    stores.push(storage);
    const files = (await storage.getValue(workspaceValue, context))?.value ?? {};
    const bash = new Bash({ cwd: "/workspace", files });
    class WorkspaceStorage extends StorageDecorator {
      override async commit(writes: Write[], ctx: Context) {
        await beforeCommit?.(writes);
        let changes = writes;
        if (hasMessage(writes, "toolResult")) {
          const snapshot: Record<string, string> = {};
          for (const name of await bash.fs.readdir("/workspace")) {
            const path = `/workspace/${name}`;
            snapshot[path] = await bash.fs.readFile(path);
          }
          changes = [...writes, setValue(workspaceValue, snapshot)];
        }
        const receipt = await super.commit(changes, ctx);
        await afterCommit?.(writes);
        return receipt;
      }
    }
    const workspaceStorage = new WorkspaceStorage(storage);
    const summaryResponses = options.rawSummaryModels
      ? undefined
      : new PiSummaryResponses(workspaceStorage, context, assertAuthority);
    const durableStorage = summaryResponses?.storage ?? workspaceStorage;
    const compatibility = options.compatibility
      ? new PiCompatibilityStore(durableStorage, {
          id: "session",
          cwd: "/workspace",
          createdAt: 0,
        })
      : undefined;
    const session = new StorageBackedSession(
      { id: "session", createdAt: 0, storageVersion: 1 },
      compatibility?.storage ?? durableStorage,
    );
    const write = createWriteTool("/workspace", {
      operations: {
        writeFile: async (path, content) => {
          await bash.fs.writeFile(path, content);
        },
        mkdir: async (path) => {
          await bash.fs.mkdir(path, { recursive: true });
        },
      },
    });
    const created = await AgentHarness.create(
      {
        session,
        models: options.rawSummaryModels
          ? models
          : piSummaryModels(models, summaryResponses?.boundary),
        model: selectedModel,
        thinkingLevel: "off",
        toolExecution: "sequential",
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 10 },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
        streamOptions: { maxRetries: 0 },
        tools: [
          {
            ...write,
            name: "probe",
            replay: "safe",
            async execute(id, args) {
              effects++;
              const input = args as { path: string; content: string };
              return write.execute(id, input);
            },
          },
        ],
      },
      context,
    );
    harnesses.push(created.harness);
    summaryResponses?.attach(created.harness);
    const lane = await created.harness.lane("main", context);
    return { ...created, lane, session, storage, bash, compatibility, summaryResponses };
  }
  return {
    directory,
    db,
    upstream,
    models,
    model: selectedModel,
    assertAuthority,
    open,
    get effects() {
      return effects;
    },
    set beforeCommit(value: typeof beforeCommit) {
      beforeCommit = value;
    },
    get beforeCommit() {
      return beforeCommit;
    },
    set afterCommit(value: typeof afterCommit) {
      afterCommit = value;
    },
    loseOwnership() {
      authority = false;
    },
    async close() {
      beforeCommit = undefined;
      afterCommit = undefined;
      for (const h of harnesses) await h.close(context).catch(() => {});
      for (const s of stores) await s.close(context);
      db.close();
      await upstream.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export { getOrThrow };
