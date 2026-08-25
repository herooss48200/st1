import { St1RescueRadar, RADAR_LEVEL } from '../../src/services/st1-rescue-radar.js';

describe('ST1 Rescue Radar', () => {
  test('LONG fast shock becomes RED only with a losing portfolio', () => {
    const radar = new St1RescueRadar();
    const decision = radar.decide({
      btc15Supertrend: 'UP', btc1Supertrend: 'DOWN', btc3Supertrend: 'UP', btc5Supertrend: 'UP',
      btcReturn5mPercent: -0.56, btcReturn10mPercent: -0.40, btc15CloseVsEma50Percent: 1.41,
      btc5BbPercentB: 0.9, breadthState: 'UP', btc3RawSt1Short: false, btc5RawSt1Short: false,
      managedLongCount: 4, negativeLongRatio: 0.75, longPortfolioPnlUsdt: -1.2, longPortfolioPnlDelta3mUsdt: -1.4,
      managedShortCount: 0, negativeShortRatio: 0, shortPortfolioPnlUsdt: 0, shortPortfolioPnlDelta3mUsdt: 0
    });
    expect(decision).toEqual({ level: RADAR_LEVEL.RED, reason: 'FAST_BTC_SHOCK_RED', riskSide: 'LONG' });
  });

  test('SHORT mirror fast squeeze becomes RED', () => {
    const radar = new St1RescueRadar();
    const decision = radar.decide({
      btc15Supertrend: 'DOWN', btc1Supertrend: 'UP', btc3Supertrend: 'DOWN', btc5Supertrend: 'DOWN',
      btcReturn5mPercent: 0.60, btcReturn10mPercent: 0.40, btc15CloseVsEma50Percent: -1.2,
      btc5BbPercentB: 0.1, breadthState: 'DOWN', btc3RawSt1Long: false, btc5RawSt1Long: false,
      managedLongCount: 0, negativeLongRatio: 0, longPortfolioPnlUsdt: 0, longPortfolioPnlDelta3mUsdt: 0,
      managedShortCount: 4, negativeShortRatio: 0.75, shortPortfolioPnlUsdt: -1.2, shortPortfolioPnlDelta3mUsdt: -1.4
    });
    expect(decision).toEqual({ level: RADAR_LEVEL.RED, reason: 'FAST_BTC_SHORT_SQUEEZE_RED', riskSide: 'SHORT' });
  });

  test('1.50% BTC15 price-to-EMA50 stretch is YELLOW only', () => {
    const radar = new St1RescueRadar({ yellowBtc15Ema50DistancePercent: 1.50 });
    const decision = radar.decideForSide({
      btc15Supertrend: 'UP', btc1Supertrend: 'UP', btc3Supertrend: 'UP', btc5Supertrend: 'UP',
      btcReturn5mPercent: 0.1, btcReturn10mPercent: 0.2, btc15CloseVsEma50Percent: 1.60,
      btc5BbPercentB: 0.8, breadthState: 'UP', btc3RawSt1Short: false, btc5RawSt1Short: false,
      managedLongCount: 2, negativeLongRatio: 0, longPortfolioPnlUsdt: 0.3, longPortfolioPnlDelta3mUsdt: 0
    }, 'LONG');
    expect(decision.level).toBe(RADAR_LEVEL.YELLOW);
    expect(decision.reason).toContain('BTC15_EMA50_OVEREXTENSION');
  });

  test('recovery keeps same side blocked until 3 minutes of health', () => {
    const radar = new St1RescueRadar({ recoveryConfirmMs: 180000 });
    radar.beginRecovery(1000, 'TEST', 'LONG');
    expect(radar.recoveryActive).toBe(true);
    expect(radar.isEntryBlocked('BUY')).toBe(true);
    const healthy = { btc15Supertrend: 'UP', breadthState: 'UP', btc1Supertrend: 'UP', btc1CloseVsEma50Percent: 0.1, btc3CloseVsEma50Percent: 0.1, btcReturn5mPercent: 0.1 };
    expect(radar.evaluateRecovery(2000, healthy, 'LONG').level).toBe(RADAR_LEVEL.RECOVERY);
    expect(radar.evaluateRecovery(182001, healthy, 'LONG').level).toBe(RADAR_LEVEL.NORMAL);
  });
});
