import {
  ST1_R433_ENTRY_POLICY,
  evaluateSt1R433EntryGate,
  evaluateSt1R433SetupGate
} from '../../src/engines/st1-r433-entry-gate.js';

describe('ST1 R43.3 replay-confirmed PAPER entry gate', () => {
  test('accepts LONG only inside RSI [28,30) and taker ratio [0.58,0.72]', () => {
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 28, takerBuyRatio: 0.58 }))
      .toMatchObject({ allowed: true, policy: ST1_R433_ENTRY_POLICY });
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 29.999, takerBuyRatio: 0.72 }))
      .toMatchObject({ allowed: true });
  });

  test('rejects deep LONG RSI and excessive taker buying', () => {
    expect(evaluateSt1R433SetupGate({ signal: 'BUY', rsi: 27.999 }).reason)
      .toBe('ST1_R433_LONG_RSI_OUTSIDE_28_30');
    expect(evaluateSt1R433SetupGate({ signal: 'BUY', rsi: 30 }).reason)
      .toBe('ST1_R433_LONG_RSI_OUTSIDE_28_30');
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 29, takerBuyRatio: 0.720001 }).reason)
      .toBe('ST1_R433_LONG_FLOW_OUTSIDE_058_072');
  });

  test('disables every new SHORT entry after the failed 90-day OOS replay', () => {
    expect(evaluateSt1R433SetupGate({ signal: 'SELL', rsi: 71 })).toEqual({
      allowed: false,
      reason: 'ST1_R433_SHORT_DISABLED_BY_90D_REPLAY'
    });
    expect(evaluateSt1R433EntryGate({ signal: 'SELL', rsi: 71, takerBuyRatio: 0.4 }).allowed)
      .toBe(false);
  });

  test('fails closed on invalid active inputs but can be explicitly disabled', () => {
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: null, takerBuyRatio: 0.64 }).allowed)
      .toBe(false);
    expect(evaluateSt1R433EntryGate({}, { enabled: false })).toEqual({
      allowed: true,
      reason: 'ST1_R433_GATE_DISABLED'
    });
  });
});
