import { jest } from '@jest/globals';
import { MarketBreadthService } from '../../src/services/market-breadth-service.js';

const settings = {
  MARKET_BREADTH_TOP_COINS: 4,
  MARKET_BREADTH_UNIVERSE_TTL_MS: 3600000,
  MARKET_BREADTH_15M_CACHE_TTL_MS: 1,
  MARKET_BREADTH_MAX_RESULT_AGE_MS: 960000,
  MARKET_BREADTH_15M_CONCURRENCY: 2,
  MARKET_BREADTH_FLAT_THRESHOLD_PERCENT: 0.1,
  MARKET_BREADTH_MIN_VALID_COINS: 2,
  MARKET_BREADTH_ENTER_THRESHOLD_PERCENT: 60,
  MARKET_BREADTH_EXIT_THRESHOLD_PERCENT: 55
};

describe('MarketBreadthService weighted trend mode', () => {
  test('keeps a stable non-stablecoin universe and calculates momentum', async () => {
    const closes = { SOLUSDT: [100, 102], XRPUSDT: [100, 101], ADAUSDT: [100, 99] };
    const marketData = {
      getTop100Coins: jest.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', volume24h: 999, priceChangePercent: 2 },
        { symbol: 'USDCUSDT', volume24h: 800, priceChangePercent: 0 },
        { symbol: 'SOLUSDT', volume24h: 400, priceChangePercent: 3 },
        { symbol: 'XRPUSDT', volume24h: 300, priceChangePercent: 2 },
        { symbol: 'ADAUSDT', volume24h: 200, priceChangePercent: -1 }
      ]),
      getKlines: jest.fn(async (symbol) => closes[symbol].map((close) => ({ close })))
    };
    const service = new MarketBreadthService(marketData, settings);
    const result = await service.refresh(1000);
    expect(result.universeSize).toBe(3);
    expect(result.targetUniverseSize).toBe(4);
    expect(result.candidateUniverseSize).toBe(5);
    expect(result.breadth15m.state).toBe('UP');
    expect(result.breadth15m).toMatchObject({
      validCoins: 3,
      upCount: 2,
      downCount: 1,
      flatCount: 0
    });
    expect(result.breadth15m.medianReturnPercent).toBeCloseTo(1);
    expect(marketData.getTop100Coins).toHaveBeenCalledTimes(1);
    expect(marketData.getTop100Coins).toHaveBeenCalledWith(8);
    await service.refresh(1002);
    expect(marketData.getTop100Coins).toHaveBeenCalledTimes(1);
  });

  test('uses hysteresis and reports the active breadth verdict', () => {
    const service = new MarketBreadthService({}, settings);
    expect(service.classify(61, 39, 'NEUTRAL')).toBe('UP');
    expect(service.classify(56, 44, 'UP')).toBe('UP');
    expect(service.classify(54, 46, 'UP')).toBe('NEUTRAL');
    service.current = {
      calculatedAt: 1000,
      breadth24h: { state: 'UP' },
      breadth15m: { state: 'DOWN' },
      momentum: -10
    };
    expect(service.evaluate('BUY', 1100)).toMatchObject({
      mode: 'WEIGHTED_TREND', verdict: 'WOULD_VETO', reason: '15M_BREADTH_OPPOSES_ENTRY'
    });
  });
});
