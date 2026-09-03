// 在沙箱裡跑一個 harness：三個插槽在這裡合體。
//
//   harness manifest（插槽 2）決定裝什麼、跑什麼指令、注入哪些 env
//   sandbox provider（插槽 3）決定它跑在哪台機器上
//   env 裡的 base URL 指向 nimplex 閘道（插槽 1），所以使用者的真 key 不進箱子
//
// worker 對這三件事都沒有預設立場——換掉任何一格，這個檔案一行都不用改。

import type { HarnessManifest } from "@nimplex/contracts";
import {
  durationExceeded,
  type ExecResult,
  gatewayUrls,
  isSandboxSessionState,
  isTerminal,
  renderHarness,
  type SandboxSession,
} from "@nimplex/core";
import {
  appendRunEvents,
  type Db,
  generateRunToken,
  hashToken,
  killRun,
  type RunRow,
  runs,
} from "@nimplex/db";
import { getSandboxProvider } from "@nimplex/sandbox";
import { eq } from "drizzle-orm";

export interface HarnessExecutionResult {
  status: "completed" | "failed" | "killed";
  error: string | null;
}

export interface HarnessExecutionDeps {
  db: Db;
  /** 續租工作項目的租約，避免長時間執行被別的 worker 搶走 */
  renewLease: () => Promise<boolean>;
}

const WATCHDOG_INTERVAL_MS = 5_000;
const STDOUT_FLUSH_MS = 400;

export async function executeHarnessRun(
  { db, renewLease }: HarnessExecutionDeps,
  run: RunRow,
  manifest: HarnessManifest,
): Promise<HarnessExecutionResult> {
  const provider = getSandboxProvider(run.sandbox.provider);

  // 沙箱裡用的票是現鑄的，跟建立 run 時回傳給整合方的那張不同。
  const sandboxToken = generateRunToken();
  await db
    .update(runs)
    .set({ sandboxTokenHash: hashToken(sandboxToken) })
    .where(eq(runs.id, run.id));

  const config = run.config as { instructions?: string; input?: string | null };
  const prompt = [config.instructions ?? "", config.input ?? ""].filter(Boolean).join("\n\n");

  const rendered = renderHarness(manifest, {
    runId: run.id,
    runToken: sandboxToken,
    model: run.model,
    prompt,
    gateway: gatewayUrls(run.sandbox.provider),
    workdir: manifest.workdir,
  });

  const image =
    run.sandbox.image ?? (manifest.source.kind === "image" ? manifest.source.image : undefined);

  let session: SandboxSession | null = null;
  const controller = new AbortController();
  const emitter = createEventEmitter(db, run.id);
  let killedReason: string | null = null;

  const watchdog = setInterval(() => {
    void (async () => {
      await renewLease();
      const current = await db.query.runs.findFirst({
        where: eq(runs.id, run.id),
        columns: { status: true, error: true, startedAt: true, maxDurationSeconds: true },
      });
      if (!current) return;
      // 時間上限：metering=none 唯一的上限；exact 也可疊一層
      if (
        !isTerminal(current.status) &&
        durationExceeded(current.startedAt, current.maxDurationSeconds)
      ) {
        await killRun(db, run, "max_duration", "worker");
        killedReason = "max_duration";
        controller.abort();
        return;
      }
      if (isTerminal(current.status)) {
        killedReason = current.error ?? current.status;
        controller.abort();
      }
    })().catch((err) => console.error("[worker] watchdog 失敗", err));
  }, WATCHDOG_INTERVAL_MS);

  try {
    // 重領（前一個 worker 中途死掉）：先砍它留下的箱子，否則 handle 被覆寫後就沒人管、漏到 docker prune
    if (isSandboxSessionState(run.sandboxState)) {
      const previous = run.sandboxState;
      await provider
        .delete(previous)
        .catch((err) => console.error("[worker] 清理前次沙箱失敗", err));
      await appendRunEvents(db, run.id, [
        { type: "sandbox.reclaimed", payload: { previous_backend: previous.backendId } },
      ]);
    }

    session = await provider.create({
      label: run.id,
      image,
      cpu: run.sandbox.cpu,
      memoryMb: run.sandbox.memory_mb,
      snapshot: run.sandbox.snapshot,
      environment: rendered.env,
      workdir: rendered.workdir,
    });

    // sandbox state 先寫回資料庫，之後任何一個 worker 都接得回來把它砍掉
    await db
      .update(runs)
      .set({ sandboxState: session.state, sandboxRef: describeSandbox(session) })
      .where(eq(runs.id, run.id));
    await appendRunEvents(db, run.id, [
      {
        type: "sandbox.created",
        payload: {
          provider: session.state.backendId,
          ref: describeSandbox(session),
          workdir: session.state.workdir,
          // 只列出注入了哪些變數，不列值——值裡有 run token
          injected_env: Object.keys(rendered.env),
        },
      },
    ]);

    for (const step of rendered.install) {
      await appendRunEvents(db, run.id, [{ type: "harness.install", payload: { command: step } }]);
      const result = await session.exec({
        cmd: step,
        workdir: rendered.workdir,
        timeoutMs: rendered.timeoutMs,
        signal: controller.signal,
        onStderr: emitter.pushStderr,
      });
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim().slice(-2000) || result.stdout.trim().slice(-2000);
        await emitter.flush();
        return finish(db, run.id, "failed", `harness 安裝失敗（${step}）：${detail}`, killedReason);
      }
    }

    await appendRunEvents(db, run.id, [
      { type: "harness.started", payload: { command: rendered.command, harness: manifest.slug } },
    ]);

    const result: ExecResult = await session.exec({
      cmd: rendered.command,
      workdir: rendered.workdir,
      stdin: rendered.stdin ?? undefined,
      timeoutMs: rendered.timeoutMs,
      signal: controller.signal,
      onStdout: (chunk) => emitter.pushStdout(chunk, manifest.output),
      onStderr: emitter.pushStderr,
    });
    await emitter.flush();

    if (killedReason) return { status: "killed", error: killedReason };
    if (result.timedOut) {
      return finish(db, run.id, "failed", `harness 超過 ${manifest.timeout_seconds}s 上限`, null);
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().slice(-2000);
      return finish(db, run.id, "failed", `harness 結束碼 ${result.exitCode}：${detail}`, null);
    }
    return finish(db, run.id, "completed", null, null);
  } catch (err) {
    await emitter.flush();
    if (killedReason) return { status: "killed", error: killedReason };
    return finish(db, run.id, "failed", err instanceof Error ? err.message : String(err), null);
  } finally {
    clearInterval(watchdog);
    // 硬殺：不論結局如何，箱子一定要消失。
    if (session) {
      await session.stop().catch((err) => console.error("[worker] 銷毀沙箱失敗", err));
      await appendRunEvents(db, run.id, [
        { type: "sandbox.destroyed", payload: { ref: describeSandbox(session) } },
      ]).catch(() => {});
    }
  }
}

function finish(
  _db: Db,
  _runId: string,
  status: "completed" | "failed",
  error: string | null,
  killedReason: string | null,
): HarnessExecutionResult {
  if (killedReason) return { status: "killed", error: killedReason };
  return { status, error };
}

function describeSandbox(session: SandboxSession): string {
  const providerState = session.state.providerState;
  const ref =
    (typeof providerState.containerId === "string" && providerState.containerId.slice(0, 12)) ||
    // e2b 與 ComputeSDK 系列的 provider 都用 sandboxId
    (typeof providerState.sandboxId === "string" && providerState.sandboxId) ||
    (typeof providerState.workspaceRoot === "string" && providerState.workspaceRoot) ||
    "unknown";
  return `${session.state.backendId}:${ref}`;
}

/**
 * stdout 不能一個 chunk 一個事件（會把事件表淹掉），
 * 但也不能等到最後才寫（就看不到即時進度）。折衷：按行收集、定時沖出。
 */
function createEventEmitter(db: Db, runId: string) {
  let stdoutBuffer = "";
  let pending: { type: string; payload: unknown }[] = [];
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, STDOUT_FLUSH_MS);
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await appendRunEvents(db, runId, batch).catch((err) =>
      console.error("[worker] 寫入事件失敗", err),
    );
  };

  return {
    pushStdout(chunk: string, output: HarnessManifest["output"]) {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        // stream-json 的每一行都是一個結構化事件，解得開就當事件收
        if (output === "stream-json") {
          try {
            pending.push({ type: "harness.event", payload: JSON.parse(line) });
            continue;
          } catch {
            // 解不開就退回純文字
          }
        }
        pending.push({ type: "harness.stdout", payload: { text: line } });
      }
      schedule();
    },
    pushStderr(chunk: string) {
      const text = chunk.trim();
      if (text) pending.push({ type: "harness.stderr", payload: { text: text.slice(0, 4000) } });
      schedule();
    },
    async flush() {
      if (stdoutBuffer.trim()) {
        pending.push({ type: "harness.stdout", payload: { text: stdoutBuffer.trim() } });
        stdoutBuffer = "";
      }
      await flush();
    },
  };
}
