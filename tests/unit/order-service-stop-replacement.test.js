import { jest } from '@jest/globals';
import orderService from '../../src/services/order-service.js';
import logger from '../../src/services/logger.js';

describe('OrderService stop-loss replacement safety', () => {
  beforeEach(() => {
    orderService.orders.clear();
    orderService.exchangeInfoCache = null;
    jest.restoreAllMocks();
  });

  test('does not cancel when the previous stop cannot be reconstructed', async () => {
    const cancelSpy = jest.spyOn(orderService, 'cancelOrder').mockResolvedValue({ success: true });
    const createSpy = jest.spyOn(orderService, 'createStopLossOrder');

    await expect(orderService.replaceStopLoss({
      symbol: 'BTCUSDT',
      cancelOrderId: 'old-stop',
      side: 'SELL',
      stopPrice: 101,
      quantity: 1
    })).rejects.toMatchObject({ code: 'STOP_REPLACEMENT_SNAPSHOT_UNAVAILABLE' });

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('restores the previous stop and exposes the restored order when replacement fails', async () => {
    orderService.orders.set('old-stop', { id: 'old-stop', symbol: 'BTCUSDT', stopPrice: 95, quantity: 1 });
    jest.spyOn(orderService, 'cancelOrder').mockResolvedValue({ success: true });
    const createError = new Error('replacement rejected');
    jest.spyOn(orderService, 'createStopLossOrder')
      .mockRejectedValueOnce(createError)
      .mockResolvedValueOnce({
        success: true,
        orderId: 'rollback-stop',
        order: { id: 'rollback-stop', stopPrice: 95 }
      });

    await expect(orderService.replaceStopLoss({
      symbol: 'BTCUSDT',
      cancelOrderId: 'old-stop',
      side: 'SELL',
      stopPrice: 101,
      quantity: 1
    })).rejects.toMatchObject({
      rollbackRestored: true,
      previousStopPrice: 95,
      rollbackResult: { orderId: 'rollback-stop' }
    });
  });

  test('surfaces a critical failure when replacement and rollback both fail', async () => {
    orderService.orders.set('old-stop', { id: 'old-stop', symbol: 'BTCUSDT', stopPrice: 95, quantity: 1 });
    jest.spyOn(orderService, 'cancelOrder').mockResolvedValue({ success: true });
    jest.spyOn(orderService, 'createStopLossOrder')
      .mockRejectedValueOnce(new Error('replacement rejected'))
      .mockRejectedValueOnce(new Error('rollback rejected'));
    const criticalSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(orderService.replaceStopLoss({
      symbol: 'BTCUSDT',
      cancelOrderId: 'old-stop',
      side: 'SELL',
      stopPrice: 101,
      quantity: 1
    })).rejects.toMatchObject({
      code: 'STOP_REPLACEMENT_AND_ROLLBACK_FAILED',
      rollbackRestored: false
    });

    expect(criticalSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CRITICAL]'),
      expect.objectContaining({ rollbackError: 'rollback rejected' })
    );
  });

  test('returns the new stop only after cancel and successful creation', async () => {
    orderService.orders.set('old-stop', { id: 'old-stop', symbol: 'BTCUSDT', stopPrice: 95, quantity: 1 });
    const events = [];
    jest.spyOn(orderService, 'cancelOrder').mockImplementation(async () => {
      events.push('cancel');
      return { success: true };
    });
    jest.spyOn(orderService, 'createStopLossOrder').mockImplementation(async () => {
      events.push('create');
      return { success: true, orderId: 'new-stop', order: { id: 'new-stop', stopPrice: 101 } };
    });

    await expect(orderService.replaceStopLoss({
      symbol: 'BTCUSDT',
      cancelOrderId: 'old-stop',
      side: 'SELL',
      stopPrice: 101,
      quantity: 1
    })).resolves.toMatchObject({ orderId: 'new-stop' });
    expect(events).toEqual(['cancel', 'create']);
  });

  test('does nothing when both prices normalize to the same exchange tick', async () => {
    orderService.exchangeInfoCache = {
      symbols: [{
        symbol: 'BTCUSDT',
        pricePrecision: 2,
        filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }]
      }]
    };
    orderService.orders.set('old-stop', { id: 'old-stop', symbol: 'BTCUSDT', stopPrice: 95.52, quantity: 1 });
    const cancelSpy = jest.spyOn(orderService, 'cancelOrder');

    await expect(orderService.replaceStopLoss({
      symbol: 'BTCUSDT',
      cancelOrderId: 'old-stop',
      side: 'SELL',
      stopPrice: 95.5217,
      quantity: 1
    })).resolves.toMatchObject({ noOp: true, strategy: 'normalized_no_op' });
    expect(cancelSpy).not.toHaveBeenCalled();
  });
  test('cancels a restart-cached algo stop through the algo endpoint', async () => {
    orderService.orders.set('9001', {
      id: '9001',
      symbol: 'BTCUSDT',
      type: 'STOP_MARKET',
      algo: true,
      live: true
    });
    jest.spyOn(orderService, 'isLiveTradingEnabled').mockReturnValue(true);
    const requestSpy = jest.spyOn(orderService, 'signedRequest').mockResolvedValue({ algoId: '9001' });

    await orderService.cancelOrder('9001', 'BTCUSDT');

    expect(requestSpy).toHaveBeenCalledWith('DELETE', '/fapi/v1/algoOrder', { algoId: '9001' });
  });

});
