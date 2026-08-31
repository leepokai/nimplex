import { useState } from "react";

/**
 * 「連接你的程式碼代理」浮卡（抄 Insforge 的那張）。
 * 提示詞是真的可以用的：貼進 Claude Code / Cursor / Codex，
 * agent 就能用 @nimplex/sdk 把三個插槽接起來 —— 不是裝飾性的假指令。
 */
const PROMPT = `Set up Nimplex (OpenRouter for cloud agents) for this project.
1. Install the SDK: pnpm add @nimplex/sdk
2. Point it at the control plane: export NIMPLEX_BASE_URL=http://localhost:8787
3. Connect a model provider key (BYOK, stored encrypted):
   const nx = new Nimplex();
   await nx.providerKeys.put({ provider: "anthropic", api_key: "<key>", scope: "org" });
4. Run any harness on any sandbox:
   const run = await nx.agent({
     harness: "claude-code",
     model: { provider: "anthropic", id: "claude-sonnet-5" },
     sandbox: { provider: "docker" },
     instructions: "<what to do>",
     budgetUsd: 0.5,
   }).stream({ prompt: "<task>" });
   for await (const event of run.events) console.log(event.type, event.payload);`;

export function AgentConnect() {
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  if (hidden) return null;

  return (
    <aside className="agentcard" aria-label="連接你的程式碼代理">
      <header className="agentcard-head">
        <span className="agentcard-title">
          <span className="agentcard-glyph" aria-hidden="true">
            ❯_
          </span>
          連接你的程式碼代理
        </span>
        <button type="button" className="modal-x" aria-label="關閉" onClick={() => setHidden(true)}>
          ✕
        </button>
      </header>
      <pre className="agentcard-code">
        <code>{PROMPT}</code>
      </pre>
      <footer className="agentcard-foot">
        <span className="dim">貼到 Claude Code、Cursor、Codex 或任何程式碼代理中</span>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            void navigator.clipboard?.writeText(PROMPT);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? "已複製 ✓" : "複製提示詞"}
        </button>
      </footer>
    </aside>
  );
}
