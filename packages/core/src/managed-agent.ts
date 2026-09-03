// Claude Managed Agents 事件 → nimplex 事件 union 的純函式翻譯層。
// 零 IO：worker 的 executor 拿到上游事件就丟進來，拿回要 append 的 nimplex 事件、
// 要回填的花費、以及 run 該往哪走。翻譯只在這裡做一次，SDK 與前端永遠只看 nimplex 型別。

export interface NimplexEventInput {
  type: string;
  payload?: unknown;
}

export type ManagedAgentOutcome =
  | { kind: "continue" }
  /** agent 在等我們回 tool 結果／確認——nimplex 沒配 custom tool，視為卡死 */
  | { kind: "requires_action" }
  | { kind: "completed" }
  | { kind: "budget_exceeded" }
  | { kind: "terminated" }
  | { kind: "failed"; error: string };

export interface TranslatedManagedAgentEvent {
  events: NimplexEventInput[];
  /** session.usage 帶回的累計 list cost（美元）；有值就回填 runs.spent_usd */
  spentUsd?: number;
  outcome: ManagedAgentOutcome;
}

const TOOL_RESULT_PREVIEW_CHARS = 4_000;

/** 美元 → Managed Agents budget 的「分」整數字串（"0.30" → "30"）；至少 1 分。 */
export function usdToCents(usd: number): string {
  const cents = Math.max(1, Math.round(usd * 100));
  return String(cents);
}

/** `{ amount, currency }`：amount 是分的整數字串（與 budget 同格式）；防禦性接受帶小數點的美元字串。 */
export function parseListCostUsd(listCost: unknown): number | null {
  if (!listCost || typeof listCost !== "object") return null;
  const amount = (listCost as Record<string, unknown>).amount;
  const raw = typeof amount === "number" ? String(amount) : amount;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return raw.includes(".") ? n : n / 100;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
    )
    .map((b) => b.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

function preview(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > TOOL_RESULT_PREVIEW_CHARS
      ? `${value.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
      : value;
  }
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  return json.length > TOOL_RESULT_PREVIEW_CHARS
    ? `${json.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
    : value;
}

export function translateManagedAgentEvent(raw: unknown): TranslatedManagedAgentEvent {
  const none: TranslatedManagedAgentEvent = { events: [], outcome: { kind: "continue" } };
  if (!raw || typeof raw !== "object") return none;
  const ev = raw as Record<string, unknown>;
  const type = typeof ev.type === "string" ? ev.type : "";

  switch (type) {
    case "agent.message":
      return {
        events: textBlocks(ev.content).map((text) => ({
          type: "message.delta",
          payload: { text },
        })),
        outcome: { kind: "continue" },
      };

    case "agent.tool_use":
    case "agent.mcp_tool_use":
    case "agent.custom_tool_use":
      return {
        events: [
          {
            type: "tool.call",
            payload: {
              id: ev.id,
              name: ev.name,
              input: preview(ev.input),
              source:
                type === "agent.tool_use"
                  ? "builtin"
                  : type === "agent.mcp_tool_use"
                    ? "mcp"
                    : "custom",
            },
          },
        ],
        outcome: { kind: "continue" },
      };

    case "agent.tool_result":
    case "agent.mcp_tool_result":
      return {
        events: [
          {
            type: "tool.result",
            payload: {
              tool_use_id: ev.tool_use_id,
              content: preview(ev.content),
              is_error: ev.is_error ?? false,
            },
          },
        ],
        outcome: { kind: "continue" },
      };

    case "session.usage": {
      const spentUsd = parseListCostUsd(ev.list_cost);
      return {
        events: [
          {
            type: "spend.updated",
            payload: { spent_usd: spentUsd, active_seconds: ev.active_seconds ?? null },
          },
        ],
        ...(spentUsd === null ? {} : { spentUsd }),
        outcome: { kind: "continue" },
      };
    }

    case "session.status_idle": {
      const stop = (ev.stop_reason ?? {}) as Record<string, unknown>;
      const reason = typeof stop.type === "string" ? stop.type : "end_turn";
      const status: NimplexEventInput = {
        type: "harness.event",
        payload: { type, stop_reason: reason },
      };
      if (reason === "requires_action")
        return { events: [status], outcome: { kind: "requires_action" } };
      if (reason === "budget_reached")
        return { events: [status], outcome: { kind: "budget_exceeded" } };
      if (reason === "retries_exhausted") {
        return {
          events: [status],
          outcome: { kind: "failed", error: "managed agent: retries_exhausted" },
        };
      }
      return { events: [status], outcome: { kind: "completed" } };
    }

    case "session.status_terminated":
      return {
        events: [{ type: "harness.event", payload: { type } }],
        outcome: { kind: "terminated" },
      };

    case "session.error": {
      const err = ev.error as Record<string, unknown> | undefined;
      const message =
        (typeof err?.message === "string" && err.message) ||
        (typeof ev.message === "string" && ev.message) ||
        "managed agent session error";
      return {
        events: [{ type: "harness.event", payload: { type, error: message } }],
        outcome: { kind: "failed", error: message },
      };
    }

    case "span.model_request_end":
      return {
        events: [{ type: "harness.event", payload: { type, model_usage: ev.model_usage ?? null } }],
        outcome: { kind: "continue" },
      };

    default:
      // 使用者事件回音、preview delta、狀態轉換等：不進事件流，避免噪音
      return none;
  }
}
