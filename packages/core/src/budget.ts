// 美元硬上限（W2）。金額一律以 USD number 計，資料庫為 numeric(12,6)。

export interface BudgetCheck {
  remainingUsd: number;
  exceeded: boolean;
}

export function checkBudget(spentUsd: number, budgetUsd: number): BudgetCheck {
  const remainingUsd = roundUsd(budgetUsd - spentUsd);
  return { remainingUsd, exceeded: remainingUsd <= 0 };
}

export function settleSpend(spentUsd: number, costUsd: number): number {
  return roundUsd(spentUsd + costUsd);
}

export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
