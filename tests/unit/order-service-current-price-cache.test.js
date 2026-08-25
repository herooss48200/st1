import { jest } from '@jest/globals';
import orderService from '../../src/services/order-service.js';

describe('OrderService getCurrentPrice cycle-cache freshness', () => {
  const originalAppMode = process.env.APP_MODE;
  const originalEnableRealTrading = process.env.ENABLE_REAL_TRADING;
  const originalPositionCheckInterval = process.env.POSITION_CHECK_INTERVAL_MS;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();

    process.env.APP_MODE = 'live';
    process.env.ENABLE_REAL_TRADING = 'true';
    process.env.POSITION_CHECK_INTERVAL_MS = '3000';

    orderService.clearPositionRiskCycleCache();
    orderService.clearOpenOrdersCycleCache();

    jest.spyOn(orderService, 'logTrace').mockImplementation(() => {});
  });

  afterAll(() => {
    process.env.APP_MODE = originalAppMode;
    process.env.ENABLE_REAL_TRADING = originalEnableRealTrading;
    process.env.POSITION_CHECK_INTERVAL_MS = originalPositionCheckInterval;

    orderService.clearPositionRiskCycleCache();
    orderService.clearOpenOrdersCycleCache();
    jest.restoreAllMocks();
  });

  test('does not use previous-cycle cache markPrice when cycle metadata is missing', async () => {
    orderService.positionRiskCycleCache = new Map([
      ['AAAUSDT', { symbol: 'AAAUSDT', markPrice: 111 }]
    ]);
    orderService.positionRiskActiveCycleId = null;
    orderService.positionRiskCycleStartedAt = Date.now();
    orderService.positionRiskCycleTtlMs = 7000;

    const signedRequestSpy = jest.spyOn(orderService, 'signedRequest').mockResolvedValue({ markPrice: '222.5' });

    const price = await orderService.getCurrentPrice('AAAUSDT');

    expect(price).toBe(222.5);
    expect(signedRequestSpy).toHaveBeenCalledWith('GET', '/fapi/v1/premiumIndex', { symbol: 'AAAUSDT' });
  });

  test('can use markPrice from cache refreshed in the same cycle', async () => {
    jest.spyOn(orderService, 'getOpenPositions').mockResolvedValue([
      {
        symbol: 'BBBUSDT',
        quantity: 1,
        side: 'BUY',
        entryPrice: 100,
        markPrice: 333.3,
        leverage: 2,
        notional: 100,
        unrealizedProfit: 0
      }
    ]);
    const signedRequestSpy = jest.spyOn(orderService, 'signedRequest').mockResolvedValue({ markPrice: '999.9' });

    await orderService.primePositionRiskCycleCache();
    const price = await orderService.getCurrentPrice('BBBUSDT');

    expect(price).toBe(333.3);
    expect(signedRequestSpy).not.toHaveBeenCalled();
  });

  test('falls back to premiumIndex when cache is expired', async () => {
    orderService.positionRiskCycleCache = new Map([
      ['CCCUSDT', { symbol: 'CCCUSDT', markPrice: 444.4 }]
    ]);
    orderService.positionRiskActiveCycleId = 42;
    orderService.positionRiskCycleStartedAt = Date.now() - 10_000;
    orderService.positionRiskCycleTtlMs = 1_000;

    const signedRequestSpy = jest.spyOn(orderService, 'signedRequest').mockResolvedValue({ markPrice: '555.5' });

    const price = await orderService.getCurrentPrice('CCCUSDT');

    expect(price).toBe(555.5);
    expect(signedRequestSpy).toHaveBeenCalledWith('GET', '/fapi/v1/premiumIndex', { symbol: 'CCCUSDT' });
  });

  test('makes at most one external price call per symbol in one cycle', async () => {
    jest.spyOn(orderService, 'getOpenPositions').mockResolvedValue([]);
    const signedRequestSpy = jest.spyOn(orderService, 'signedRequest').mockResolvedValue({ markPrice: '777.7' });

    await orderService.primePositionRiskCycleCache();

    const first = await orderService.getCurrentPrice('DDDUSDT');
    const second = await orderService.getCurrentPrice('DDDUSDT');

    expect(first).toBe(777.7);
    expect(second).toBe(777.7);
    expect(signedRequestSpy).toHaveBeenCalledTimes(1);
    expect(signedRequestSpy).toHaveBeenCalledWith('GET', '/fapi/v1/premiumIndex', { symbol: 'DDDUSDT' });
  });
});
