export const ST1_R433_ENTRY_POLICY = 'LONG_RSI_28_30_AND_TAKER_058_072_SHORT_DISABLED';

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function evaluateSt1R433SetupGate({ signal, rsi } = {}, {
  enabled = true,
  longRsiMinimum = 28,
  longRsiMaximumExclusive = 30
} = {}) {
  if (!enabled) return { allowed: true, reason: 'ST1_R433_GATE_DISABLED' };

  const normalizedSignal = String(signal || '').toUpperCase();
  if (normalizedSignal === 'SELL') {
    return { allowed: false, reason: 'ST1_R433_SHORT_DISABLED_BY_90D_REPLAY' };
  }
  const numericRsi = finite(rsi);
  const minimum = finite(longRsiMinimum);
  const maximum = finite(longRsiMaximumExclusive);
  if (normalizedSignal !== 'BUY' || numericRsi == null || minimum == null || maximum == null
    || !(minimum < maximum)) {
    return { allowed: false, reason: 'ST1_R433_SETUP_GATE_INPUT_INVALID' };
  }
  if (numericRsi < minimum || numericRsi >= maximum) {
    return {
      allowed: false,
      reason: 'ST1_R433_LONG_RSI_OUTSIDE_28_30',
      rsi: numericRsi,
      minimum,
      maximumExclusive: maximum
    };
  }
  return {
    allowed: true,
    reason: 'ST1_R433_LONG_RSI_NEAR_THRESHOLD',
    rsi: numericRsi,
    minimum,
    maximumExclusive: maximum
  };
}

export function evaluateSt1R433EntryGate({ signal, rsi, takerBuyRatio } = {}, {
  enabled = true,
  longRsiMinimum = 28,
  longRsiMaximumExclusive = 30,
  longFlowMinimum = 0.58,
  longFlowMaximum = 0.72
} = {}) {
  const setupGate = evaluateSt1R433SetupGate({ signal, rsi }, {
    enabled,
    longRsiMinimum,
    longRsiMaximumExclusive
  });
  if (!setupGate.allowed || !enabled) return setupGate;

  const ratio = finite(takerBuyRatio);
  const minimum = finite(longFlowMinimum);
  const maximum = finite(longFlowMaximum);
  if (ratio == null || minimum == null || maximum == null || !(minimum < maximum)) {
    return { allowed: false, reason: 'ST1_R433_FLOW_GATE_INPUT_INVALID' };
  }
  if (ratio < minimum || ratio > maximum) {
    return {
      allowed: false,
      reason: 'ST1_R433_LONG_FLOW_OUTSIDE_058_072',
      takerBuyRatio: ratio,
      minimum,
      maximum
    };
  }
  return {
    allowed: true,
    reason: 'ST1_R433_LONG_RSI_FLOW_REPLAY_CONFIRMED',
    policy: ST1_R433_ENTRY_POLICY,
    rsi: setupGate.rsi,
    takerBuyRatio: ratio,
    rsiMinimum: setupGate.minimum,
    rsiMaximumExclusive: setupGate.maximumExclusive,
    flowMinimum: minimum,
    flowMaximum: maximum
  };
}

export default {
  ST1_R433_ENTRY_POLICY,
  evaluateSt1R433SetupGate,
  evaluateSt1R433EntryGate
};
