import {
  ST1_R433_ENTRY_POLICY,
  ST1_R438_ADDITIVE_POLICY,
  evaluateSt1R433EntryGate,
  evaluateSt1R433SetupGate
} from '../../src/engines/st1-r433-entry-gate.js';

describe('ST1 R43.8 CORE + SHADOW entry authority', () => {
  test('keeps CORE LONG inside RSI [28,30) and taker ratio [0.58,0.72]', () => {
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 28, takerBuyRatio: 0.58 }))
      .toMatchObject({ allowed: true, policy: ST1_R433_ENTRY_POLICY, lane: 'R433_CORE', executionAuthority: 'CORE_ORDER_ROUTE' });
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 29.999, takerBuyRatio: 0.72 }))
      .toMatchObject({ allowed: true, executionAuthority: 'CORE_ORDER_ROUTE' });
  });

  test('rejects unapproved RSI gaps and excessive taker buying', () => {
    expect(evaluateSt1R433SetupGate({ signal: 'BUY', rsi: 27.5 }).reason).toBe('ST1_R433_LONG_RSI_OUTSIDE_28_30');
    expect(evaluateSt1R433SetupGate({ signal: 'BUY', rsi: 30 }).reason).toBe('ST1_R433_LONG_RSI_OUTSIDE_28_30');
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 29, takerBuyRatio: 0.720001 }).reason)
      .toBe('ST1_R433_LONG_FLOW_OUTSIDE_058_072');
  });

  test('disables every new SHORT entry', () => {
    expect(evaluateSt1R433SetupGate({ signal: 'SELL', rsi: 71 })).toEqual({
      allowed: false, reason: 'ST1_R433_SHORT_DISABLED_BY_90D_REPLAY'
    });
  });

  test('fails closed on invalid active inputs but can be explicitly disabled', () => {
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: null, takerBuyRatio: 0.64 }).allowed).toBe(false);
    expect(evaluateSt1R433EntryGate({}, { enabled: false })).toEqual({ allowed: true, reason: 'ST1_R433_GATE_DISABLED' });
  });

  test('admits RSI [26,27) only as SHADOW_ONLY when explicitly enabled', () => {
    const options = {
      additiveShadowEnabled: true,
      additiveRsiMinimum: 26,
      additiveRsiMaximumExclusive: 27,
      additiveFlowMinimum: 0.58,
      additiveFlowMaximum: 0.72
    };
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 26, takerBuyRatio: 0.58 }, options))
      .toMatchObject({ allowed: true, policy: ST1_R438_ADDITIVE_POLICY, lane: 'R438_SHADOW', executionAuthority: 'SHADOW_ONLY' });
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 26.999, takerBuyRatio: 0.72 }, options))
      .toMatchObject({ allowed: true, executionAuthority: 'SHADOW_ONLY' });
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 27, takerBuyRatio: 0.64 }, options).allowed).toBe(false);
  });

  test('never enables the shadow lane implicitly', () => {
    expect(evaluateSt1R433EntryGate({ signal: 'BUY', rsi: 26.5, takerBuyRatio: 0.64 }).allowed).toBe(false);
  });
});
