export const CLOSE_TRUTH_EPSILON = 1e-12;

export function classifyEconomicOutcome(netPnl, epsilon = CLOSE_TRUTH_EPSILON) {
  const value = Number(netPnl);
  if (!Number.isFinite(value)) return 'NEUTRAL';
  if (value > epsilon) return 'PROFIT';
  if (value < -epsilon) return 'LOSS';
  return 'NEUTRAL';
}

export function selectFilledProtectiveOrder(orders = [], filledStatus = 'FILLED') {
  return orders.find((order) => order?.status === filledStatus) || null;
}
