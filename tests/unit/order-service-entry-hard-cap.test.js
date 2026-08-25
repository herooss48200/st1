import { jest } from '@jest/globals';
import orderService from '../../src/services/order-service.js';
import { ORDER_TYPE } from '../../src/shared/types/index.js';

describe('OrderService opening MARKET hard caps', () => {
  const oldMode = process.env.APP_MODE;
  const oldLive = process.env.ENABLE_REAL_TRADING;
  const oldTradeSize = process.env.TRADE_SIZE_USDT;
  const oldMaxPositions = process.env.MAX_POSITIONS;

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.APP_MODE = 'live';
    process.env.ENABLE_REAL_TRADING = 'true';
    process.env.TRADE_SIZE_USDT = '50';
    process.env.MAX_POSITIONS = '10';
    jest.spyOn(orderService, 'logTrace').mockImplementation(() => {});
    jest.spyOn(orderService, 'ensureOpeningPositionSettings').mockResolvedValue({ marginType: 'ISOLATED', leverage: 10 });
  });

  afterAll(() => {
    process.env.APP_MODE = oldMode;
    process.env.ENABLE_REAL_TRADING = oldLive;
    process.env.TRADE_SIZE_USDT = oldTradeSize;
    process.env.MAX_POSITIONS = oldMaxPositions;
    jest.restoreAllMocks();
  });

  test('caps opening MARKET at 50 USDT but preserves smaller risk-sized orders', async () => {
    jest.spyOn(orderService, 'getOpenPositions').mockResolvedValue([]);
    jest.spyOn(orderService, 'getCurrentPrice').mockResolvedValue(10);
    jest.spyOn(orderService, 'normalizeQuantity').mockImplementation(async (_symbol, qty) => qty);

    const prepared = await orderService.enforceOpeningMarketLimits({
      symbol: 'AAAUSDT', side: 'BUY', type: ORDER_TYPE.MARKET, quantity: 20, reduceOnly: false
    });

    expect(prepared.quantity).toBeCloseTo(5, 10);
    expect(prepared.quantity * 10).toBeLessThanOrEqual(50);
    expect(prepared.newClientOrderId).toBeTruthy();
    expect(orderService.ensureOpeningPositionSettings).toHaveBeenCalledWith('AAAUSDT');

    const undersized = await orderService.enforceOpeningMarketLimits({
      symbol: 'BBBUSDT', side: 'BUY', type: ORDER_TYPE.MARKET, quantity: 1, reduceOnly: false
    });
    expect(undersized.quantity).toBeCloseTo(1, 10);
    expect(undersized.quantity * 10).toBeCloseTo(10, 10);
  });

  test('rejects a new opening MARKET order when 10 positions are already open', async () => {
    jest.spyOn(orderService, 'getOpenPositions').mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ symbol: `C${i}USDT`, notional: 10 }))
    );

    await expect(orderService.enforceOpeningMarketLimits({
      symbol: 'NEWUSDT', side: 'BUY', type: ORDER_TYPE.MARKET, quantity: 1, reduceOnly: false
    })).rejects.toThrow('MAX_POSITIONS_HARD_CAP:10/10');
  });

  test('rejects a second opening position on the same symbol', async () => {
    jest.spyOn(orderService, 'getOpenPositions').mockResolvedValue([{ symbol: 'AAAUSDT', notional: 20 }]);

    await expect(orderService.enforceOpeningMarketLimits({
      symbol: 'AAAUSDT', side: 'BUY', type: ORDER_TYPE.MARKET, quantity: 1, reduceOnly: false
    })).rejects.toThrow('MAX_POSITIONS_PER_COIN_HARD_CAP:AAAUSDT');
  });
});
