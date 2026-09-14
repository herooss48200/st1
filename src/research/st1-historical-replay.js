import {
  analyzeSimpleSt1RenkoSetup,
  analyzeTakerFlowConfirmation,
  hasCrossedEntryTarget,
  isOnEntryResetSide,
  isWithinEntryChaseLimit
} from '../engines/st1-renko-entry-engine.js';
import { classifySt1ShadowCandidates } from './st1-scientific-shadow.js';

const round = (value, digits = 8) => {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
};
const MINUTE_MS = 60_000;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function findHistoricalRenkoSetups(candles, {
  candleLimit = 800,
  analysisStartTime = Number.NEGATIVE_INFINITY,
  sourceInterval = '15m',
  ...renkoOptions
} = {}) {
  const rows = Array.isArray(candles) ? candles : [];
  const warmup = Math.max(32, Math.floor(Number(candleLimit) || 800));
  const setups = [];
  const seen = new Set();

  for (let end = warmup; end <= rows.length; end += 1) {
    const window = rows.slice(end - warmup, end);
    const evaluatedAt = Number(window.at(-1)?.closeTime);
    if (!Number.isFinite(evaluatedAt) || evaluatedAt < analysisStartTime) continue;
    const setup = analyzeSimpleSt1RenkoSetup(window, evaluatedAt, {
      sourceInterval,
      ...renkoOptions
    });
    if (!setup.triggered || !Number.isFinite(Number(setup.setupCloseTime))) continue;

    // One historical pusu per distinct terminal Renko brick. Repeated evaluations
    // of the same brick do not create independent observations.
    const identity = `${setup.signal}:${setup.setupCloseTime}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    setups.push({ ...setup, evaluatedAt });
  }

  return setups;
}

export function confirmHistoricalSetup(setup, oneMinuteCandles, {
  requiredConfirmations = 2,
  confirmationTimeoutMinutes = 3,
  maximumWaitMinutes = 15,
  windowCandles = 3,
  longMinimumBuyRatio = 0.58,
  shortMaximumBuyRatio = 0.42,
  maxChaseT = 0.25
} = {}) {
  const readyAt = Number(setup?.evaluatedAt ?? setup?.setupCloseTime);
  const maximumTime = readyAt + (Number(maximumWaitMinutes) * 60_000);
  const rows = (Array.isArray(oneMinuteCandles) ? oneMinuteCandles : [])
    .filter((candle) => Number(candle?.closeTime) <= maximumTime)
    .sort((left, right) => Number(left.closeTime) - Number(right.closeTime));
  let resetSideSeen = false;
  let resetSideSeenAt = null;
  let crossingCloseTime = null;
  let confirmationDeadlineAt = null;
  let confirmationCount = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const candle = rows[index];
    const closeTime = Number(candle?.closeTime);
    const close = Number(candle?.close);
    if (!Number.isFinite(closeTime) || closeTime <= readyAt || !(close > 0)) continue;

    if (!resetSideSeen && isOnEntryResetSide(setup, close)) {
      resetSideSeen = true;
      resetSideSeenAt = closeTime;
    }
    if (!resetSideSeen) continue;

    const flow = analyzeTakerFlowConfirmation(setup, rows.slice(0, index + 1), closeTime, {
      windowCandles,
      longMinimumBuyRatio,
      shortMaximumBuyRatio
    });
    if (!flow.valid) continue;

    if (crossingCloseTime != null && closeTime > confirmationDeadlineAt) {
      return { confirmed: false, reason: 'ST1_ORDERFLOW_CONFIRM_TIMEOUT' };
    }

    if (crossingCloseTime == null) {
      const crossingMustCloseAfter = Math.max(readyAt, Number(resetSideSeenAt || 0));
      if (!flow.freshCross || Number(flow.latestCloseTime) <= crossingMustCloseAfter) continue;
      crossingCloseTime = Number(flow.latestCloseTime);
      confirmationDeadlineAt = crossingCloseTime + (Number(confirmationTimeoutMinutes) * 60_000);
    }

    if (!flow.holdsBeyondTarget) {
      return { confirmed: false, reason: 'ST1_ORDERFLOW_FAKE_BREAKOUT_CLOSE_BACK' };
    }
    if (!isWithinEntryChaseLimit(setup, flow.latestClose, maxChaseT)) {
      return { confirmed: false, reason: 'ST1_ORDERFLOW_CLOSED_PRICE_CHASE_LIMIT' };
    }

    confirmationCount = flow.flowAligned ? confirmationCount + 1 : 0;
    if (confirmationCount < Number(requiredConfirmations)) continue;
    if (!hasCrossedEntryTarget(setup, flow.latestClose)) continue;

    return {
      confirmed: true,
      reason: 'ST1_HISTORICAL_ORDERFLOW_CONFIRMED',
      entryTime: Number(flow.latestCloseTime),
      entryPrice: Number(flow.latestClose),
      confirmationCount,
      crossingCloseTime,
      takerBuyRatio: Number(flow.takerBuyRatio),
      normalizedDelta: Number(flow.normalizedDelta)
    };
  }

  return {
    confirmed: false,
    reason: resetSideSeen ? 'ST1_ORDERFLOW_NO_CONFIRMED_CROSS' : 'ST1_ENTRY_RESET_SIDE_NOT_SEEN'
  };
}

const directionalMovePercent = (signal, entryPrice, price) => (
  signal === 'SELL'
    ? ((entryPrice - price) / entryPrice) * 100
    : ((price - entryPrice) / entryPrice) * 100
);

export function calculateForwardOutcomes({
  signal,
  entryTime,
  entryPrice,
  oneMinuteCandles,
  horizonsMinutes = [15, 30, 45, 60, 120, 240],
  roundTripCostPercent = 0.13,
  notionalUsdt = 50
}) {
  const rows = (Array.isArray(oneMinuteCandles) ? oneMinuteCandles : [])
    .filter((candle) => Number(candle?.closeTime) > Number(entryTime))
    .sort((left, right) => Number(left.closeTime) - Number(right.closeTime));
  const output = {};

  for (const horizon of horizonsMinutes) {
    const deadline = Number(entryTime) + (Number(horizon) * 60_000);
    const window = rows.filter((candle) => Number(candle.closeTime) <= deadline);
    const last = window.at(-1);
    const coverageRatio = window.length / Math.max(1, Number(horizon));
    if (!last || Number(last.closeTime) < deadline - MINUTE_MS || coverageRatio < 0.9) {
      output[horizon] = null;
      continue;
    }

    const favorablePrices = window.map((candle) => Number(signal === 'SELL' ? candle.low : candle.high));
    const adversePrices = window.map((candle) => Number(signal === 'SELL' ? candle.high : candle.low));
    const mfePercent = Math.max(0, ...favorablePrices.map((price) => directionalMovePercent(signal, entryPrice, price)));
    const maePercent = Math.min(0, ...adversePrices.map((price) => directionalMovePercent(signal, entryPrice, price)));
    const grossReturnPercent = directionalMovePercent(signal, entryPrice, Number(last.close));
    const netReturnPercent = grossReturnPercent - Number(roundTripCostPercent);

    output[horizon] = {
      observedMinutes: Math.max(0, (Number(last.closeTime) - Number(entryTime)) / 60_000),
      coverageRatio: round(coverageRatio),
      exitTime: Number(last.closeTime),
      exitPrice: Number(last.close),
      grossReturnPercent: round(grossReturnPercent),
      netReturnPercent: round(netReturnPercent),
      netPnlUsdt: round(Number(notionalUsdt) * (netReturnPercent / 100)),
      mfePercent: round(mfePercent),
      maePercent: round(maePercent)
    };
  }

  return output;
}

export function buildHistoricalReplayRecord({
  symbol,
  setup,
  confirmation,
  oneMinuteCandles,
  horizonsMinutes,
  roundTripCostPercent,
  notionalUsdt,
  candidateSettings = {}
}) {
  const candidates = classifySt1ShadowCandidates({
    signal: setup.signal,
    rsi: setup.rsi,
    takerBuyRatio: confirmation.takerBuyRatio,
    ...candidateSettings
  });
  return {
    symbol,
    signal: setup.signal,
    setupTime: Number(setup.setupCloseTime),
    evaluatedAt: Number(setup.evaluatedAt),
    entryTime: Number(confirmation.entryTime),
    entryPrice: Number(confirmation.entryPrice),
    rsi: round(setup.rsi),
    boxSize: round(setup.boxSize),
    targetPrice: round(setup.targetPrice),
    takerBuyRatio: round(confirmation.takerBuyRatio),
    normalizedDelta: round(confirmation.normalizedDelta),
    candidates,
    outcomes: calculateForwardOutcomes({
      signal: setup.signal,
      entryTime: confirmation.entryTime,
      entryPrice: confirmation.entryPrice,
      oneMinuteCandles,
      horizonsMinutes,
      roundTripCostPercent,
      notionalUsdt
    })
  };
}

export function summarizeReplayRecords(records, horizonMinutes = 240) {
  const usable = (Array.isArray(records) ? records : [])
    .filter((record) => record?.outcomes?.[horizonMinutes])
    .sort((left, right) => Number(left.entryTime) - Number(right.entryTime));
  const pnlValues = usable.map((record) => Number(record.outcomes[horizonMinutes].netPnlUsdt));
  const positive = pnlValues.filter((value) => value > 1e-12);
  const negative = pnlValues.filter((value) => value < -1e-12);
  const neutral = pnlValues.length - positive.length - negative.length;
  const grossProfit = positive.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(negative.reduce((sum, value) => sum + value, 0));
  const netPnlUsdt = pnlValues.reduce((sum, value) => sum + value, 0);
  const half = Math.floor(usable.length / 2);
  const firstHalfNet = pnlValues.slice(0, half).reduce((sum, value) => sum + value, 0);
  const secondHalfNet = pnlValues.slice(half).reduce((sum, value) => sum + value, 0);
  const bestTrade = pnlValues.length ? Math.max(...pnlValues) : 0;
  let running = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const value of pnlValues) {
    running += value;
    peak = Math.max(peak, running);
    maximumDrawdown = Math.max(maximumDrawdown, peak - running);
  }

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0);
  const bestTradeRemovedNet = netPnlUsdt - bestTrade;
  return {
    trades: usable.length,
    wins: positive.length,
    losses: negative.length,
    breakEven: neutral,
    winRatePercent: usable.length ? round((positive.length / usable.length) * 100, 4) : null,
    netPnlUsdt: round(netPnlUsdt),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 4) : 'INF',
    averageNetPnlUsdt: usable.length ? round(netPnlUsdt / usable.length) : null,
    medianNetPnlUsdt: round(median(pnlValues)),
    firstHalfNetPnlUsdt: round(firstHalfNet),
    secondHalfNetPnlUsdt: round(secondHalfNet),
    bestTradeUsdt: round(bestTrade),
    bestTradeRemovedNetPnlUsdt: round(bestTradeRemovedNet),
    maximumDrawdownUsdt: round(maximumDrawdown),
    promotionChecks: {
      minimumTrades30: usable.length >= 30,
      profitFactorAtLeast1_25: profitFactor >= 1.25,
      bothHalvesPositive: firstHalfNet > 0 && secondHalfNet > 0,
      bestTradeRemovedPositive: bestTradeRemovedNet > 0
    }
  };
}

export function createReplayCohortReport(records, {
  horizonMinutes = 240,
  splitTime = null
} = {}) {
  const groups = {
    baseline: () => true,
    longBaseline: (record) => record.signal === 'BUY',
    shortBaseline: (record) => record.signal === 'SELL',
    rsiNear: (record) => record.candidates?.rsiNear === true,
    longFlowBand: (record) => record.candidates?.longFlowBand === true,
    longRsiFlow: (record) => record.candidates?.longRsiFlow === true,
    shortRsiNear: (record) => record.signal === 'SELL' && record.candidates?.rsiNear === true
  };
  const summarizeGroups = (source) => Object.fromEntries(Object.entries(groups).map(([name, predicate]) => [
    name,
    summarizeReplayRecords(source.filter(predicate), horizonMinutes)
  ]));
  const report = { all: summarizeGroups(records) };

  if (Number.isFinite(Number(splitTime))) {
    report.development = summarizeGroups(records.filter((record) => Number(record.entryTime) < Number(splitTime)));
    report.outOfSample = summarizeGroups(records.filter((record) => Number(record.entryTime) >= Number(splitTime)));
  }
  return report;
}
