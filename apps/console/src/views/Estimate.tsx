import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { nimplex } from "../client.ts";
import { CopyCall, Empty, ErrorNote, Field, Panel } from "../ui.tsx";

/**
 * 跑前試算：同一個 run 換 model／sandbox 差多少錢。
 * model 價格是真的（GET /v1/models，計量與試算共用同一份價格表）；
 * sandbox 機時是近似值（每家 pricing 頁手抄，之後隨 price registry 版本化）。
 */
const SANDBOX_RATE_PER_HOUR: Record<string, number> = {
  local: 0,
  docker: 0,
  e2b: 0.14, // 2 vCPU / 4GB 級距的近似值
  vercel: 0.128,
  daytona: 0.12,
};

// API 沒起或價格表空時的示意價格（形狀先看得見；數字為示意）
const FALLBACK_MODELS = [
  {
    provider: "anthropic" as const,
    model: "claude-sonnet-5",
    input_per_mtok: 3,
    output_per_mtok: 15,
  },
  {
    provider: "anthropic" as const,
    model: "claude-haiku-4-5",
    input_per_mtok: 1,
    output_per_mtok: 5,
  },
  { provider: "openai" as const, model: "gpt-5", input_per_mtok: 1.25, output_per_mtok: 10 },
  {
    provider: "openrouter" as const,
    model: "anthropic/claude-sonnet-4.5",
    input_per_mtok: 3,
    output_per_mtok: 15,
  },
];

export function EstimatePage() {
  const models = useQuery({ queryKey: ["models"], queryFn: () => nimplex.models.list() });
  const [inputMtok, setInputMtok] = useState("2");
  const [outputMtok, setOutputMtok] = useState("0.3");
  const [minutes, setMinutes] = useState("15");

  const inM = Number(inputMtok) || 0;
  const outM = Number(outputMtok) || 0;
  const mins = Number(minutes) || 0;

  const usingFallback = !models.isPending && (models.data?.length ?? 0) === 0;
  const priced = usingFallback ? FALLBACK_MODELS : (models.data ?? []);

  const rows = priced
    .flatMap((m) =>
      Object.entries(SANDBOX_RATE_PER_HOUR).map(([sandbox, rate]) => {
        const tokenCost = inM * m.input_per_mtok + outM * m.output_per_mtok;
        const sandboxCost = (mins / 60) * rate;
        return { model: m, sandbox, tokenCost, sandboxCost, total: tokenCost + sandboxCost };
      }),
    )
    .sort((a, b) => a.total - b.total);

  const max = rows.at(-1)?.total ?? 1;

  return (
    <>
      <h1>跑前試算</h1>
      <p className="lede">
        同一個 run，在不同 model × sandbox 組合下各要多少錢。
        <strong>token 為主、機時為輔</strong>——一次 coding run 的 token
        成本通常比機時高一到兩個數量級。 model 單價與計量用的是同一份價格表；機時是近似值。
      </p>

      <Panel title="這個 run 大概長怎樣">
        <div className="form-grid">
          <Field htmlFor="est-in" label="Input（Mtok）" hint="讀 repo、上下文、工具回傳加總">
            <input id="est-in" value={inputMtok} onChange={(e) => setInputMtok(e.target.value)} />
          </Field>
          <Field htmlFor="est-out" label="Output（Mtok）">
            <input
              id="est-out"
              value={outputMtok}
              onChange={(e) => setOutputMtok(e.target.value)}
            />
          </Field>
          <Field htmlFor="est-min" label="沙箱時長（分鐘）">
            <input id="est-min" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
        </div>
      </Panel>

      <Panel
        title={usingFallback ? "比價（由便宜到貴）· 示意價格" : "比價（由便宜到貴）"}
        actions={<CopyCall snippet="await nimplex.models.list()" label="複製價格表呼叫" />}
      >
        <ErrorNote error={models.error} />
        {models.isPending ? <Empty>載入價格表…</Empty> : null}
        <div className="estlist">
          {rows.map((r) => (
            <div key={`${r.model.provider}/${r.model.model}/${r.sandbox}`} className="estrow">
              <span className="mono strong">
                {r.model.provider}/{r.model.model}
              </span>
              <span className="tag mono">{r.sandbox}</span>
              <span className="spacer" />
              <span className="dim mono">
                token ${r.tokenCost.toFixed(3)} + 機時 ${r.sandboxCost.toFixed(3)}
              </span>
              <span className="mono strong">${r.total.toFixed(3)}</span>
              <span className="estbar" style={{ width: `${(r.total / max) * 120}px` }} />
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
