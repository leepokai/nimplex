// USD budget arithmetic; amounts are numbers backed by numeric(12,6) in Postgres.
//
// Reservations allocate estimated cost before dispatch and settle after responses.
// Without them, concurrent calls can all pass the same spent-below-cap check
// and exceed the budget together.

export interface BudgetCheck {
  remainingUsd: number;
  exceeded: boolean;
}

export function checkBudget(spentUsd: number, budgetUsd: number): BudgetCheck {
  const remainingUsd = roundUsd(budgetUsd - spentUsd);
  return { remainingUsd, exceeded: remainingUsd <= 0 };
}

/** Admission uses available funds including reservations, not settled spending alone. */
export function availableUsd(spentUsd: number, reservedUsd: number, budgetUsd: number): number {
  return roundUsd(budgetUsd - spentUsd - reservedUsd);
}

export function settleSpend(spentUsd: number, costUsd: number): number {
  return roundUsd(spentUsd + costUsd);
}

export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
