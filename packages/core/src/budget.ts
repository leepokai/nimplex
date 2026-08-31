// 美元硬上限。金額一律以 USD number 計，資料庫為 numeric(12,6)。
//
// reserved 是併發保險：閘道在發出請求**之前**先扣一筆估計值，
// 回應回來再結算（settle）。沒有這一步，同一個 run 併發打 10 個 call
// 會全部通過「目前花費 < 上限」的檢查，然後一起超燒。

export interface BudgetCheck {
  remainingUsd: number;
  exceeded: boolean;
}

export function checkBudget(spentUsd: number, budgetUsd: number): BudgetCheck {
  const remainingUsd = roundUsd(budgetUsd - spentUsd);
  return { remainingUsd, exceeded: remainingUsd <= 0 };
}

/** 含預留的可用額度：閘道放行與否看這個，不是看 spent。 */
export function availableUsd(spentUsd: number, reservedUsd: number, budgetUsd: number): number {
  return roundUsd(budgetUsd - spentUsd - reservedUsd);
}

export function settleSpend(spentUsd: number, costUsd: number): number {
  return roundUsd(spentUsd + costUsd);
}

export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
