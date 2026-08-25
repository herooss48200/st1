import { jest } from '@jest/globals';

jest.unstable_mockModule('../../src/services/notification-service.js', () => ({
  default: {
    sendMessage: jest.fn(),
    sendTradeSummary: jest.fn(),
    sendAmbushSummary: jest.fn(),
    sendError: jest.fn(),
    sendOrUpdatePerformanceReport: jest.fn()
  }
}));

jest.unstable_mockModule('../../src/statistics/trade-snapshot-service.js', () => ({
  default: {
    recordEntry: jest.fn(),
    recordExit: jest.fn()
  }
}));

jest.unstable_mockModule('../../src/services/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn()
  }
}));

const { preserveAmbushRuntimeState } = await import('../../src/trading-loop.js');

describe('preserveAmbushRuntimeState', () => {
  const nextAmbush = {
    coin: 'TESTUSDT',
    expectedSignal: 'SELL',
    addedAt: 2000,
    ready: false,
    readyAt: null,
    readyReason: null,
    triggered: false
  };

  test('aynı yöndeki hazır adayın çalışma durumunu yenilemede korur', () => {
    const result = preserveAmbushRuntimeState(nextAmbush, {
      expectedSignal: 'SELL',
      addedAt: 1000,
      ready: true,
      readyAt: 1500,
      readyReason: 'UPPER_BAND',
      triggered: false
    });

    expect(result).toEqual({
      ...nextAmbush,
      addedAt: 1000,
      ready: true,
      readyAt: 1500,
      readyReason: 'UPPER_BAND'
    });
  });

  test('yön değiştiğinde eski hazır durumunu taşımaz', () => {
    const result = preserveAmbushRuntimeState(nextAmbush, {
      expectedSignal: 'BUY',
      addedAt: 1000,
      ready: true,
      readyAt: 1500,
      readyReason: 'LOWER_BAND',
      triggered: false
    });

    expect(result).toBe(nextAmbush);
  });

  test('tetiklenmiş adayı yeniden hazır olarak taşımaz', () => {
    const result = preserveAmbushRuntimeState(nextAmbush, {
      expectedSignal: 'SELL',
      addedAt: 1000,
      ready: true,
      readyAt: 1500,
      readyReason: 'UPPER_BAND',
      triggered: true
    });

    expect(result).toBe(nextAmbush);
  });
});
