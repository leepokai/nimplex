// 插槽 2：harness 模板展開。
//
// harness manifest 是資料，內建的與使用者上傳的走同一條路。
// 展開時有兩種語意，不能混用：
//   - env：原樣代入（值最後是 execve 的環境變數陣列，不經過 shell）
//   - install / command：代入前一律 shell 單引號包起來
//     → manifest 作者**不可以**自己補引號（`-p "{{prompt}}"` 是錯的，寫 `-p {{prompt}}`）
//     這條規則同時擋掉 prompt 內容做 shell injection。

import type { HarnessManifest, ModelProvider } from "@nimplex/contracts";

export interface HarnessRenderContext {
  runId: string;
  /** 沙箱裡用的短期票，不是使用者的真 key */
  runToken: string;
  model: string;
  prompt: string;
  /** 各協定的 nimplex 閘道 base URL */
  gateway: Record<ModelProvider, string>;
  workdir: string;
}

export interface RenderedHarness {
  install: string[];
  command: string;
  env: Record<string, string>;
  /** command 裡沒有 {{prompt}} 佔位時，prompt 改從 stdin 餵進去 */
  stdin: string | null;
  workdir: string;
  timeoutMs: number;
}

const PROMPT_TOKEN = "{{prompt}}";

export function renderHarness(
  manifest: HarnessManifest,
  ctx: HarnessRenderContext,
): RenderedHarness {
  const vars: Record<string, string> = {
    "gateway.anthropic": ctx.gateway.anthropic,
    "gateway.openai": ctx.gateway.openai,
    "gateway.openrouter": ctx.gateway.openrouter,
    "run.token": ctx.runToken,
    "run.id": ctx.runId,
    model: ctx.model,
    prompt: ctx.prompt,
    workdir: ctx.workdir,
  };

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.env)) {
    env[key] = substitute(value, vars, (v) => v);
  }

  return {
    install: manifest.install.map((line) => substitute(line, vars, shellQuote)),
    command: substitute(manifest.command, vars, shellQuote),
    env,
    stdin: manifest.command.includes(PROMPT_TOKEN) ? null : ctx.prompt,
    workdir: ctx.workdir,
    timeoutMs: manifest.timeout_seconds * 1000,
  };
}

/** manifest 裡引用了不存在的變數就當場失敗——比在沙箱裡看到空字串好除錯。 */
export function collectUnknownVariables(manifest: HarnessManifest): string[] {
  const known = new Set([
    "gateway.anthropic",
    "gateway.openai",
    "gateway.openrouter",
    "run.token",
    "run.id",
    "model",
    "prompt",
    "workdir",
  ]);
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
      const name = match[1];
      if (name && !known.has(name)) found.add(name);
    }
  };
  scan(manifest.command);
  for (const line of manifest.install) scan(line);
  for (const value of Object.values(manifest.env)) scan(value);
  return [...found];
}

function substitute(
  template: string,
  vars: Record<string, string>,
  transform: (value: string) => string,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : transform(value);
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
