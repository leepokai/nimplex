// 內建 harness 註冊表（＝「網路上的 harness」那一格的預設內容）。
//
// 這些只是**種子資料**：seed 時寫進 harnesses 表，之後 org 可以覆寫或新增自己的。
// 指令旗標會隨上游 CLI 改版而變 —— 這正是把它放在資料庫而不是程式碼裡的理由：
// 上游改了旗標，客戶自己 PUT 一份新的 manifest 就好，不用等我們發版。

import type { HarnessManifest } from "@nimplex/contracts";

/**
 * 這個指令是哨兵值，不是真的可執行檔：worker 看到它就走內建 loop，
 * 不開沙箱、不需要 BYOK key。用來在零設定的情況下驗證計量與 kill-switch。
 */
export const BUILTIN_LOOP_COMMAND = "nimplex-builtin-loop";

/**
 * 第二個哨兵：Claude Managed Agents。worker 看到它不開沙箱、不裝東西，
 * 而是透過閘道（BYOK 換 key、真 key 不進 worker）呼叫 Anthropic 的 sessions API，
 * agent loop 與容器都在 Anthropic 那邊跑；花費由上游 session.usage 回報（metering=provider_reported）。
 */
export const BUILTIN_MANAGED_AGENT_COMMAND = "nimplex-claude-managed-agent";

export type ExecutionKind = "builtin-loop" | "managed-agent" | "sandbox";

/** manifest 的 command 決定 worker 走哪條執行路徑。 */
export function executionKind(manifest: Pick<HarnessManifest, "command">): ExecutionKind {
  if (manifest.command === BUILTIN_LOOP_COMMAND) return "builtin-loop";
  if (manifest.command === BUILTIN_MANAGED_AGENT_COMMAND) return "managed-agent";
  return "sandbox";
}

export const BUILTIN_HARNESSES: HarnessManifest[] = [
  {
    slug: "builtin",
    name: "nimplex builtin loop",
    version: "0.1.0",
    description: "不需要沙箱的內建迴圈，用來驗證計量與 kill-switch",
    source: { kind: "inline" },
    install: [],
    command: BUILTIN_LOOP_COMMAND,
    env: {},
    provider: "anthropic",
    output: "text",
    workdir: "/workspace",
    timeout_seconds: 900,
  },
  {
    slug: "claude-managed-agent",
    name: "Claude Managed Agents",
    version: "0.1.0",
    description: "Anthropic 託管的 agent loop 與容器；預算由 Anthropic 端強制，花費以公開價回報",
    source: { kind: "inline" },
    install: [],
    command: BUILTIN_MANAGED_AGENT_COMMAND,
    env: {},
    provider: "anthropic",
    output: "stream-json",
    workdir: "/workspace",
    timeout_seconds: 3600,
  },
  {
    slug: "claude-code",
    name: "Claude Code",
    version: "0.1.0",
    description: "Anthropic 官方 CLI；base URL 指向 nimplex 閘道",
    source: { kind: "npm", package: "@anthropic-ai/claude-code", version: "latest" },
    install: ["npm install -g @anthropic-ai/claude-code@latest"],
    command:
      "claude -p {{prompt}} --model {{model}} --output-format stream-json --verbose --permission-mode bypassPermissions",
    env: {
      ANTHROPIC_BASE_URL: "{{gateway.anthropic}}",
      ANTHROPIC_API_KEY: "{{run.token}}",
      ANTHROPIC_AUTH_TOKEN: "{{run.token}}",
    },
    provider: "anthropic",
    output: "stream-json",
    workdir: "/workspace",
    timeout_seconds: 1800,
  },
  {
    slug: "opencode",
    name: "OpenCode",
    version: "0.1.0",
    description: "開源 coding agent CLI",
    source: { kind: "npm", package: "opencode-ai", version: "latest" },
    install: ["npm install -g opencode-ai@latest"],
    command: "opencode run {{prompt}} --model {{model}}",
    env: {
      ANTHROPIC_BASE_URL: "{{gateway.anthropic}}",
      ANTHROPIC_API_KEY: "{{run.token}}",
    },
    provider: "anthropic",
    output: "text",
    workdir: "/workspace",
    timeout_seconds: 1800,
  },
  {
    slug: "codex",
    name: "OpenAI Codex CLI",
    version: "0.1.0",
    description: "OpenAI 官方 CLI；base URL 指向 nimplex 閘道",
    source: { kind: "npm", package: "@openai/codex", version: "latest" },
    install: ["npm install -g @openai/codex@latest"],
    command: "codex exec --skip-git-repo-check {{prompt}}",
    env: {
      OPENAI_BASE_URL: "{{gateway.openai}}",
      OPENAI_API_KEY: "{{run.token}}",
    },
    provider: "openai",
    output: "text",
    workdir: "/workspace",
    timeout_seconds: 1800,
  },
];

export const BUILTIN_HARNESS_SLUGS = BUILTIN_HARNESSES.map((h) => h.slug);
