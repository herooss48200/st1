import { createHash } from 'node:crypto';

export const ST1_SHADOW_SCHEMA_VERSION = 1;
export const ST1_SHADOW_EXECUTION_AUTHORITY = 'OBSERVE_ONLY';

const round = (value, digits = 8) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
};

export function createDeterministicConfigHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

export function classifySt1ShadowCandidates({
  signal,
  rsi,
  takerBuyRatio,
  oversold = 30,
  overbought = 70,
  rsiProximityPoints = 2,
  longFlowMinimum = 0.58,
  longFlowMaximum = 0.72
} = {}) {
  const normalizedSignal = String(signal || '').toUpperCase();
  const numericRsi = Number(rsi);
  const numericFlow = Number(takerBuyRatio);
  const isLong = normalizedSignal === 'BUY';
  const isShort = normalizedSignal === 'SELL';
  const rsiNear = Number.isFinite(numericRsi) && (
    (isLong && numericRsi >= oversold - rsiProximityPoints && numericRsi < oversold)
    || (isShort && numericRsi > overbought && numericRsi <= overbought + rsiProximityPoints)
  );
  const longFlowBand = isLong
    && Number.isFinite(numericFlow)
    && numericFlow >= longFlowMinimum
    && numericFlow <= longFlowMaximum;

  return {
    baseline: isLong || isShort,
    rsiNear,
    longFlowBand,
    longRsiFlow: isLong && rsiNear && longFlowBand,
    shortObservationOnly: isShort
  };
}

export function summarizeShadowBreadth(rows, calculatedAt = Date.now(), {
  flatThresholdPercent = 0.1,
  minimumValidRows = 30,
  upThreshold = 0.6,
  downThreshold = 0.6,
  interval = null
} = {}) {
  const valid = (Array.isArray(rows) ? rows : []).map((row) => ({
    returnPercent: Number(row?.returnPercent),
    weight: Math.sqrt(Math.max(0, Number(row?.quoteVolume ?? row?.volume24h ?? 0)))
  })).filter((row) => Number.isFinite(row.returnPercent));

  if (valid.length < minimumValidRows) {
    return {
      interval,
      calculatedAt,
      state: 'INVALID',
      validRows: valid.length,
      upRatio: null,
      downRatio: null,
      flatRatio: null
    };
  }

  const useEqualWeights = valid.every((row) => !(row.weight > 0));
  const totalWeight = valid.reduce((sum, row) => sum + (useEqualWeights ? 1 : row.weight), 0);
  const ratio = (predicate) => valid.reduce(
    (sum, row) => sum + (predicate(row.returnPercent) ? (useEqualWeights ? 1 : row.weight) : 0),
    0
  ) / totalWeight;
  const upRatio = ratio((value) => value > flatThresholdPercent);
  const downRatio = ratio((value) => value < -flatThresholdPercent);
  const flatRatio = Math.max(0, 1 - upRatio - downRatio);
  const state = upRatio >= upThreshold
    ? 'UP'
    : (downRatio >= downThreshold ? 'DOWN' : 'NEUTRAL');

  return {
    interval,
    calculatedAt,
    state,
    validRows: valid.length,
    upRatio: round(upRatio),
    downRatio: round(downRatio),
    flatRatio: round(flatRatio)
  };
}

export function resolveShadowRegime(signal, telemetry = {}) {
  const expected = String(signal || '').toUpperCase() === 'SELL' ? 'DOWN' : 'UP';
  const opposite = expected === 'UP' ? 'DOWN' : 'UP';
  const btcTrend = String(telemetry?.btcTrend || '').toUpperCase() || null;
  const ethTrend = String(telemetry?.ethTrend || '').toUpperCase() || null;
  const breadth15m = String(telemetry?.breadth15m?.state || '').toUpperCase() || null;
  const available = [btcTrend, ethTrend, breadth15m].filter(Boolean);

  let classification = 'UNAVAILABLE';
  if (available.length > 0) {
    const aligned = available.filter((value) => value === expected).length;
    const opposed = available.filter((value) => value === opposite).length;
    classification = opposed >= 2
      ? 'WEAK'
      : (aligned >= 2 && opposed === 0 ? 'STRONG' : 'NORMAL');
  }

  const multiplierByClass = { STRONG: 2.25, NORMAL: 1.75, WEAK: 1.25, UNAVAILABLE: 1.75 };
  return {
    classification,
    recommendedAtrTrailingMultiplier: multiplierByClass[classification],
    btcTrend,
    ethTrend,
    breadth15m: telemetry?.breadth15m || null,
    breadth24h: telemetry?.breadth24h || null,
    calculatedAt: Number(telemetry?.calculatedAt) || null,
    observationOnly: true
  };
}

export function buildScientificShadowConfig(config) {
  return {
    labVersion: config.APP_VERSION,
    rsiOversold: config.ST1_RENKO_RSI_OVERSOLD,
    rsiOverbought: config.ST1_RENKO_RSI_OVERBOUGHT,
    rsiProximityPoints: config.ST1_SHADOW_RSI_PROXIMITY_POINTS,
    longFlowMinimum: config.ST1_ORDERFLOW_LONG_MIN_BUY_RATIO,
    longFlowMaximum: config.ST1_SHADOW_LONG_FLOW_MAX_BUY_RATIO,
    earlyLockTriggerPercent: config.ST1_SHADOW_EARLY_LOCK_TRIGGER_PERCENT,
    commissionRate: config.COMMISSION_RATE,
    estimatedSlippagePercent: config.ESTIMATED_SLIPPAGE_PERCENT,
    costBufferPercent: config.ST1_SHADOW_COST_BUFFER_PERCENT,
    staleMinutes: config.ST1_SHADOW_STALE_MINUTES,
    staleMaxMfePercent: config.ST1_SHADOW_STALE_MAX_MFE_PERCENT,
    atrTrailingMultipliers: [1.25, 1.75, 2.25]
  };
}

export function createSt1ScientificShadow({
  signal,
  entryPrice,
  enteredAt = Date.now(),
  rsi,
  takerBuyRatio,
  regimeTelemetry = null,
  settings
}) {
  const configHash = createDeterministicConfigHash(settings);
  const roundTripCommissionPercent = Number(settings.commissionRate) * 2 * 100;
  const costFloorPercent = roundTripCommissionPercent
    + Number(settings.estimatedSlippagePercent)
    + Number(settings.costBufferPercent);

  return {
    schemaVersion: ST1_SHADOW_SCHEMA_VERSION,
    labVersion: settings.labVersion,
    executionAuthority: ST1_SHADOW_EXECUTION_AUTHORITY,
    configHash,
    createdAt: enteredAt,
    entry: {
      signal,
      entryPrice: Number(entryPrice),
      rsi: round(rsi),
      takerBuyRatio: round(takerBuyRatio),
      candidates: classifySt1ShadowCandidates({
        signal,
        rsi,
        takerBuyRatio,
        oversold: settings.rsiOversold,
        overbought: settings.rsiOverbought,
        rsiProximityPoints: settings.rsiProximityPoints,
        longFlowMinimum: settings.longFlowMinimum,
        longFlowMaximum: settings.longFlowMaximum
      })
    },
    regime: resolveShadowRegime(signal, regimeTelemetry || {}),
    costs: {
      roundTripCommissionPercent: round(roundTripCommissionPercent),
      estimatedSlippagePercent: round(settings.estimatedSlippagePercent),
      bufferPercent: round(settings.costBufferPercent),
      costFloorPercent: round(costFloorPercent)
    },
    path: {
      lastObservedAt: enteredAt,
      observationCount: 0,
      maxFavorableExcursionPercent: 0,
      maxAdverseExcursionPercent: 0,
      milestones: [{
        at: enteredAt,
        price: Number(entryPrice),
        favorableMovePercent: 0,
        atr: null,
        reason: 'ENTRY'
      }]
    },
    exitExperiments: {
      baseline: { status: 'ACTIVE' },
      earlyCostSafe: {
        status: 'ARMED',
        triggerPercent: Number(settings.earlyLockTriggerPercent),
        virtualStopGrossPercent: round(costFloorPercent),
        activatedAt: null,
        virtualExitAt: null,
        virtualExitPrice: null,
        virtualNetPercent: null
      },
      staleTrade: {
        status: 'ARMED',
        afterMinutes: Number(settings.staleMinutes),
        maximumMfePercent: Number(settings.staleMaxMfePercent),
        virtualExitAt: null,
        virtualExitPrice: null,
        virtualNetPercent: null
      },
      regimeAtrTrailing: {
        status: 'OBSERVATION_ONLY',
        candidates: [...settings.atrTrailingMultipliers],
        recommendedMultiplier: resolveShadowRegime(signal, regimeTelemetry || {})
          .recommendedAtrTrailingMultiplier
      }
    },
    marketMicrostructure: {
      status: 'NOT_COLLECTED_R43_2',
      spreadBps: null,
      orderBookImbalance: null,
      fundingRate: null,
      openInterestChange: null
    },
    actualOutcome: null
  };
}

const favorableMovePercent = (signal, entryPrice, currentPrice) => (
  String(signal).toUpperCase() === 'SELL'
    ? ((entryPrice - currentPrice) / entryPrice) * 100
    : ((currentPrice - entryPrice) / entryPrice) * 100
);

const priceAtGrossPercent = (signal, entryPrice, grossPercent) => (
  String(signal).toUpperCase() === 'SELL'
    ? entryPrice * (1 - (grossPercent / 100))
    : entryPrice * (1 + (grossPercent / 100))
);

export function updateSt1ScientificShadow(shadow, {
  signal,
  entryPrice,
  currentPrice,
  atrValue = null,
  enteredAt,
  now = Date.now()
}) {
  if (!shadow || shadow.executionAuthority !== ST1_SHADOW_EXECUTION_AUTHORITY) {
    return { shadow, changed: false };
  }
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  if (!(entry > 0) || !(current > 0)) return { shadow, changed: false };

  const next = structuredClone(shadow);
  const move = favorableMovePercent(signal, entry, current);
  const priorMfe = Number(next.path.maxFavorableExcursionPercent || 0);
  const priorMae = Number(next.path.maxAdverseExcursionPercent || 0);
  const priorMilestone = next.path.milestones?.at(-1) || null;
  next.path.lastObservedAt = now;
  next.path.observationCount = Number(next.path.observationCount || 0) + 1;
  next.path.maxFavorableExcursionPercent = round(Math.max(priorMfe, move));
  next.path.maxAdverseExcursionPercent = round(Math.min(priorMae, move));
  let changed = false;

  const early = next.exitExperiments.earlyCostSafe;
  if (early.status === 'ARMED' && move >= Number(early.triggerPercent)) {
    early.status = 'ACTIVE';
    early.activatedAt = now;
    changed = true;
  } else if (early.status === 'ACTIVE' && move <= Number(early.virtualStopGrossPercent)) {
    const grossPercent = Number(early.virtualStopGrossPercent);
    early.status = 'VIRTUAL_CLOSED';
    early.virtualExitAt = now;
    early.virtualExitPrice = round(priceAtGrossPercent(signal, entry, grossPercent));
    early.virtualNetPercent = round(grossPercent - Number(next.costs.costFloorPercent));
    changed = true;
  }

  const stale = next.exitExperiments.staleTrade;
  const elapsedMinutes = (now - Number(enteredAt)) / 60_000;
  if (stale.status === 'ARMED'
    && elapsedMinutes >= Number(stale.afterMinutes)
    && Number(next.path.maxFavorableExcursionPercent) < Number(stale.maximumMfePercent)) {
    stale.status = 'VIRTUAL_CLOSED';
    stale.virtualExitAt = now;
    stale.virtualExitPrice = current;
    stale.virtualNetPercent = round(move - Number(next.costs.costFloorPercent));
    changed = true;
  }

  const milestoneIntervalMs = 15 * 60_000;
  const excursionStepPercent = 0.1;
  const improvedMfe = Number(next.path.maxFavorableExcursionPercent)
    >= Number(priorMilestone?.maxFavorableExcursionPercent || 0) + excursionStepPercent;
  const worsenedMae = Math.abs(Number(next.path.maxAdverseExcursionPercent))
    >= Math.abs(Number(priorMilestone?.maxAdverseExcursionPercent || 0)) + excursionStepPercent;
  const timedCheckpoint = !priorMilestone || now - Number(priorMilestone.at || 0) >= milestoneIntervalMs;
  if (changed || improvedMfe || worsenedMae || timedCheckpoint) {
    const reason = changed
      ? 'SHADOW_STATE_CHANGE'
      : (timedCheckpoint ? 'TIME_CHECKPOINT' : 'EXCURSION_CHECKPOINT');
    next.path.milestones = [...(next.path.milestones || []), {
      at: now,
      price: current,
      favorableMovePercent: round(move),
      maxFavorableExcursionPercent: next.path.maxFavorableExcursionPercent,
      maxAdverseExcursionPercent: next.path.maxAdverseExcursionPercent,
      atr: round(atrValue),
      reason
    }].slice(-512);
    changed = true;
  }

  return { shadow: next, changed };
}

export function finalizeSt1ScientificShadow(shadow, {
  exitTime = Date.now(),
  exitPrice,
  exitType,
  grossPnlPercent,
  netPnlUsdt,
  maxFavorableExcursionPercent,
  maxAdverseExcursionPercent
}) {
  if (!shadow) return null;
  const next = structuredClone(shadow);
  next.path.lastObservedAt = exitTime;
  next.path.maxFavorableExcursionPercent = round(Math.max(
    Number(next.path.maxFavorableExcursionPercent || 0),
    Number(maxFavorableExcursionPercent || 0)
  ));
  next.path.maxAdverseExcursionPercent = round(Math.min(
    Number(next.path.maxAdverseExcursionPercent || 0),
    Number(maxAdverseExcursionPercent || 0)
  ));
  next.exitExperiments.baseline = {
    status: 'CLOSED',
    exitTime,
    exitPrice: Number(exitPrice),
    exitType,
    grossPnlPercent: round(grossPnlPercent),
    netPnlUsdt: round(netPnlUsdt)
  };
  next.actualOutcome = { exitTime, exitPrice: Number(exitPrice), exitType };
  return next;
}
