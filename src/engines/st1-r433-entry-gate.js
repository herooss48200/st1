export const ST1_R433_ENTRY_POLICY = 'LONG_RSI_28_30_AND_TAKER_058_072_SHORT_DISABLED';
export const ST1_R438_ADDITIVE_POLICY = 'SHADOW_ONLY_LONG_RSI_26_27_AND_TAKER_058_072';

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function evaluateSt1R433SetupGate({ signal, rsi } = {}, {
  enabled = true,
  longRsiMinimum = 28,
  longRsiMaximumExclusive = 30,
  additiveShadowEnabled = false,
  additiveRsiMinimum = 26,
  additiveRsiMaximumExclusive = 27
} = {}) {
  if (!enabled) return { allowed: true, reason: 'ST1_R433_GATE_DISABLED' };

  const normalizedSignal = String(signal || '').toUpperCase();
  if (normalizedSignal === 'SELL') {
    return { allowed: false, reason: 'ST1_R433_SHORT_DISABLED_BY_90D_REPLAY' };
  }
  const numericRsi = finite(rsi);
  const minimum = finite(longRsiMinimum);
  const maximum = finite(longRsiMaximumExclusive);
  const additiveMinimum = finite(additiveRsiMinimum);
  const additiveMaximum = finite(additiveRsiMaximumExclusive);
  if (normalizedSignal !== 'BUY' || numericRsi == null || minimum == null || maximum == null
    || !(minimum < maximum)) {
    return { allowed: false, reason: 'ST1_R433_SETUP_GATE_INPUT_INVALID' };
  }
  const coreAllowed = numericRsi >= minimum && numericRsi < maximum;
  const additiveAllowed = additiveShadowEnabled === true
    && additiveMinimum != null
    && additiveMaximum != null
    && additiveMinimum < additiveMaximum
    && numericRsi >= additiveMinimum
    && numericRsi < additiveMaximum;
  if (!coreAllowed && !additiveAllowed) {
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
    reason: additiveAllowed
      ? 'ST1_R438_ADDITIVE_LONG_RSI_26_27'
      : 'ST1_R433_LONG_RSI_NEAR_THRESHOLD',
    lane: additiveAllowed ? 'R438_SHADOW' : 'R433_CORE',
    executionAuthority: additiveAllowed ? 'SHADOW_ONLY' : 'CORE_ORDER_ROUTE',
    rsi: numericRsi,
    minimum: additiveAllowed ? additiveMinimum : minimum,
    maximumExclusive: additiveAllowed ? additiveMaximum : maximum
  };
}

export function evaluateSt1R433EntryGate({ signal, rsi, takerBuyRatio } = {}, {
  enabled = true,
  longRsiMinimum = 28,
  longRsiMaximumExclusive = 30,
  longFlowMinimum = 0.58,
  longFlowMaximum = 0.72,
  additiveShadowEnabled = false,
  additiveRsiMinimum = 26,
  additiveRsiMaximumExclusive = 27,
  additiveFlowMinimum = 0.58,
  additiveFlowMaximum = 0.72
} = {}) {
  const setupGate = evaluateSt1R433SetupGate({ signal, rsi }, {
    enabled,
    longRsiMinimum,
    longRsiMaximumExclusive,
    additiveShadowEnabled,
    additiveRsiMinimum,
    additiveRsiMaximumExclusive
  });
  if (!setupGate.allowed || !enabled) return setupGate;

  const ratio = finite(takerBuyRatio);
  const additiveLane = setupGate.lane === 'R438_SHADOW';
  const minimum = finite(additiveLane ? additiveFlowMinimum : longFlowMinimum);
  const maximum = finite(additiveLane ? additiveFlowMaximum : longFlowMaximum);
  if (ratio == null || minimum == null || maximum == null || !(minimum < maximum)) {
    return { allowed: false, reason: 'ST1_R433_FLOW_GATE_INPUT_INVALID' };
  }
  if (ratio < minimum || ratio > maximum) {
    return {
      allowed: false,
      reason: additiveLane
        ? 'ST1_R438_ADDITIVE_FLOW_OUTSIDE_058_072'
        : 'ST1_R433_LONG_FLOW_OUTSIDE_058_072',
      takerBuyRatio: ratio,
      minimum,
      maximum
    };
  }
  return {
    allowed: true,
    reason: additiveLane
      ? 'ST1_R438_SHADOW_CONFIRMED'
      : 'ST1_R433_LONG_RSI_FLOW_REPLAY_CONFIRMED',
    policy: additiveLane ? ST1_R438_ADDITIVE_POLICY : ST1_R433_ENTRY_POLICY,
    lane: setupGate.lane,
    executionAuthority: setupGate.executionAuthority,
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
  ST1_R438_ADDITIVE_POLICY,
  evaluateSt1R433SetupGate,
  evaluateSt1R433EntryGate
};
