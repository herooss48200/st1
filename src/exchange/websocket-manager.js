import WebSocket from 'ws';
import { Logger } from '../services/logger.js';
import { EventBus } from '../core/event-bus.js';
import { ErrorManager } from '../core/error-manager.js';
import appConfig from '../config/config.js';

const logger = Logger.getInstance();
const eventBus = EventBus.getInstance();
const errorManager = ErrorManager.getInstance();

const BASE_URL = appConfig.BINANCE_WEBSOCKET_URL;

export class WebSocketManager {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.subscriptions = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = appConfig.WEBSOCKET_MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = appConfig.WEBSOCKET_RECONNECT_DELAY;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(BASE_URL);
        this.ws.on('open', () => {
          logger.info('WebSocket connected');
          this.reconnectAttempts = 0;
          this.resubscribeAll();
          resolve();
        });
        this.ws.on('message', (data) => this.handleMessage(data));
        this.ws.on('error', (err) => {
          logger.error('WebSocket error:', err);
          errorManager.handleError(err, 'NETWORK');
        });
        this.ws.on('close', () => this.handleDisconnect());
        setTimeout(() => reject(new Error('Connection timeout')), appConfig.WEBSOCKET_CONNECTION_TIMEOUT_MS);
      } catch (err) {
        reject(err);
      }
    });
  }

  subscribe(symbol, streamType = 'kline_1m') {
    const channel = `${symbol.toLowerCase()}@${streamType}`;
    this.subscriptions.set(channel, { symbol, streamType });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [channel], id: 1 }));
    }
    logger.debug(`Subscribed to ${channel}`);
  }

  unsubscribe(symbol, streamType = 'kline_1m') {
    const channel = `${symbol.toLowerCase()}@${streamType}`;
    this.subscriptions.delete(channel);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [channel], id: 1 }));
    }
  }

  resubscribeAll() {
    for (const [channel] of this.subscriptions) {
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [channel], id: 1 }));
    }
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      if (message.e === 'kline') {
        const kline = {
          symbol: message.s,
          interval: message.k.i,
          openTime: message.k.t,
          closeTime: message.k.T,
          open: message.k.o,
          high: message.k.h,
          low: message.k.l,
          close: message.k.c,
          volume: message.k.v,
          quoteVolume: message.k.q,
          isClosed: message.k.x,
        };
        eventBus.emit('kline', kline);
      }
    } catch (err) {
      logger.error('Message parse error:', err);
    }
  }

  handleDisconnect() {
    logger.warn(`WebSocket disconnected. Attempts: ${this.reconnectAttempts}`);
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      setTimeout(() => this.connect().catch(e => logger.error('Reconnect failed:', e)), delay);
    } else {
      logger.error('Max reconnection attempts reached');
      eventBus.emit('ws-error', { reason: 'max-reconnects' });
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
