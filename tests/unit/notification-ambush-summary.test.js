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
});
