import {
  classifySt1ShadowCandidates,
  createDeterministicConfigHash,
  createSt1ScientificShadow,
  resolveShadowRegime,
  summarizeShadowBreadth,
  updateSt1ScientificShadow
} from '../../src/research/st1-scientific-shadow.js';

const settings = {
  labVersion: 'ST1-R43.2-SCIENTIFIC-SHADOW',
  rsiOversold: 30,
  rsiOverbought: 70,
  rsiProximityPoints: 2,
  longFlowMinimum: 0.58,
  longFlowMaximum: 0.72,
  earlyLockTriggerPercent: 0.30,
  commissionRate: 0.0004,
  estimatedSlippagePercent: 0.05,
  costBufferPercent: 0.03,
  staleMinutes: 240,
  staleMaxMfePercent: 0.30,
  atrTrailingMultipliers: [1.25, 1.75, 2.25]
};

describe('ST1 R43.2 scientific shadow lab', () => {
  test('classifies post-hoc cohorts without granting execution authority', () => {
    expect(classifySt1ShadowCandidates({ signal: 'BUY', rsi: 29, takerBuyRatio: 0.64 }))
      .toEqual({
        baseline: true,
        rsiNear: true,
        longFlowBand: true,
        longRsiFlow: true,
        shortObservationOnly: false
      });
    expect(classifySt1ShadowCandidates({ signal: 'SELL', rsi: 71, takerBuyRatio: 0.39 }))
      .toMatchObject({ baseline: true, rsiNear: true, shortObservationOnly: true });

    const shadow = createSt1ScientificShadow({
      signal: 'BUY', entryPrice: 100, enteredAt: 1, rsi: 29, takerBuyRatio: 0.64, settings
    });
    expect(shadow.executionAuthority).toBe('OBSERVE_ONLY');
    expect(shadow.exitExperiments.regimeAtrTrailing.status).toBe('OBSERVATION_ONLY');
  });

  test('creates an order-independent config identity', () => {
    expect(createDeterministicConfigHash({ a: 1, b: { c: 2 } }))
      .toBe(createDeterministicConfigHash({ b: { c: 2 }, a: 1 }));
    expect(createDeterministicConfigHash({ a: 1 }))
      .not.toBe(createDeterministicConfigHash({ a: 2 }));
  });

  test('reports regime candidates but never an active instruction', () => {
    expect(resolveShadowRegime('BUY', { btcTrend: 'UP', ethTrend: 'UP' }))
      .toMatchObject({ classification: 'STRONG', recommendedAtrTrailingMultiplier: 2.25, observationOnly: true });
    expect(resolveShadowRegime('SELL', { btcTrend: 'UP', ethTrend: 'UP' }))
      .toMatchObject({ classification: 'WEAK', recommendedAtrTrailingMultiplier: 1.25, observationOnly: true });
  });

  test('records early cost-safe and stale virtual exits without touching real orders', () => {
    const shadow = createSt1ScientificShadow({
      signal: 'BUY', entryPrice: 100, enteredAt: 1_000, rsi: 29, takerBuyRatio: 0.64, settings
    });
    const activated = updateSt1ScientificShadow(shadow, {
      signal: 'BUY', entryPrice: 100, currentPrice: 100.31, enteredAt: 1_000, now: 2_000
    });
    expect(activated.changed).toBe(true);
    expect(activated.shadow.exitExperiments.earlyCostSafe.status).toBe('ACTIVE');

    const closed = updateSt1ScientificShadow(activated.shadow, {
      signal: 'BUY', entryPrice: 100, currentPrice: 100.10, enteredAt: 1_000, now: 3_000
    });
    expect(closed.shadow.exitExperiments.earlyCostSafe.status).toBe('VIRTUAL_CLOSED');
    expect(closed.shadow.exitExperiments.earlyCostSafe.virtualExitPrice).toBeCloseTo(100.16, 8);
    expect(closed.shadow.exitExperiments.earlyCostSafe.virtualNetPercent).toBeCloseTo(0, 8);

    const stale = createSt1ScientificShadow({
      signal: 'BUY', entryPrice: 100, enteredAt: 0, rsi: 25, takerBuyRatio: 0.8, settings
    });
    const staleResult = updateSt1ScientificShadow(stale, {
      signal: 'BUY', entryPrice: 100, currentPrice: 99.9, enteredAt: 0, now: 240 * 60_000
    });
    expect(staleResult.shadow.exitExperiments.staleTrade.status).toBe('VIRTUAL_CLOSED');
  });

  test('summarizes cached scan candles into weighted shadow breadth', () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      returnPercent: index < 21 ? 0.2 : -0.2,
      quoteVolume: 100
    }));
    expect(summarizeShadowBreadth(rows, 123, { interval: '15m' }))
      .toMatchObject({ calculatedAt: 123, interval: '15m', state: 'UP', validRows: 30 });
  });
});
