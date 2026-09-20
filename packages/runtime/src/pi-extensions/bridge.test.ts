import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurnRequest } from "@nimplex/contracts";
import { startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, expect, it } from "vitest";
import { NimplexRuntime } from "../runtime.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const USER_EXTENSION = `
export default function (pi) {
  pi.registerTool({
    name: "shout",
    label: "Shout",
    description: "Uppercase the given text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      return { content: [{ type: "text", text: String(params.text).toUpperCase() }], details: {} };
    },
  });
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nEXTENSION MARK" }));
  pi.on("tool_call", (event) => {
    if (event.toolName === "write" && event.input.path === "/workspace/secret.txt")
      return { block: true, reason: "secret files are off limits" };
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "write" && event.input.path === "/workspace/ok.txt")
      pi.sendMessage({ customType: "note", content: "FOLLOW UP FROM EXTENSION", display: true }, { deliverAs: "followUp" });
  });
}
`;
const PROJECT_EXTENSION = `
export default function (pi) {
  pi.registerTool({
    name: "project_tool",
    label: "Project tool",
    description: "Only available when the project is trusted",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "project" }], details: {} }; },
  });
}
`;

function fixture(options: {
  projectTrusted: boolean;
  brokenUser?: boolean;
  engine?: "pi-executor" | "pi-harness";
}) {
  const root = mkdtempSync(join(tmpdir(), "nimplex-extensions-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "guard.ts"),
    options.brokenUser ? "export default function (pi) { this is not valid" : USER_EXTENSION,
  );
  writeFileSync(join(cwd, ".pi", "extensions", "project.ts"), PROJECT_EXTENSION);
  return { root, agentDir, cwd };
}
async function harness(
  f: ReturnType<typeof fixture>,
  script: { name: string; input: Record<string, unknown> }[],
  projectTrusted: boolean,
  engine: "pi-executor" | "pi-harness" = "pi-harness",
) {
  const upstream = await startFakeAnthropic(0, { script });
  cleanup.push(upstream.close);
  const runtime = new NimplexRuntime({
    directory: join(f.root, "state"),
    engine,
    credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
    extensions: { agentDir: f.agentDir, projectTrusted: () => projectTrusted },
  });
  cleanup.push(() => runtime.close());
  return { upstream, runtime };
}
async function finish(runtime: NimplexRuntime, id: string) {
  const events = [];
  for await (const event of runtime.events(id)) events.push(event);
  return { result: runtime.getTurn(id), events };
}
const request = (prompt = "Use the tools") => startTurnRequest.parse({ prompt, sandbox: "docker" });
const toolNames = (body: unknown) =>
  ((body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);

it("runs user extension tools and hooks inside a harness turn with durable effects", async () => {
  const f = fixture({ projectTrusted: false });
  const { upstream, runtime } = await harness(
    f,
    [
      { name: "shout", input: { text: "hi there" } },
      { name: "write", input: { path: "/workspace/secret.txt", content: "leak" } },
      { name: "write", input: { path: "/workspace/ok.txt", content: "fine" } },
    ],
    false,
  );
  const summary = await runtime.extensions(f.cwd);
  expect(summary).toMatchObject({ projectTrusted: false, errors: [] });
  expect(summary?.extensions.map((e) => e.tools)).toEqual([["shout"]]);
  const session = runtime.createSession(f.cwd);
  const run = await runtime.startTurn(session.id, request());
  const { result, events } = await finish(runtime, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  const results = events
    .filter((e) => e.type === "tool.result")
    .map((e) => e.payload as { name: string; is_error: boolean; content: { text?: string }[] });
  expect(results.map((r) => r.name)).toEqual(["shout", "write", "write"]);
  expect(results[0]?.content[0]?.text).toBe("HI THERE");
  expect(results[1]?.is_error).toBe(true);
  expect(JSON.stringify(results[1]?.content)).toContain("secret files are off limits");
  expect(results[2]?.is_error).toBe(false);
  expect(runtime.files(run.runId)).not.toContain("/workspace/secret.txt");
  expect(new TextDecoder().decode(runtime.readFile(run.runId, "/workspace/ok.txt"))).toBe("fine");
  // The extension's system prompt change reaches every provider request; project tools do not.
  for (const call of upstream.state.messagesCalls) {
    expect(JSON.stringify(call.body.system)).toContain("EXTENSION MARK");
    expect(toolNames(call.body)).toContain("shout");
    expect(toolNames(call.body)).not.toContain("project_tool");
  }
  // The follow-up sent by the extension was delivered durably through the lane inbox.
  expect(JSON.stringify(upstream.state.messagesCalls.at(-1)?.body.messages)).toContain(
    "FOLLOW UP FROM EXTENSION",
  );
  expect(events.some((e) => e.type === "input.queued")).toBe(true);
  // Extension activity is committed like any other tool boundary and survives reopen.
  await runtime.close();
  const reopened = new NimplexRuntime({
    directory: join(f.root, "state"),
    credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
  });
  cleanup.push(() => reopened.close());
  expect(reopened.getSession(session.id).turns[0]?.result?.status).toBe("completed");
  expect(new TextDecoder().decode(reopened.readFile(run.runId, "/workspace/ok.txt"))).toBe("fine");
});

it("executes project extensions only when the project is trusted", async () => {
  const f = fixture({ projectTrusted: true });
  const { upstream, runtime } = await harness(f, [{ name: "project_tool", input: {} }], true);
  const summary = await runtime.extensions(f.cwd);
  expect(summary?.projectTrusted).toBe(true);
  expect(summary?.extensions.flatMap((e) => e.tools).sort()).toEqual(["project_tool", "shout"]);
  const session = runtime.createSession(f.cwd);
  const run = await runtime.startTurn(session.id, request());
  const { result, events } = await finish(runtime, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  expect(toolNames(upstream.state.messagesCalls[0]?.body)).toContain("project_tool");
  expect(
    events.filter((e) => e.type === "tool.result").map((e) => (e.payload as { name: string }).name),
  ).toEqual(["project_tool"]);
});

it("fails a harness turn closed when an extension cannot load, and never runs extensions on the legacy engine", async () => {
  const broken = fixture({ projectTrusted: false, brokenUser: true });
  const first = await harness(broken, [], false);
  const session = first.runtime.createSession(broken.cwd);
  const run = await first.runtime.startTurn(session.id, request());
  const { result } = await finish(first.runtime, run.runId);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("guard.ts");
  expect(first.upstream.state.messagesCalls).toHaveLength(0);
  const summary = await first.runtime.extensions(broken.cwd);
  expect(summary?.errors[0]?.error).toContain("guard.ts");
  // A fixed extension loads after reloadExtensions without restarting the runtime.
  writeFileSync(join(broken.agentDir, "extensions", "guard.ts"), USER_EXTENSION);
  first.runtime.reloadExtensions();
  expect((await first.runtime.extensions(broken.cwd))?.errors).toEqual([]);

  const legacy = fixture({ projectTrusted: true });
  const second = await harness(legacy, [], true, "pi-executor");
  const legacySession = second.runtime.createSession(legacy.cwd);
  const legacyRun = await second.runtime.startTurn(legacySession.id, request());
  expect((await finish(second.runtime, legacyRun.runId)).result.status).toBe("completed");
  expect(toolNames(second.upstream.state.messagesCalls[0]?.body)).not.toContain("shout");
});
