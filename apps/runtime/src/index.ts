import { getSandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./session";
import { runTool, type SandboxLike } from "./tools";
import { UI } from "./ui";

export { Sandbox } from "@cloudflare/sandbox";
export { AgentSession } from "./session";

// TODO(P0): 上移到 @nimplex/contracts（對齊 createRunRequest 的 end_user / budget_usd 形狀）
const createSessionRequest = z.object({
  end_user: z.string().min(1),
  budget_usd: z.number().positive(),
  model: z.string().min(1).default("claude-opus-5"),
  instructions: z.string().default(""),
});

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.html(UI));

app.post("/v1/sessions", async (c) => {
  const parsed = createSessionRequest.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const id = crypto.randomUUID();
  const stub = c.env.AgentSession.get(c.env.AgentSession.idFromName(id));
  await stub.fetch("https://do/init", {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
  return c.json({ id }, 201);
});

async function proxyToSession(
  c: { env: Env; req: { param: (k: string) => string; raw: Request } },
  path: string,
) {
  const id = c.req.param("id");
  const stub = c.env.AgentSession.get(c.env.AgentSession.idFromName(id));
  const url = new URL(c.req.raw.url);
  return stub.fetch(`https://do${path}${url.search}`, {
    method: c.req.raw.method,
    body: c.req.raw.body,
  });
}

// dev-only：不經模型直接驗證沙箱三個工具是否接通（M5 doctor 的雛形）
app.get("/__dev/sandbox-smoke", async (c) => {
  const sandbox = getSandbox(
    c.env.Sandbox,
    `smoke-${crypto.randomUUID()}`,
  ) as unknown as SandboxLike;
  const steps: Record<string, unknown> = {};
  try {
    steps.exec = await runTool(sandbox, "bash", { command: "echo hello from sandbox && uname -s" });
    steps.write_file = await runTool(sandbox, "write_file", {
      path: "/workspace/smoke.txt",
      content: "nimplex\n",
    });
    steps.read_file = await runTool(sandbox, "read_file", { path: "/workspace/smoke.txt" });
    steps.persistence = await runTool(sandbox, "bash", { command: "cat /workspace/smoke.txt" });
    return c.json({ ok: true, steps });
  } catch (error) {
    return c.json(
      { ok: false, steps, error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

app.post("/v1/sessions/:id/messages", (c) => proxyToSession(c, "/message"));
app.get("/v1/sessions/:id/events", (c) => proxyToSession(c, "/events"));
app.get("/v1/sessions/:id", (c) => proxyToSession(c, "/state"));

export default app;
