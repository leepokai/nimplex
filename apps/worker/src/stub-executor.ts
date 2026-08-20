import type { RunExecutor } from "@loopbox/core";
import { z } from "zod";

const stepPayload = z.object({ step: z.number().int().min(1) });

const TOTAL_STEPS = 5;
const COST_PER_STEP_USD = 0.12;

// 佔位 executor：模擬一個 5 步、每步 $0.12 的 run。
// 換成真的 model provider（Anthropic BYOK）時，只需要換掉這個實作——
// worker 主迴圈、budget 強制、事件流全部不動。
export const stubExecutor: RunExecutor = {
  id: "builtin",
  async step(_run, item) {
    const { step } = stepPayload.parse(item.payload);
    const events = [
      {
        type: "message.delta",
        payload: { step, text: `（stub executor）第 ${step}/${TOTAL_STEPS} 步` },
      },
    ];
    if (step >= TOTAL_STEPS) {
      return { events, costUsd: COST_PER_STEP_USD, next: { kind: "complete" as const } };
    }
    return {
      events,
      costUsd: COST_PER_STEP_USD,
      next: {
        kind: "continue" as const,
        nextItem: { kind: "model" as const, payload: { step: step + 1 } },
      },
    };
  },
};
