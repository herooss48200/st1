import { jest } from '@jest/globals';

const axiosGet = jest.fn();
jest.unstable_mockModule('axios', () => ({
  default: { get: axiosGet }
}));

const { MarketDataService } = await import('../../src/services/market-data.js');
const { default: config } = await import('../../src/config/config.js');

const closedCandle = [0, '100', '101', '99', '100', '10', 1, '1000', 1, '5', '500'];

describe('Market data request resilience', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    config.CANDLE_RETRY_ATTEMPTS = 3;
    config.CANDLE_RETRY_BASE_DELAY_MS = 0;
    config.CANDLE_CIRCUIT_FAILURE_THRESHOLD = 10;
    config.CANDLE_CIRCUIT_OPEN_MS = 60000;
  });

  test('coalesces identical in-flight candle requests', async () => {
    let release;
    axiosGet.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const service = new MarketDataService();

    const first = service.getKlines('BTCUSDT', '1m', 20);
    const second = service.getKlines('BTCUSDT', '1m', 20);
    release({ data: [closedCandle] });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  test('retries a temporary outage and recovers', async () => {
    axiosGet
      .mockRejectedValueOnce(Object.assign(new Error('temporary outage'), { response: { status: 503, headers: {} } }))
      .mockResolvedValueOnce({ data: [closedCandle] });
    const service = new MarketDataService();

    await expect(service.getKlines('ETHUSDT', '1m', 20)).resolves.toHaveLength(1);
    expect(axiosGet).toHaveBeenCalledTimes(2);
    expect(service.candleFailureCount).toBe(0);
  });

  test('opens the circuit after repeated failures and stops the request storm', async () => {
    config.CANDLE_RETRY_ATTEMPTS = 1;
    config.CANDLE_CIRCUIT_FAILURE_THRESHOLD = 2;
    axiosGet.mockRejectedValue(Object.assign(new Error('down'), { response: { status: 503, headers: {} } }));
    const service = new MarketDataService();

    await expect(service.getKlines('AUSDT', '1m', 20)).rejects.toThrow('down');
    await expect(service.getKlines('BUSDT', '1m', 20)).rejects.toThrow('down');
    await expect(service.getKlines('CUSDT', '1m', 20)).rejects.toMatchObject({ code: 'CANDLE_CIRCUIT_OPEN' });
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });
});
