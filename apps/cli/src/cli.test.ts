import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, describe, expect, it } from "vitest";

const binary = fileURLToPath(new URL("../bin/nimplex.mjs", import.meta.url));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-cli-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = await startFakeAnthropic(0, { toolCalls: 1, delayMs });
  cleanup.push(upstream.close);
  function launch(args: string[], env: Record<string, string | undefined> = {}) {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "fake-key",
        ANTHROPIC_BASE_URL: upstream.url,
        NIMPLEX_STATE_DIR: join(dir, "state"),
        XDG_CONFIG_HOME: join(dir, "config"),
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    cleanup.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    return { child, done, output: () => output };
  }
  return { dir, upstream, launch };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for CLI");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("local CLI integration", () => {
  it("replays a committed acceptance across processes without creating a second turn", async () => {
    const f = await fixture();
    const first = f.launch(["--request-id", "headless-1", "Write a file once"]);
    expect(await first.done).toBe(0);
    const session = /Session: ([\w-]+)/.exec(first.output())?.[1];
    const turn = /Turn: ([\w-]+)/.exec(first.output())?.[1];
    if (!session || !turn) throw new Error("Missing durable acceptance identity");
    expect(first.output()).toContain("Request: headless-1");
    const calls = f.upstream.state.messagesCalls.length;
    const duplicate = f.launch([
      "--resume",
      session,
      "--request-id",
      "headless-1",
      "Write a file once",
    ]);
    expect(await duplicate.done).toBe(0);
    expect(duplicate.output()).toContain(`Turn: ${turn}`);
    expect(f.upstream.state.messagesCalls).toHaveLength(calls);
    const conflicting = f.launch([
      "--resume",
      session,
      "--request-id",
      "headless-1",
      "Different task",
    ]);
    expect(await conflicting.done).toBe(1);
    expect(conflicting.output()).toContain("different content");
    expect(f.upstream.state.messagesCalls).toHaveLength(calls);
  }, 20000);

  it("does not treat an empty idempotent submission as a request to resume interrupted work", async () => {
    const f = await fixture();
    const empty = f.launch(["--request-id", "headless-1"]);
    empty.child.stdin.end();
    expect(await empty.done).toBe(1);
    expect(empty.output()).toContain("requires a one-shot task");
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
  });

  it("exposes Codex login and never falls back to an API key when subscription login is missing", async () => {
    const f = await fixture();
    const help = f.launch(["--help"]);
    help.child.stdin.end();
    expect(await help.done).toBe(0);
    expect(help.output()).toContain("nimplex login codex");
    const missing = f.launch(["--model", "openai-codex/gpt-5.6-sol", "Task"]);
    missing.child.stdin.end();
    expect(await missing.done).toBe(1);
    expect(missing.output()).toContain("nimplex login codex");
    expect(missing.output()).toContain("Codex subscription");
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
  }, 20000);
  it("runs without a cloud API and resumes the same session across processes", async () => {
    const f = await fixture();
    const a = f.launch(["Write a file"]);
    expect(await a.done).toBe(0);
    expect(a.output()).toContain("completed");
    const session = /Session: ([\w-]+)/.exec(a.output())?.[1];
    if (!session) throw new Error("Missing session ID");
    const turn = /Turn: ([\w-]+)/.exec(a.output())?.[1];
    if (!turn) throw new Error("Missing turn ID");
    const b = f.launch(["--resume", session, "Continue the same workspace"]);
    expect(await b.done).toBe(0);
    expect(JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages)).toContain(
      "Write a file",
    );
    expect(JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages)).toContain(
      "Continue the same workspace",
    );
    const files = f.launch(["--files", turn]);
    expect(await files.done).toBe(0);
    expect(files.output()).toContain("step-1.txt");
  }, 20000);
  it("supports piped prompts and fails without leaking missing credentials", async () => {
    const f = await fixture();
    const piped = f.launch([]);
    piped.child.stdin.end("Piped task");
    expect(await piped.done).toBe(0);
    const missing = f.launch(["Task"], { ANTHROPIC_API_KEY: undefined });
    expect(await missing.done).toBe(1);
    expect(missing.output()).toContain("Missing Anthropic credential");
    expect(missing.output()).not.toContain("fake-key");
  }, 20000);
  it("releases root ownership after SIGKILL and explicitly resumes an interrupted turn", async () => {
    const f = await fixture(250);
    const a = f.launch(["--request-id", "crash-acceptance", "Durable task"]);
    await until(() => a.output().includes("step-1.txt"));
    const session = /Session: ([\w-]+)/.exec(a.output())?.[1];
    if (!session) throw new Error("Missing session ID");
    a.child.kill("SIGKILL");
    await a.done;
    const callsAfterCrash = f.upstream.state.messagesCalls.length;
    const duplicate = f.launch([
      "--resume",
      session,
      "--request-id",
      "crash-acceptance",
      "Durable task",
    ]);
    expect(await duplicate.done).toBe(1);
    expect(duplicate.output()).toContain("runtime_interrupted");
    expect(f.upstream.state.messagesCalls).toHaveLength(callsAfterCrash);
    const b = f.launch(["--resume", session]);
    b.child.stdin.end();
    expect(await b.done).toBe(0);
    expect(b.output()).toContain("completed");
    const writes = f.upstream.state.messagesCalls.filter((c) =>
      JSON.stringify(c.body.messages).includes("tool_result"),
    );
    expect(writes.length).toBeGreaterThan(0);
  }, 20000);
  it("runs new sessions on the Pi harness engine when NIMPLEX_ENGINE selects it", async () => {
    const f = await fixture();
    const a = f.launch(["Write a file"], { NIMPLEX_ENGINE: "pi-harness" });
    expect(await a.done).toBe(0);
    expect(a.output()).toContain("completed");
    const session = /Session: ([\w-]+)/.exec(a.output())?.[1];
    const turn = /Turn: ([\w-]+)/.exec(a.output())?.[1];
    if (!session || !turn) throw new Error("Missing session or turn ID");
    const files = f.launch(["--files", turn]);
    expect(await files.done).toBe(0);
    expect(files.output()).toContain("step-1.txt");
    // The recorded engine wins over the environment for an existing session.
    const b = f.launch(["--resume", session, "Continue"], { NIMPLEX_ENGINE: "pi-executor" });
    expect(await b.done).toBe(0);
    expect(JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages)).toContain(
      "Write a file",
    );
    const invalid = f.launch(["Task"], { NIMPLEX_ENGINE: "unknown" });
    invalid.child.stdin.end();
    expect(await invalid.done).toBe(1);
    expect(invalid.output()).toContain("NIMPLEX_ENGINE");
  }, 30000);
  it("applies --thinking on harness sessions and rejects it on the legacy engine", async () => {
    const f = await fixture();
    const invalid = f.launch(["--thinking", "deep", "Task"]);
    invalid.child.stdin.end();
    expect(await invalid.done).toBe(1);
    expect(invalid.output()).toContain("--thinking must be one of");
    const legacy = f.launch(["--thinking", "low", "Task"]);
    legacy.child.stdin.end();
    expect(await legacy.done).toBe(1);
    expect(legacy.output()).toContain("Pi harness engine");
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
    const harness = f.launch(["--thinking", "low", "Write a file"], {
      NIMPLEX_ENGINE: "pi-harness",
    });
    expect(await harness.done).toBe(0);
    expect(harness.output()).toContain("completed");
    expect(f.upstream.state.messagesCalls.length).toBeGreaterThan(0);
    for (const call of f.upstream.state.messagesCalls)
      expect(call.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 2048 });
  }, 30000);
  it("recognizes login after leading flags and never submits it as a prompt", async () => {
    const f = await fixture();
    const login = f.launch(["--state-dir", join(f.dir, "s2"), "logout"]);
    login.child.stdin.end();
    expect(await login.done).toBe(0);
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
    expect(login.output()).not.toContain("Turn:");
  }, 20000);
  it("treats non-file @mentions as text and decodes piped multi-byte input intact", async () => {
    const f = await fixture();
    const mention = f.launch(["ping @alice about @scope/pkg"]);
    expect(await mention.done).toBe(0);
    expect(JSON.stringify(f.upstream.state.messagesCalls[0]?.body.messages)).toContain("@alice");
    // Larger than one pipe buffer so a multi-byte character straddles a chunk boundary.
    const text = `${"中文句子，".repeat(8_000)}END`;
    const piped = f.launch([]);
    piped.child.stdin.end(text);
    expect(await piped.done).toBe(0);
    const sent = JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages);
    expect(sent).not.toContain("\ufffd");
    expect(sent).toContain("中文句子，END");
  }, 30000);
  it("loads the project environment file without requiring cloud configuration", async () => {
    const f = await fixture();
    writeFileSync(
      join(f.dir, ".env"),
      `ANTHROPIC_API_KEY=dotenv-test-key\nANTHROPIC_BASE_URL=${f.upstream.url}\n`,
    );
    const p = f.launch(["Dotenv task"], {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
    });
    expect(await p.done).toBe(0);
    expect(p.output()).not.toContain("dotenv-test-key");
    expect(f.upstream.state.messagesCalls.length).toBeGreaterThan(0);
  }, 20000);
  it("stops on Ctrl+C and settles the local turn", async () => {
    const f = await fixture(500);
    const a = f.launch(["Long task"]);
    await until(() => a.output().includes("Turn:"));
    a.child.kill("SIGINT");
    expect(await a.done).toBe(1);
    expect(a.output()).toContain("canceled");
  }, 20000);
});
