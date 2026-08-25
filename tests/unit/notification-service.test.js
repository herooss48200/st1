import axios from 'axios';
import { jest } from '@jest/globals';
import { NotificationService } from '../../src/services/notification-service.js';

describe('NotificationService Telegram delivery', () => {
  let postSpy;
  let service;

  beforeEach(() => {
    postSpy = jest.spyOn(axios, 'post');
    service = new NotificationService();
    service.config.ENABLE_TELEGRAM = true;
    service.config.TELEGRAM_RETRY_ATTEMPTS = 3;
    service.config.TELEGRAM_RETRY_DELAY_MS = 0;
    service.config.TELEGRAM_REQUEST_TIMEOUT_MS = 100;
    service.logger.warning = jest.fn();
  });

  afterEach(() => {
    postSpy.mockRestore();
  });

  test('returns true only after Telegram confirms delivery', async () => {
    postSpy.mockResolvedValue({ data: { ok: true } });

    await expect(service.sendMessage('test')).resolves.toBe(true);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  test('retries transient failures and returns the real result', async () => {
    postSpy
      .mockRejectedValueOnce(new Error('temporary-1'))
      .mockRejectedValueOnce(new Error('temporary-2'))
      .mockResolvedValueOnce({ data: { ok: true } });

    await expect(service.sendMessage('retry')).resolves.toBe(true);
    expect(postSpy).toHaveBeenCalledTimes(3);
  });

  test('returns false after all retry attempts fail', async () => {
    postSpy.mockRejectedValue(new Error('telegram-down'));

    await expect(service.sendMessage('fail')).resolves.toBe(false);
    expect(postSpy).toHaveBeenCalledTimes(3);
    expect(service.logger.warning).toHaveBeenCalledTimes(3);
  });

  test('reports economic loss truthfully even when the close trigger is TP', async () => {
    postSpy.mockResolvedValue({ data: { ok: true } });

    await service.sendTradeSummary({
      opened: [],
      closed: [{
        coin: 'TESTUSDT',
        signal: 'BUY',
        reason: 'TP',
        entryPrice: 100,
        exitPrice: 100.05,
        netPnlForTradeSizeUsdt: -0.03
      }],
      stats: {
        total: 1, openedTotal: 1, successful: 0, failed: 1, neutral: 0,
        breakEven: 0, tp: 1, sl: 0, external: 0,
        tpLong: 1, tpShort: 0, trailLong: 0, trailShort: 0,
        slLong: 0, slShort: 0, beLong: 0, beShort: 0,
        externalLong: 0, externalShort: 0
      },
      wallet: { initial: 1000, current: 999.97, realizedPnl: 0.05 },
      commission: 0.08,
      mode: 'paper',
      maxPositions: 20,
      ambushDirection: { longCount: 0, shortCount: 0 }
    });

    const sentText = postSpy.mock.calls[0][1].text;
    expect(sentText).toContain('❌ NET ZARARLI İŞLEMLER: 1');
    expect(sentText).toContain('🚪 Tetik: TP');
    expect(sentText).toContain('📌 Sonuç: ❌ NET ZARAR');
    expect(sentText).toContain('🚪 KAPANIŞ TETİKLERİ (ekonomik sonuç değildir)');
    expect(sentText).not.toContain('BAŞARILI İŞLEMLER (TP/TRAIL/BE)');
  });

  test('sends the structural SL and gross-profit lock target when delayed protection activates', async () => {
    postSpy.mockResolvedValue({ data: { ok: true } });

    await service.sendProtectionActivated('BTCUSDT', {
      signal: 'BUY',
      entryPrice: 100000.5,
      delayMs: 150000,
      stopPrice: 98765.12,
      profitLockPrice: 100500.25,
      interval: '15m',
      lookback: 20
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        text: expect.stringMatching(/BTCUSDT[\s\S]*100000\.50000000[\s\S]*2 dk 30 sn[\s\S]*98765\.12000000[\s\S]*100500\.25000000/)
      }),
      expect.objectContaining({ timeout: 100 })
    );
  });
});
