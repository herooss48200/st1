import { jest } from '@jest/globals';
import notificationService from '../../src/services/notification-service.js';

describe('NotificationService ambush summary formatting', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('SKIPPED status uses "Pusu Taraması Atlandı" and does not use completed headline', async () => {
    const sendSpy = jest.spyOn(notificationService, 'sendMessage').mockResolvedValue(true);

    await notificationService.sendAmbushSummary({
      status: 'SKIPPED',
      reason: 'BTC_TREND_INVALID_OR_SIDEWAYS',
      targetCoins: 600,
      fetchedCoins: 0,
      scannedCoins: 0,
      ambushCount: 4,
      longCount: 3,
      shortCount: 1,
      btcTrend: 'SIDEWAYS',
      ethTrend: 'DOWN',
      similarityInterval: '15m',
      refreshIntervalMinutes: 15,
      threshold: 85
    });

    const message = sendSpy.mock.calls[0][0];
    expect(message).toContain('Pusu Taraması Atlandı');
    expect(message).not.toContain('Pusu Taraması Tamamlandı');
  });

  test('FAILED status uses failure headline', async () => {
    const sendSpy = jest.spyOn(notificationService, 'sendMessage').mockResolvedValue(true);

    await notificationService.sendAmbushSummary({
      status: 'FAILED',
      reason: 'TOP_COINS_FETCH_FAILED',
      targetCoins: 600,
      scannedCoins: 0
    });

    const message = sendSpy.mock.calls[0][0];
    expect(message).toContain('Pusu Taraması Başarısız');
  });

  test('legacy strong conflict skip shows the real reason', async () => {
    const sendSpy = jest.spyOn(notificationService, 'sendMessage').mockResolvedValue(true);

    await notificationService.sendAmbushSummary({
      status: 'SKIPPED',
      reason: 'BTC_ETH_STRONG_CONFLICT',
      btcTrend: 'UP',
      ethTrend: 'DOWN'
    });

    const message = sendSpy.mock.calls[0][0];
    expect(message).toContain('BTC ve ETH güçlü biçimde zıt yönde');
    expect(message).not.toContain('Tarama güvenli şekilde atlandı.');
  });

  test('COMPLETED status uses completed headline', async () => {
    const sendSpy = jest.spyOn(notificationService, 'sendMessage').mockResolvedValue(true);

    await notificationService.sendAmbushSummary({
      status: 'COMPLETED',
      targetCoins: 600,
      fetchedCoins: 593,
      scannedCoins: 581,
      qualifiedAmbushes: 12,
      longCount: 7,
      shortCount: 5,
      breadthTargetCoins: 200,
      breadth15m: {
        state: 'DOWN',
        validCoins: 200,
        upCount: 42,
        downCount: 151,
        flatCount: 7
      },
      btcTrend: 'UP',
      ethTrend: 'UP',
      threshold: 85
    });

    const message = sendSpy.mock.calls[0][0];
    expect(message).toContain('Pusu Taraması Tamamlandı');
    expect(message).toContain('Gerçekten Taranan');
    expect(message).toContain('Breadth (15m)');
    expect(message).toContain('Breadth Hedefi: <code>200</code>');
    expect(message).toContain('Geçerli Coin: <code>200/200</code>');
    expect(message).toContain('Long Coin: <code>42</code>');
    expect(message).toContain('Short Coin: <code>151</code>');
    expect(message).toContain('Yatay Coin: <code>7</code>');
    expect(message).toContain('Long Pusu: <code>7</code>');
    expect(message).toContain('Short Pusu: <code>5</code>');
  });

  test('COMPLETED conflict scan shows BTC-led scan mode and entry safety requirement', async () => {
    const sendSpy = jest.spyOn(notificationService, 'sendMessage').mockResolvedValue(true);

    await notificationService.sendAmbushSummary({
      status: 'COMPLETED',
      reason: 'BTC_ETH_CONFLICT_SCAN_BTC_LED',
      targetCoins: 300,
      fetchedCoins: 300,
      scannedCoins: 296,
      btcTrend: 'DOWN',
      ethTrend: 'UP'
    });

    const message = sendSpy.mock.calls[0][0];
    expect(message).toContain('Pusu Taraması Tamamlandı');
    expect(message).toContain('Tarama Modu');
    expect(message).toContain('coinler BTC yönünde tarandı');
    expect(message).toContain('giriş için yeniden hizalanma zorunlu');
  });

  test('simple Renko summary shows real condition rejection counts', async () => {
    const sendSpy = jest.spyOn(notificationService, 'sendMessage').mockResolvedValue(true);

    await notificationService.sendAmbushSummary({
      strategy: 'ST1_SIMPLE_RENKO',
      status: 'COMPLETED',
      reason: 'ST1_SIMPLE_RENKO_ANALYSIS_COMPLETE',
      targetCoins: 300,
      fetchedCoins: 298,
      scannedCoins: 297,
      qualifiedAmbushes: 6,
      ambushCount: 6,
      longCount: 4,
      shortCount: 2,
      candleFailures: 1,
      rejectionCounts: {
        ST1_RENKO_RSI_NOT_BELOW_30: 160,
        ST1_RENKO_RSI_NOT_ABOVE_70: 131,
        ST1_RENKO_CANDLE_FETCH_FAILED: 1
      }
    });

    const message = sendSpy.mock.calls[0][0];
    expect(message).toContain('ST1 Renko Pusu Taraması');
    expect(message).toContain('Taranan Coin: <code>297</code>');
    expect(message).toContain('Toplam Pusu: <code>6</code>');
    expect(message).toContain('Long Pusu: <code>4</code>');
    expect(message).toContain('Short Pusu: <code>2</code>');
    expect(message).toContain('Koşul Retleri');
    expect(message).toContain('Long RSI 30 altına inmedi: <code>160</code>');
    expect(message).toContain('15m mum verisi alınamadı: <code>1</code>');
  });

  test('R43.1 funnel shows the real order-flow stages and rescue radar as disabled', async () => {
    const sendSpy = jest.spyOn(notificationService, 'sendMessage').mockResolvedValue(true);
    const previousTelegramEnabled = notificationService.config.ENABLE_TELEGRAM;
    notificationService.config.ENABLE_TELEGRAM = true;

    try {
      await notificationService.sendSt1EntryAndRescueRadar({
        funnel: {
          pusu: { LONG: 8, SHORT: 3 },
          LONG: { freshCross: 4, orderFlow1: 3, orderFlow2: 2, risk: 2, opened: 1 },
          SHORT: { freshCross: 2, orderFlow1: 1, orderFlow2: 1, risk: 1, opened: 1 },
          recentRejections: []
        },
        rescue: null
      });
    } finally {
      notificationService.config.ENABLE_TELEGRAM = previousTelegramEnabled;
    }

    const message = sendSpy.mock.calls[0][0];
    expect(message).toContain('ST1 R43.1 GİRİŞ HUNİSİ');
    expect(message).toContain('1m Kesişim <code>4</code>');
    expect(message).toContain('Flow-1 <code>3</code>');
    expect(message).toContain('Flow-2 <code>2</code>');
    expect(message).toContain('KURTARMA RADARI — KAPALI');
    expect(message).not.toContain('Coin EMA/ST');
    expect(message).not.toContain('BTC/ETH');
    expect(message).not.toContain('RED: yalnız PAPER');
  });
});
