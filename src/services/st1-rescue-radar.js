const EPSILON = 1e-12;

export const RADAR_LEVEL = Object.freeze({
  NORMAL: 'NORMAL',
  YELLOW: 'YELLOW',
  ORANGE: 'ORANGE',
  RED: 'RED',
  RECOVERY: 'RECOVERY'
});

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function candleCloseTime(candle) {
  return finite(candle?.closeTime ?? candle?.close_time ?? candle?.closeTimestamp, 0);
}

function candleOpenTime(candle) {
  return finite(candle?.openTime ?? candle?.open_time ?? candle?.openTimestamp, 0);
}

function normalizeCandles(candles, now = Date.now()) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => ({
      ...candle,
      openTime: candleOpenTime(candle),
      closeTime: candleCloseTime(candle),
      open: finite(candle?.open),
      high: finite(candle?.high),
      low: finite(candle?.low),
      close: finite(candle?.close)
    }))
    .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .filter((candle) => !candle.closeTime || candle.closeTime <= now)
    .sort((left, right) => left.openTime - right.openTime);
}

export class St1RescueRadar {
  constructor(settings = {}) {
    this.settings = {
      enabled: settings.enabled !== false,
      protectLongs: settings.protectLongs !== false,
      protectShorts: settings.protectShorts !== false,
      supertrendPeriod: finite(settings.supertrendPeriod, 10),
      supertrendMultiplier: finite(settings.supertrendMultiplier, 3),
      emaFastPeriod: finite(settings.emaFastPeriod, 50),
      emaSlowPeriod: finite(settings.emaSlowPeriod, 200),
      bollingerPeriod: finite(settings.bollingerPeriod, 20),
      bollingerStdDev: finite(settings.bollingerStdDev, 2),
      st1BbTolerancePercent: finite(settings.st1BbTolerancePercent, 0.10),
      st1RecentMinutes: finite(settings.st1RecentMinutes, 20),
      yellowBtc5BbPercentB: finite(settings.yellowBtc5BbPercentB, 1.0),
      yellowBtc15Ema50DistancePercent: finite(settings.yellowBtc15Ema50DistancePercent, 1.50),
      orangeFastDrop5mPercent: finite(settings.orangeFastDrop5mPercent, -0.30),
      fastRedDrop5mPercent: finite(settings.fastRedDrop5mPercent, -0.45),
      fastRedMinPositions: finite(settings.fastRedMinPositions, 3),
      fastRedNegativeRatio: finite(settings.fastRedNegativeRatio, 0.70),
      fastRedPnlDelta3mUsdt: finite(settings.fastRedPnlDelta3mUsdt, -1.0),
      slowRedDrop10mPercent: finite(settings.slowRedDrop10mPercent, -0.30),
      slowRedMinPositions: finite(settings.slowRedMinPositions, 3),
      slowRedNegativeRatio: finite(settings.slowRedNegativeRatio, 2 / 3),
      slowRedBtc15Ema50MinDistancePercent: finite(settings.slowRedBtc15Ema50MinDistancePercent, 0.30),
      directionFlipMinPositions: finite(settings.directionFlipMinPositions, 3),
      directionFlipNegativeRatio: finite(settings.directionFlipNegativeRatio, 0.50),
      recoveryConfirmMs: finite(settings.recoveryConfirmMs, 180000),
      portfolioHistoryMs: finite(settings.portfolioHistoryMs, 15 * 60 * 1000)
    };

    this.level = RADAR_LEVEL.NORMAL;
    this.reason = 'RADAR_BOOT';
    this.lastEvaluation = null;
    this.portfolioHistory = []; // legacy LONG history alias
    this.portfolioHistoryBySide = { LONG: [], SHORT: [] };
    this.riskSide = null;
    this.recoveryActive = false;
    this.recoverySide = null;
    this.recoveryStartedAt = null;
    this.recoveryCandidateSince = null;
    this.lastRedAt = null;
    this.lastRedReason = null;
  }

  restore(state = {}) {
    if (!state || typeof state !== 'object') return false;
    this.recoveryActive = state.recoveryActive === true;
    this.recoveryStartedAt = finite(state.recoveryStartedAt, null);
    this.recoveryCandidateSince = finite(state.recoveryCandidateSince, null);
    this.lastRedAt = finite(state.lastRedAt, null);
    this.lastRedReason = state.lastRedReason || null;
    this.riskSide = ['LONG', 'SHORT'].includes(String(state.riskSide || '').toUpperCase())
      ? String(state.riskSide).toUpperCase()
      : null;
    // Backward compatibility: every pre-symmetric R41 recovery lock protected LONGs.
    this.recoverySide = ['LONG', 'SHORT'].includes(String(state.recoverySide || '').toUpperCase())
      ? String(state.recoverySide).toUpperCase()
      : (this.recoveryActive ? 'LONG' : null);
    if (this.recoveryActive) {
      this.riskSide = this.recoverySide;
      this.level = RADAR_LEVEL.RECOVERY;
      this.reason = 'RECOVERY_RESTORED';
    }
    return true;
  }

  serialize() {
    return {
      schema: 2,
      level: this.level,
      reason: this.reason,
      riskSide: this.riskSide,
      recoveryActive: this.recoveryActive,
      recoverySide: this.recoverySide,
      recoveryStartedAt: this.recoveryStartedAt,
      recoveryCandidateSince: this.recoveryCandidateSince,
      lastRedAt: this.lastRedAt,
      lastRedReason: this.lastRedReason,
      lastEvaluationAt: this.lastEvaluation?.at || null
    };
  }

  beginRecovery(now = Date.now(), reason = this.reason, side = this.riskSide || 'LONG') {
    const normalizedSide = String(side || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    this.recoveryActive = true;
    this.recoverySide = normalizedSide;
    this.riskSide = normalizedSide;
    this.recoveryStartedAt = now;
    this.recoveryCandidateSince = null;
    this.lastRedAt = now;
    this.lastRedReason = reason || 'RADAR_RED';
    this.level = RADAR_LEVEL.RECOVERY;
    this.reason = 'RED_EMERGENCY_EXIT_RECOVERY_LOCK';
  }

  forceRecovery(reason = 'MANUAL_RECOVERY_LOCK', now = Date.now(), side = this.riskSide || 'LONG') {
    this.beginRecovery(now, reason, side);
  }

  releaseRecovery(reason = 'RECOVERY_CONFIRMED') {
    this.recoveryActive = false;
    this.recoverySide = null;
    this.recoveryStartedAt = null;
    this.recoveryCandidateSince = null;
    this.riskSide = null;
    this.level = RADAR_LEVEL.NORMAL;
    this.reason = reason;
  }

  isEntryBlocked(signal = 'BUY') {
    if (!this.settings.enabled || this.level === RADAR_LEVEL.NORMAL) return false;
    const side = String(signal || '').toUpperCase() === 'SELL' ? 'SHORT' : 'LONG';
    if (side === 'LONG' && !this.settings.protectLongs) return false;
    if (side === 'SHORT' && !this.settings.protectShorts) return false;
    const protectedSide = this.recoveryActive ? this.recoverySide : this.riskSide;
    return protectedSide === side;
  }

  evaluate({ now = Date.now(), frames = {}, btcPrice = null, breadthState = null, managedLongs = [], managedShorts = [] } = {}) {
    if (!this.settings.enabled) {
      const disabled = {
        at: now,
        level: RADAR_LEVEL.NORMAL,
        reason: 'RADAR_DISABLED',
        riskSide: null,
        entryBlocked: false,
        blockedSignals: [],
        emergencyExit: false,
        metrics: {}
      };
      this.lastEvaluation = disabled;
      this.level = disabled.level;
      this.reason = disabled.reason;
      this.riskSide = null;
      return disabled;
    }

    const normalizedFrames = {};
    for (const interval of ['1m', '3m', '5m', '15m']) {
      normalizedFrames[interval] = normalizeCandles(frames?.[interval], now);
    }

    const price = finite(btcPrice, normalizedFrames['1m'].at(-1)?.close);
    const metrics = this.buildMetrics({
      now,
      frames: normalizedFrames,
      btcPrice: price,
      breadthState,
      managedLongs,
      managedShorts
    });

    this.trackPortfolio(now, metrics.longPortfolioPnlUsdt, metrics.managedLongCount, 'LONG');
    this.trackPortfolio(now, metrics.shortPortfolioPnlUsdt, metrics.managedShortCount, 'SHORT');
    metrics.longPortfolioPnlDelta3mUsdt = this.resolvePortfolioDelta(now, 3 * 60 * 1000, metrics.longPortfolioPnlUsdt, 'LONG');
    metrics.shortPortfolioPnlDelta3mUsdt = this.resolvePortfolioDelta(now, 3 * 60 * 1000, metrics.shortPortfolioPnlUsdt, 'SHORT');
    // Preserve legacy LONG fields for existing diagnostics/tests.
    metrics.portfolioPnlUsdt = metrics.longPortfolioPnlUsdt;
    metrics.portfolioPnlDelta3mUsdt = metrics.longPortfolioPnlDelta3mUsdt;
    metrics.negativeRatio = metrics.negativeLongRatio;

    let decision;
    if (this.recoveryActive) {
      decision = this.evaluateRecovery(now, metrics, this.recoverySide || 'LONG');
    } else {
      decision = this.decide(metrics);
    }

    this.level = decision.level;
    this.reason = decision.reason;
    this.riskSide = decision.riskSide || null;
    if (decision.level === RADAR_LEVEL.RED) {
      this.lastRedAt = now;
      this.lastRedReason = decision.reason;
    }

    const blockedSignals = [];
    if (this.isEntryBlocked('BUY')) blockedSignals.push('BUY');
    if (this.isEntryBlocked('SELL')) blockedSignals.push('SELL');
    const result = {
      at: now,
      ...decision,
      riskSide: this.riskSide,
      entryBlocked: blockedSignals.length > 0,
      blockedSignals,
      emergencyExit: decision.level === RADAR_LEVEL.RED,
      metrics
    };
    this.lastEvaluation = result;
    return result;
  }

  buildMetrics({ now, frames, btcPrice, breadthState, managedLongs, managedShorts }) {
    const indicators = {};
    for (const interval of ['1m', '3m', '5m', '15m']) {
      indicators[interval] = this.analyzeFrame(frames[interval], btcPrice);
    }

    const validLongs = (Array.isArray(managedLongs) ? managedLongs : [])
      .filter((position) => position && String(position.side || position.signal || '').toUpperCase() === 'BUY');
    const validShorts = (Array.isArray(managedShorts) ? managedShorts : [])
      .filter((position) => position && String(position.side || position.signal || '').toUpperCase() === 'SELL');

    const summarize = (positions) => {
      const pnlValues = positions
        .map((position) => finite(position.unrealizedProfit ?? position.unrealizedPnl, null))
        .filter(Number.isFinite);
      const pnl = pnlValues.reduce((sum, value) => sum + value, 0);
      const negativeCount = pnlValues.filter((value) => value < 0).length;
      const count = positions.length;
      return { pnl, negativeCount, count, negativeRatio: count > 0 ? negativeCount / count : 0 };
    };
    const longStats = summarize(validLongs);
    const shortStats = summarize(validShorts);

    const st1Short3m = this.detectRecentRawSt1Short(frames['3m'], now);
    const st1Short5m = this.detectRecentRawSt1Short(frames['5m'], now);
    const st1Long3m = this.detectRecentRawSt1Long(frames['3m'], now);
    const st1Long5m = this.detectRecentRawSt1Long(frames['5m'], now);

    return {
      btcPrice,
      breadthState: String(breadthState || 'MISSING').toUpperCase(),
      btc1Supertrend: indicators['1m'].supertrend,
      btc3Supertrend: indicators['3m'].supertrend,
      btc5Supertrend: indicators['5m'].supertrend,
      btc15Supertrend: indicators['15m'].supertrend,
      btc1CloseVsEma50Percent: indicators['1m'].closeVsEma50Percent,
      btc3CloseVsEma50Percent: indicators['3m'].closeVsEma50Percent,
      btc5CloseVsEma50Percent: indicators['5m'].closeVsEma50Percent,
      btc15CloseVsEma50Percent: indicators['15m'].closeVsEma50Percent,
      btc5BbPercentB: indicators['5m'].bbPercentB,
      btc15BbPercentB: indicators['15m'].bbPercentB,
      btcReturn5mPercent: this.calculateReturnPercent(frames['1m'], btcPrice, now - 5 * 60 * 1000),
      btcReturn10mPercent: this.calculateReturnPercent(frames['1m'], btcPrice, now - 10 * 60 * 1000),
      btc3RawSt1Short: Boolean(st1Short3m),
      btc5RawSt1Short: Boolean(st1Short5m),
      btc3RawSt1ShortEvent: st1Short3m,
      btc5RawSt1ShortEvent: st1Short5m,
      btc3RawSt1Long: Boolean(st1Long3m),
      btc5RawSt1Long: Boolean(st1Long5m),
      btc3RawSt1LongEvent: st1Long3m,
      btc5RawSt1LongEvent: st1Long5m,
      managedLongCount: longStats.count,
      negativeLongCount: longStats.negativeCount,
      negativeLongRatio: longStats.negativeRatio,
      longPortfolioPnlUsdt: longStats.pnl,
      longPortfolioPnlDelta3mUsdt: null,
      managedShortCount: shortStats.count,
      negativeShortCount: shortStats.negativeCount,
      negativeShortRatio: shortStats.negativeRatio,
      shortPortfolioPnlUsdt: shortStats.pnl,
      shortPortfolioPnlDelta3mUsdt: null,
      // Legacy LONG aliases retained.
      negativeRatio: longStats.negativeRatio,
      portfolioPnlUsdt: longStats.pnl,
      portfolioPnlDelta3mUsdt: null
    };
  }

  decide(metrics) {
    const severity = {
      [RADAR_LEVEL.NORMAL]: 0,
      [RADAR_LEVEL.YELLOW]: 1,
      [RADAR_LEVEL.ORANGE]: 2,
      [RADAR_LEVEL.RED]: 3
    };
    const longDecision = this.settings.protectLongs
      ? this.decideForSide(metrics, 'LONG')
      : { level: RADAR_LEVEL.NORMAL, reason: 'LONG_RADAR_DISABLED', riskSide: null };
    const shortDecision = this.settings.protectShorts
      ? this.decideForSide(metrics, 'SHORT')
      : { level: RADAR_LEVEL.NORMAL, reason: 'SHORT_RADAR_DISABLED', riskSide: null };

    const longRank = severity[longDecision.level] ?? 0;
    const shortRank = severity[shortDecision.level] ?? 0;
    if (longRank > shortRank) return longDecision;
    if (shortRank > longRank) return shortDecision;
    if (longRank === 0) return { level: RADAR_LEVEL.NORMAL, reason: 'RADAR_CLEAR', riskSide: null };

    // On an equal severity choose the side with the live portfolio first; then the worse PnL.
    const longCount = finite(metrics.managedLongCount, 0);
    const shortCount = finite(metrics.managedShortCount, 0);
    if (longCount > 0 && shortCount === 0) return longDecision;
    if (shortCount > 0 && longCount === 0) return shortDecision;
    const longPnl = finite(metrics.longPortfolioPnlUsdt ?? metrics.portfolioPnlUsdt, 0);
    const shortPnl = finite(metrics.shortPortfolioPnlUsdt, 0);
    return shortPnl < longPnl ? shortDecision : longDecision;
  }

  decideForSide(metrics, side = 'LONG') {
    const s = this.settings;
    const isLongRisk = side === 'LONG';
    const favorableTrend = isLongRisk ? 'UP' : 'DOWN';
    const adverseTrend = isLongRisk ? 'DOWN' : 'UP';
    const count = finite(isLongRisk ? metrics.managedLongCount : metrics.managedShortCount, 0);
    const negativeRatio = finite(
      isLongRisk ? (metrics.negativeLongRatio ?? metrics.negativeRatio) : metrics.negativeShortRatio,
      0
    );
    const portfolioPnl = finite(
      isLongRisk ? (metrics.longPortfolioPnlUsdt ?? metrics.portfolioPnlUsdt) : metrics.shortPortfolioPnlUsdt,
      0
    );
    const pnlDelta3m = finite(
      isLongRisk ? (metrics.longPortfolioPnlDelta3mUsdt ?? metrics.portfolioPnlDelta3mUsdt) : metrics.shortPortfolioPnlDelta3mUsdt,
      0
    );
    const return5m = finite(metrics.btcReturn5mPercent, 0);
    const return10m = finite(metrics.btcReturn10mPercent, 0);
    const ema15Distance = finite(metrics.btc15CloseVsEma50Percent, 0);
    const hasPortfolio = count >= 1;
    const adverseFastRed = isLongRisk
      ? return5m <= s.fastRedDrop5mPercent
      : return5m >= Math.abs(s.fastRedDrop5mPercent);

    const fastRed = metrics.btc15Supertrend === favorableTrend
      && metrics.btc1Supertrend === adverseTrend
      && count >= s.fastRedMinPositions
      && adverseFastRed
      && negativeRatio + EPSILON >= s.fastRedNegativeRatio
      && pnlDelta3m <= s.fastRedPnlDelta3mUsdt;
    if (fastRed) {
      return {
        level: RADAR_LEVEL.RED,
        reason: isLongRisk ? 'FAST_BTC_SHOCK_RED' : 'FAST_BTC_SHORT_SQUEEZE_RED',
        riskSide: side
      };
    }

    const adverseSlowReturn = isLongRisk
      ? return10m <= s.slowRedDrop10mPercent
      : return10m >= Math.abs(s.slowRedDrop10mPercent);
    const emaStructureReady = isLongRisk
      ? ema15Distance >= s.slowRedBtc15Ema50MinDistancePercent
      : ema15Distance <= -Math.abs(s.slowRedBtc15Ema50MinDistancePercent);
    const slowRed = metrics.btc15Supertrend === favorableTrend
      && metrics.btc1Supertrend === adverseTrend
      && metrics.btc3Supertrend === adverseTrend
      && metrics.btc5Supertrend === adverseTrend
      && count >= s.slowRedMinPositions
      && adverseSlowReturn
      && emaStructureReady
      && negativeRatio + EPSILON >= s.slowRedNegativeRatio
      && portfolioPnl < 0;
    if (slowRed) {
      return {
        level: RADAR_LEVEL.RED,
        reason: isLongRisk ? 'STRUCTURAL_BTC_BREAKDOWN_RED' : 'STRUCTURAL_BTC_BREAKOUT_RED',
        riskSide: side
      };
    }

    const directionFlipRed = hasPortfolio
      && metrics.btc15Supertrend === adverseTrend
      && count >= s.directionFlipMinPositions
      && negativeRatio + EPSILON >= s.directionFlipNegativeRatio
      && portfolioPnl < 0;
    if (directionFlipRed) {
      return {
        level: RADAR_LEVEL.RED,
        reason: isLongRisk ? 'BTC15_DIRECTION_FLIP_RED' : 'BTC15_DIRECTION_FLIP_RED_SHORT',
        riskSide: side
      };
    }

    const stretched5m = Number.isFinite(metrics.btc5BbPercentB) && (
      isLongRisk
        ? metrics.btc5BbPercentB > s.yellowBtc5BbPercentB
        : metrics.btc5BbPercentB < (1 - s.yellowBtc5BbPercentB)
    );
    const stretched15m = Number.isFinite(metrics.btc15CloseVsEma50Percent) && (
      isLongRisk
        ? metrics.btc15CloseVsEma50Percent > s.yellowBtc15Ema50DistancePercent
        : metrics.btc15CloseVsEma50Percent < -Math.abs(s.yellowBtc15Ema50DistancePercent)
    );
    const breadthOpposed = metrics.breadthState === (isLongRisk ? 'DOWN' : 'UP');
    const multiTfDeterioration = metrics.btc1Supertrend === adverseTrend && metrics.btc3Supertrend === adverseTrend;
    const dualReverseSt1 = isLongRisk
      ? metrics.btc3RawSt1Short && metrics.btc5RawSt1Short
      : metrics.btc3RawSt1Long && metrics.btc5RawSt1Long;
    const reverseSt1Confirmed = dualReverseSt1 && (
      metrics.btc1Supertrend === adverseTrend
      || stretched5m
      || stretched15m
      || (Number.isFinite(metrics.btcReturn5mPercent) && (
        isLongRisk ? metrics.btcReturn5mPercent <= -0.15 : metrics.btcReturn5mPercent >= 0.15
      ))
    );
    const fastMoveOrange = Number.isFinite(metrics.btcReturn5mPercent) && (
      isLongRisk
        ? metrics.btcReturn5mPercent <= s.orangeFastDrop5mPercent
        : metrics.btcReturn5mPercent >= Math.abs(s.orangeFastDrop5mPercent)
    );
    if (breadthOpposed || multiTfDeterioration || reverseSt1Confirmed || fastMoveOrange) {
      const reasons = [];
      if (breadthOpposed) reasons.push(isLongRisk ? 'BREADTH_DOWN' : 'BREADTH_UP');
      if (multiTfDeterioration) reasons.push(isLongRisk ? 'BTC_1M_3M_ST_DOWN' : 'BTC_1M_3M_ST_UP');
      if (reverseSt1Confirmed) reasons.push(isLongRisk ? 'BTC_3M_5M_RAW_ST1_SHORT_CONFIRMED' : 'BTC_3M_5M_RAW_ST1_LONG_CONFIRMED');
      if (fastMoveOrange) reasons.push(isLongRisk ? 'BTC_FAST_DROP' : 'BTC_FAST_RISE');
      return { level: RADAR_LEVEL.ORANGE, reason: `ORANGE:${reasons.join('+')}`, riskSide: side };
    }

    if (stretched5m || stretched15m) {
      const reasons = [];
      if (stretched5m) reasons.push(isLongRisk ? 'BTC5_ABOVE_UPPER_BB' : 'BTC5_BELOW_LOWER_BB');
      if (stretched15m) reasons.push(isLongRisk ? 'BTC15_EMA50_OVEREXTENSION' : 'BTC15_EMA50_UNDEREXTENSION');
      return { level: RADAR_LEVEL.YELLOW, reason: `YELLOW:${reasons.join('+')}`, riskSide: side };
    }

    return { level: RADAR_LEVEL.NORMAL, reason: 'RADAR_CLEAR', riskSide: null };
  }

  evaluateRecovery(now, metrics, side = 'LONG') {
    const isLongRisk = side !== 'SHORT';
    const healthyTrend = isLongRisk ? 'UP' : 'DOWN';
    const healthyBreadth = isLongRisk ? 'UP' : 'DOWN';
    const healthyEma = (value) => Number.isFinite(value) && (isLongRisk ? value > 0 : value < 0);
    const healthyReturn = Number.isFinite(metrics.btcReturn5mPercent)
      && (isLongRisk ? metrics.btcReturn5mPercent > 0 : metrics.btcReturn5mPercent < 0);
    const recoveryHealthy = metrics.btc15Supertrend === healthyTrend
      && metrics.breadthState === healthyBreadth
      && metrics.btc1Supertrend === healthyTrend
      && healthyEma(metrics.btc1CloseVsEma50Percent)
      && healthyEma(metrics.btc3CloseVsEma50Percent)
      && healthyReturn;

    if (!recoveryHealthy) {
      this.recoveryCandidateSince = null;
      return { level: RADAR_LEVEL.RECOVERY, reason: 'RECOVERY_WAITING_FOR_MARKET_HEALTH', riskSide: side };
    }

    if (!this.recoveryCandidateSince) {
      this.recoveryCandidateSince = now;
      return { level: RADAR_LEVEL.RECOVERY, reason: 'RECOVERY_CONFIRMATION_STARTED', riskSide: side };
    }

    if ((now - this.recoveryCandidateSince) >= this.settings.recoveryConfirmMs) {
      this.releaseRecovery('RECOVERY_CONFIRMED');
      return { level: RADAR_LEVEL.NORMAL, reason: 'RECOVERY_CONFIRMED', riskSide: null };
    }

    return { level: RADAR_LEVEL.RECOVERY, reason: 'RECOVERY_CONFIRMATION_COUNTING', riskSide: side };
  }

  analyzeFrame(candles, currentPrice) {
    const rows = normalizeCandles(candles);
    if (rows.length === 0) {
      return {
        supertrend: null,
        ema50: null,
        ema200: null,
        closeVsEma50Percent: null,
        bbPercentB: null
      };
    }
    const price = finite(currentPrice, rows.at(-1)?.close);
    const ema50 = this.calculateEMA(rows, this.settings.emaFastPeriod);
    const ema200 = this.calculateEMA(rows, this.settings.emaSlowPeriod);
    const st = this.calculateSupertrend(rows, this.settings.supertrendPeriod, this.settings.supertrendMultiplier);
    const bb = this.calculateBollinger(rows, this.settings.bollingerPeriod, this.settings.bollingerStdDev);
    const closeVsEma50Percent = Number.isFinite(ema50) && ema50 !== 0 && Number.isFinite(price)
      ? ((price - ema50) / ema50) * 100
      : null;
    const bbPercentB = bb && Number.isFinite(price) && Math.abs(bb.upper - bb.lower) > EPSILON
      ? (price - bb.lower) / (bb.upper - bb.lower)
      : null;
    return {
      supertrend: st?.direction || null,
      supertrendValue: st?.value ?? null,
      ema50,
      ema200,
      closeVsEma50Percent,
      bbPercentB,
      bb
    };
  }

  calculateEMA(candles, period) {
    const closes = normalizeCandles(candles).map((candle) => Number(candle.close));
    if (closes.length < period || period < 2) return null;
    const multiplier = 2 / (period + 1);
    let ema = closes[0];
    for (let index = 1; index < closes.length; index += 1) {
      ema = ((closes[index] - ema) * multiplier) + ema;
    }
    return ema;
  }

  calculateBollinger(candles, period = 20, stdDev = 2) {
    const rows = normalizeCandles(candles);
    if (rows.length < period) return null;
    const prices = rows.slice(-period).map((candle) => Number(candle.close));
    const middle = prices.reduce((sum, value) => sum + value, 0) / prices.length;
    const variance = prices.reduce((sum, value) => sum + ((value - middle) ** 2), 0) / prices.length;
    const std = Math.sqrt(variance);
    return {
      middle,
      upper: middle + (stdDev * std),
      lower: middle - (stdDev * std)
    };
  }

  calculateSupertrend(candles, period = 10, multiplier = 3) {
    const rows = normalizeCandles(candles);
    if (rows.length < period + 2) return null;
    const tr = rows.map((candle, index) => {
      if (index === 0) return candle.high - candle.low;
      const previousClose = rows[index - 1].close;
      return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
    });
    const atr = Array(rows.length).fill(null);
    atr[period - 1] = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    for (let index = period; index < rows.length; index += 1) {
      atr[index] = ((atr[index - 1] * (period - 1)) + tr[index]) / period;
    }

    const upper = Array(rows.length).fill(null);
    const lower = Array(rows.length).fill(null);
    const supertrend = Array(rows.length).fill(null);
    const direction = Array(rows.length).fill(null);
    for (let index = period - 1; index < rows.length; index += 1) {
      const hl2 = (rows[index].high + rows[index].low) / 2;
      const basicUpper = hl2 + (multiplier * atr[index]);
      const basicLower = hl2 - (multiplier * atr[index]);
      if (index === period - 1) {
        upper[index] = basicUpper;
        lower[index] = basicLower;
        supertrend[index] = upper[index];
        direction[index] = 'DOWN';
        continue;
      }
      upper[index] = (basicUpper < upper[index - 1] || rows[index - 1].close > upper[index - 1])
        ? basicUpper : upper[index - 1];
      lower[index] = (basicLower > lower[index - 1] || rows[index - 1].close < lower[index - 1])
        ? basicLower : lower[index - 1];
      const previousWasUpper = Math.abs(supertrend[index - 1] - upper[index - 1]) <= EPSILON;
      direction[index] = previousWasUpper
        ? (rows[index].close > upper[index] ? 'UP' : 'DOWN')
        : (rows[index].close < lower[index] ? 'DOWN' : 'UP');
      supertrend[index] = direction[index] === 'UP' ? lower[index] : upper[index];
    }
    const last = rows.length - 1;
    return { direction: direction[last], value: supertrend[last], close: rows[last].close };
  }

  detectRecentRawSt1Short(candles, now = Date.now()) {
    const rows = normalizeCandles(candles, now);
    const period = this.settings.bollingerPeriod;
    if (rows.length < period + 3) return null;
    const recentCutoff = now - (this.settings.st1RecentMinutes * 60 * 1000);
    let latest = null;

    for (let setupIndex = period - 1; setupIndex <= rows.length - 3; setupIndex += 1) {
      const setup = rows[setupIndex];
      const confirm = rows[setupIndex + 1];
      if (!(setup.close > setup.open) || !(confirm.close < confirm.open)) continue;

      const bb = this.calculateBollinger(rows.slice(0, setupIndex + 1), period, this.settings.bollingerStdDev);
      if (!bb) continue;
      const tolerance = Math.abs(bb.upper) * (this.settings.st1BbTolerancePercent / 100);
      const touchesUpper = setup.high + tolerance >= bb.upper;
      if (!touchesUpper) continue;

      const setupBodyBottom = Math.min(setup.open, setup.close);
      for (let windowBar = 1; windowBar <= 3; windowBar += 1) {
        const triggerIndex = setupIndex + 1 + windowBar;
        const trigger = rows[triggerIndex];
        if (!trigger) break;
        if (trigger.low <= setupBodyBottom + EPSILON) {
          const triggerTs = trigger.openTime || trigger.closeTime || 0;
          if (triggerTs >= recentCutoff && (!latest || triggerTs > latest.triggerTs)) {
            latest = {
              setupTime: setup.openTime,
              confirmTime: confirm.openTime,
              triggerTime: trigger.openTime,
              triggerTs,
              triggerBar: windowBar,
              setupBodyBottom,
              setupBbUpper: bb.upper
            };
          }
          break;
        }
      }
    }
    return latest;
  }

  detectRecentRawSt1Long(candles, now = Date.now()) {
    const rows = normalizeCandles(candles, now);
    const period = this.settings.bollingerPeriod;
    if (rows.length < period + 3) return null;
    const recentCutoff = now - (this.settings.st1RecentMinutes * 60 * 1000);
    let latest = null;

    for (let setupIndex = period - 1; setupIndex <= rows.length - 3; setupIndex += 1) {
      const setup = rows[setupIndex];
      const confirm = rows[setupIndex + 1];
      // LONG mirror: red setup at lower BB -> green confirmation -> setup BODY TOP break in W1/W2/W3.
      if (!(setup.close < setup.open) || !(confirm.close > confirm.open)) continue;

      const bb = this.calculateBollinger(rows.slice(0, setupIndex + 1), period, this.settings.bollingerStdDev);
      if (!bb) continue;
      const tolerance = Math.abs(bb.lower) * (this.settings.st1BbTolerancePercent / 100);
      const touchesLower = setup.low - tolerance <= bb.lower;
      if (!touchesLower) continue;

      const setupBodyTop = Math.max(setup.open, setup.close);
      for (let windowBar = 1; windowBar <= 3; windowBar += 1) {
        const triggerIndex = setupIndex + 1 + windowBar;
        const trigger = rows[triggerIndex];
        if (!trigger) break;
        if (trigger.high + EPSILON >= setupBodyTop) {
          const triggerTs = trigger.openTime || trigger.closeTime || 0;
          if (triggerTs >= recentCutoff && (!latest || triggerTs > latest.triggerTs)) {
            latest = {
              setupTime: setup.openTime,
              confirmTime: confirm.openTime,
              triggerTime: trigger.openTime,
              triggerTs,
              triggerBar: windowBar,
              setupBodyTop,
              setupBbLower: bb.lower
            };
          }
          break;
        }
      }
    }
    return latest;
  }

  calculateReturnPercent(candles, currentPrice, targetTime) {
    const rows = normalizeCandles(candles);
    const price = finite(currentPrice, rows.at(-1)?.close);
    if (!Number.isFinite(price) || rows.length === 0) return null;
    let reference = null;
    for (const candle of rows) {
      const time = candle.closeTime || candle.openTime;
      if (time <= targetTime) reference = candle;
      else break;
    }
    if (!reference || !Number.isFinite(reference.close) || Math.abs(reference.close) <= EPSILON) return null;
    return ((price - reference.close) / reference.close) * 100;
  }

  trackPortfolio(now, pnl, count, side = 'LONG') {
    const normalizedSide = side === 'SHORT' ? 'SHORT' : 'LONG';
    const history = this.portfolioHistoryBySide[normalizedSide] || [];
    history.push({ at: now, pnl: finite(pnl, 0), count: finite(count, 0) });
    const cutoff = now - this.settings.portfolioHistoryMs;
    this.portfolioHistoryBySide[normalizedSide] = history.filter((item) => item.at >= cutoff);
    if (normalizedSide === 'LONG') this.portfolioHistory = this.portfolioHistoryBySide.LONG;
  }

  resolvePortfolioDelta(now, windowMs, currentPnl, side = 'LONG') {
    const normalizedSide = side === 'SHORT' ? 'SHORT' : 'LONG';
    const history = this.portfolioHistoryBySide[normalizedSide] || [];
    const target = now - windowMs;
    let reference = null;
    for (const item of history) {
      if (item.at <= target) reference = item;
      else break;
    }
    if (!reference) return null;
    return finite(currentPnl, 0) - finite(reference.pnl, 0);
  }
}

export default St1RescueRadar;
