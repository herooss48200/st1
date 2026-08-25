import axios from 'axios';
import crypto from 'crypto';
import logger from './logger.js';
import config from '../config/config.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';
import { ORDER_STATUS, ORDER_TYPE } from '../shared/types/index.js';

class OrderService {
  constructor() {
    this.orders = new Map();
    this.positionRiskCycleCache = null;
    this.positionRiskCycleId = 0;
    this.positionRiskActiveCycleId = null;
    this.positionRiskCycleStartedAt = 0;
    this.positionRiskCycleTtlMs = 0;
    this.currentPriceCycleCache = null;
    this.openOrdersCycleCache = null;
    this.retryAttempts = TRADING_CONSTANTS.ORDER_RETRY_ATTEMPTS;
    this.retryDelay = TRADING_CONSTANTS.ORDER_RETRY_DELAY_MS;
    this.exchangeInfoCache = null;
    this.exchangeInfoCachedAt = 0;
    this.exchangeInfoTtlMs = config.ORDER_EXCHANGE_INFO_TTL_MS;
  }

  resolvePositionRiskCycleTtlMs() {
    const configuredInterval = Number(process.env.POSITION_MONITOR_INTERVAL_MS || config.POSITION_MONITOR_INTERVAL_MS || 5000);
    if (!Number.isFinite(configuredInterval) || configuredInterval <= 0) {
      return 11000;
    }

    // Keep cache valid roughly for one monitor cycle (+buffer), then force refresh.
    return Math.max(
      config.ORDER_PRICE_CACHE_MIN_INTERVAL_MS,
      Math.floor(configuredInterval * config.ORDER_PRICE_CACHE_MULTIPLIER + config.ORDER_PRICE_CACHE_BUFFER_MS)
    );
  }

  isPositionRiskCacheFresh() {
    if (!(this.positionRiskCycleCache instanceof Map)) {
      return false;
    }

    if (this.positionRiskActiveCycleId == null || this.positionRiskCycleStartedAt <= 0) {
      return false;
    }

    const ttl = Number(this.positionRiskCycleTtlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) {
      return false;
    }

    return (Date.now() - this.positionRiskCycleStartedAt) <= ttl;
  }

  createTraceRequestId() {
    return `TRACE_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  sanitizeTraceObject(value) {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeTraceObject(item));
    }

    if (value && typeof value === 'object') {
      const sanitized = {};
      for (const [key, item] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes('apikey') ||
          lowerKey.includes('api_key') ||
          lowerKey === 'signature' ||
          lowerKey.includes('secret')
        ) {
          continue;
        }
        if (item !== undefined) {
          sanitized[key] = this.sanitizeTraceObject(item);
        }
      }
      return sanitized;
    }

    return value;
  }

  buildTraceUrl(baseUrl, endpoint, params = {}) {
    const sanitizedParams = this.sanitizeTraceObject(params);
    const query = new URLSearchParams(sanitizedParams).toString();
    return query ? `${baseUrl}${endpoint}?${query}` : `${baseUrl}${endpoint}`;
  }

  sanitizeTraceUrl(url) {
    if (!url) {
      return url;
    }

    try {
      const parsedUrl = new URL(url);
      parsedUrl.searchParams.delete('signature');
      return parsedUrl.toString();
    } catch {
      return String(url)
        .replace(/([?&])signature=[^&]+(&?)/i, '$1')
        .replace(/[?&]$/, '');
    }
  }

  logTrace(message, meta = {}) {
    logger.info(`[TRACE][BINANCE] ${message}`, meta);
  }

  isLiveTradingEnabled() {
    const mode = (process.env.APP_MODE || config.APP_MODE || 'paper').toLowerCase();
    const realTrading = String(process.env.ENABLE_REAL_TRADING || config.ENABLE_REAL_TRADING) === 'true';
    return mode === 'live' && realTrading;
  }

  getBaseUrl() {
    return process.env.BINANCE_BASE_URL || config.getBinanceUrl();
  }

  getApiCredentials() {
    const key = process.env.BINANCE_API_KEY || config.BINANCE_API_KEY;
    const secret = process.env.BINANCE_API_SECRET || config.BINANCE_API_SECRET;
    if (!key || !secret) {
      throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET eksik');
    }
    return { key, secret };
  }

  async signedRequest(method, endpoint, params = {}) {
    const baseUrl = this.getBaseUrl();
    const { key, secret } = this.getApiCredentials();
    const requestId = this.createTraceRequestId();
    const startedAt = Date.now();
    const payload = {
      ...params,
      timestamp: Date.now(),
      recvWindow: config.BINANCE_RECV_WINDOW_MS
    };
    const traceQueryParameters = this.sanitizeTraceObject(payload);
    const query = new URLSearchParams(payload).toString();
    const signature = crypto
      .createHmac('sha256', secret)
      .update(query)
      .digest('hex');
    const url = `${baseUrl}${endpoint}?${query}&signature=${signature}`;
    const traceRequestUrl = this.buildTraceUrl(baseUrl, endpoint, payload);

    this.logTrace('signedRequest.request', {
      requestId,
      timestamp: new Date(startedAt).toISOString(),
      endpoint,
      httpMethod: method,
      requestUrl: traceRequestUrl,
      queryParameters: traceQueryParameters,
      requestBody: null,
      headers: {}
    });

    try {
      const response = await axios({
        method,
        url,
        headers: { 'X-MBX-APIKEY': key },
        timeout: config.EXCHANGE_API_REQUEST_TIMEOUT_MS
      });

      this.logTrace('signedRequest.response', {
        requestId,
        timestamp: new Date().toISOString(),
        endpoint,
        httpMethod: method,
        requestUrl: traceRequestUrl,
        queryParameters: traceQueryParameters,
        requestBody: null,
        httpStatus: response.status,
        responseBody: this.sanitizeTraceObject(response.data),
        binanceErrorCode: response.data?.code ?? null,
        binanceErrorMessage: response.data?.msg ?? null,
        headers: this.sanitizeTraceObject(response.headers || {}),
        elapsedTimeMs: Date.now() - startedAt
      });

      return response.data;
    } catch (error) {
      const responseBody = this.sanitizeTraceObject(error.response?.data || null);
      this.logTrace('signedRequest.error', {
        requestId,
        timestamp: new Date().toISOString(),
        endpoint,
        httpMethod: method,
        requestUrl: traceRequestUrl,
        queryParameters: traceQueryParameters,
        requestBody: null,
        httpStatus: error.response?.status ?? null,
        responseBody,
        binanceErrorCode: error.response?.data?.code ?? null,
        binanceErrorMessage: error.response?.data?.msg ?? error.message,
        headers: this.sanitizeTraceObject(error.response?.headers || {}),
        elapsedTimeMs: Date.now() - startedAt,
        stackTrace: error.stack
      });
      throw error;
    }
  }

  async getExchangeInfo() {
    const now = Date.now();
    if (this.exchangeInfoCache && (now - this.exchangeInfoCachedAt) < this.exchangeInfoTtlMs) {
      return this.exchangeInfoCache;
    }

    const response = await axios.get(`${this.getBaseUrl()}/fapi/v1/exchangeInfo`, {
      timeout: config.EXCHANGE_API_REQUEST_TIMEOUT_MS
    });
    this.exchangeInfoCache = response.data;
    this.exchangeInfoCachedAt = now;
    return this.exchangeInfoCache;
  }

  async getSymbolPriceMetadata(symbol) {
    const exchangeInfo = await this.getExchangeInfo();
    const symbolInfo = (exchangeInfo.symbols || []).find((item) => item.symbol === symbol);
    const priceFilter = (symbolInfo?.filters || []).find((filter) => filter.filterType === 'PRICE_FILTER');
    const tickSizeText = String(priceFilter?.tickSize || '');
    const tickSize = Number(tickSizeText);
    const derivedPrecision = tickSizeText.includes('.')
      ? tickSizeText.replace(/0+$/, '').split('.')[1].length
      : 0;

    return {
      tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : null,
      pricePrecision: Number.isInteger(symbolInfo?.pricePrecision)
        ? symbolInfo.pricePrecision
        : derivedPrecision
    };
  }

  async normalizeTriggerPrice(symbol, price) {
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice)) return price;
    const symbolInfo = (this.exchangeInfoCache?.symbols || []).find((item) => item.symbol === symbol);
    const priceFilter = (symbolInfo?.filters || []).find((filter) => filter.filterType === 'PRICE_FILTER');
    const tickSizeText = String(priceFilter?.tickSize || '');
    const metadata = {
      tickSize: Number(tickSizeText),
      pricePrecision: Number.isInteger(symbolInfo?.pricePrecision)
        ? symbolInfo.pricePrecision
        : (tickSizeText.includes('.') ? tickSizeText.replace(/0+$/, '').split('.')[1].length : 6)
    };
    if (!Number.isFinite(metadata.tickSize) || metadata.tickSize <= 0) {
      return Number(numericPrice.toFixed(6));
    }
    const normalized = Math.round(numericPrice / metadata.tickSize) * metadata.tickSize;
    return Number(normalized.toFixed(Math.max(0, metadata.pricePrecision || 0)));
  }

  async normalizeQuantity(symbol, quantity) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Geçersiz quantity: ${quantity}`);
    }

    const exchangeInfo = await this.getExchangeInfo();
    const symbolInfo = (exchangeInfo.symbols || []).find((item) => item.symbol === symbol);
    if (!symbolInfo) {
      return Number(qty.toFixed(6));
    }

    const lotFilter = (symbolInfo.filters || []).find((filter) => filter.filterType === 'LOT_SIZE');
    if (!lotFilter) {
      return Number(qty.toFixed(6));
    }

    const stepSize = Number(lotFilter.stepSize || '0.001');
    const minQty = Number(lotFilter.minQty || '0');
    const precision = Math.max(0, Math.round(-Math.log10(stepSize)));

    let normalized = Math.floor(qty / stepSize) * stepSize;
    if (normalized < minQty) {
      normalized = minQty;
    }

    return Number(normalized.toFixed(precision));
  }

  toBinanceBoolean(value) {
    return value ? 'TRUE' : 'FALSE';
  }

  isAlgoOrderType(type) {
    return [
      ORDER_TYPE.STOP_MARKET,
      ORDER_TYPE.TAKE_PROFIT_MARKET,
      'STOP',
      'TAKE_PROFIT',
      'TRAILING_STOP_MARKET'
    ].includes(type);
  }

  normalizeRemoteOrder(order) {
    const isAlgoOrder = order.algoId != null || order.algoType != null || order.orderType != null;
    return {
      id: String(isAlgoOrder ? order.algoId : order.orderId),
      clientOrderId: order.clientOrderId || order.origClientOrderId || order.clientAlgoId || null,
      symbol: order.symbol,
      side: order.side,
      type: order.orderType || order.type,
      status: order.algoStatus || order.status || ORDER_STATUS.PENDING,
      quantity: Number(order.origQty || order.executedQty || 0),
      executedQty: Number(order.executedQty || 0),
      avgPrice: Number(order.actualPrice || order.avgPrice || order.price || 0),
      stopPrice: Number(order.triggerPrice || order.stopPrice || 0),
      reduceOnly: String(order.reduceOnly).toLowerCase() === 'true',
      closePosition: String(order.closePosition).toLowerCase() === 'true',
      workingType: order.workingType || null,
      priceProtect: String(order.priceProtect).toLowerCase() === 'true',
      algo: isAlgoOrder,
      algoType: order.algoType || null,
      live: true,
      raw: order,
      createdAt: order.time ? new Date(order.time) : new Date(),
      updatedAt: order.updateTime ? new Date(order.updateTime) : new Date()
    };
  }

  createLocalOrder(order, quantity = null) {
    const orderId = this.generateOrderId();
    const status = order.type === ORDER_TYPE.MARKET ? ORDER_STATUS.FILLED : ORDER_STATUS.PENDING;
    const placedOrder = {
      ...order,
      id: orderId,
      quantity,
      executedQty: status === ORDER_STATUS.FILLED ? Number(quantity || 0) : 0,
      status,
      live: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      filledAt: status === ORDER_STATUS.FILLED ? new Date() : null
    };

    this.orders.set(orderId, placedOrder);
    return placedOrder;
  }

  async buildOrderParams(order) {
    const type = order.type || ORDER_TYPE.MARKET;
    const isAlgoOrder = this.isAlgoOrderType(type);
    const isMarketOrder = type === ORDER_TYPE.MARKET;
    const isLimitOrder = type === ORDER_TYPE.LIMIT;
    const isStopMarketOrder = type === ORDER_TYPE.STOP_MARKET;
    const isTakeProfitMarketOrder = type === ORDER_TYPE.TAKE_PROFIT_MARKET;
    const usesClosePosition = order.closePosition === true;
    const supportsQuantity = !usesClosePosition;
    const supportsPrice = isLimitOrder;
    const supportsStopPrice = isStopMarketOrder || isTakeProfitMarketOrder;
    const supportsWorkingType = isStopMarketOrder || isTakeProfitMarketOrder;
    const supportsPriceProtect = isStopMarketOrder || isTakeProfitMarketOrder;
    const supportsTimeInForce = isLimitOrder;
    const shouldSendReduceOnly =
      order.reduceOnly === true &&
      !isMarketOrder &&
      !isLimitOrder &&
      !usesClosePosition;
    const params = {
      symbol: order.symbol,
      side: order.side,
      type
    };

    if (isAlgoOrder) {
      params.algoType = 'CONDITIONAL';
    } else if (order.newClientOrderId) {
      params.newClientOrderId = String(order.newClientOrderId);
    }

    if (usesClosePosition) {
      params.closePosition = 'true';
    } else if (supportsQuantity && order.quantity != null) {
      params.quantity = await this.normalizeQuantity(order.symbol, order.quantity);
    }

    if (supportsPrice && order.price != null) {
      params.price = Number(order.price);
    }
    if (supportsStopPrice && order.stopPrice != null) {
      if (isAlgoOrder) {
        params.triggerPrice = Number(order.stopPrice);
      } else {
        params.stopPrice = Number(order.stopPrice);
      }
    }
    if (shouldSendReduceOnly) {
      params.reduceOnly = 'true';
    }
    if (supportsWorkingType && order.workingType) {
      params.workingType = order.workingType;
    }
    if (supportsPriceProtect && order.priceProtect != null) {
      params.priceProtect = this.toBinanceBoolean(order.priceProtect);
    }
    if (supportsTimeInForce && order.timeInForce) {
      params.timeInForce = order.timeInForce;
    }
    if (order.newOrderRespType) {
      params.newOrderRespType = order.newOrderRespType;
    }

    return params;
  }

  generateClientOrderId(prefix = 'gpt') {
    const stamp = Date.now().toString(36);
    const nonce = crypto.randomBytes(5).toString('hex');
    return `${prefix}_${stamp}_${nonce}`.slice(0, 36);
  }

  async getOrderByClientOrderId(symbol, clientOrderId) {
    if (!this.isLiveTradingEnabled() || !symbol || !clientOrderId) {
      return null;
    }

    try {
      const result = await this.signedRequest('GET', '/fapi/v1/order', {
        symbol,
        origClientOrderId: clientOrderId
      });
      return this.normalizeRemoteOrder(result);
    } catch (error) {
      const code = Number(error.response?.data?.code);
      if (code === -2013) {
        return null;
      }
      throw error;
    }
  }

  async ensureOpeningPositionSettings(symbol) {
    if (!this.isLiveTradingEnabled()) {
      return { marginType: 'ISOLATED', leverage: Number(process.env.LEVERAGE || config.LEVERAGE || 10) };
    }

    const leverage = Number(process.env.LEVERAGE || config.LEVERAGE || 10);
    if (!Number.isInteger(leverage) || leverage <= 0) {
      throw new Error(`ENTRY_LEVERAGE_INVALID:${leverage}`);
    }

    try {
      await this.signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
    } catch (error) {
      // Binance -4046 means the symbol is already using the requested margin type.
      const code = Number(error?.response?.data?.code ?? error?.code);
      const message = String(error?.response?.data?.msg ?? error?.message ?? '');
      if (code !== -4046 && !message.toLowerCase().includes('no need to change margin type')) {
        throw new Error(`ENTRY_ISOLATED_MARGIN_FAILED:${symbol}:${code || message}`);
      }
    }

    const leverageResult = await this.signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
    const appliedLeverage = Number(leverageResult?.leverage);
    if (!Number.isFinite(appliedLeverage) || appliedLeverage !== leverage) {
      throw new Error(`ENTRY_LEVERAGE_VERIFY_FAILED:${symbol}:${appliedLeverage}/${leverage}`);
    }

    logger.info('Opening position settings enforced', { symbol, marginType: 'ISOLATED', leverage });
    return { marginType: 'ISOLATED', leverage };
  }

  async enforceOpeningMarketLimits(order) {
    const isOpeningMarket = (order.type || ORDER_TYPE.MARKET) === ORDER_TYPE.MARKET
      && order.reduceOnly !== true
      && order.closePosition !== true;
    if (!isOpeningMarket || !this.isLiveTradingEnabled()) {
      return order;
    }

    const openPositions = await this.getOpenPositions();
    const maxPositions = Math.max(1, Number(process.env.MAX_POSITIONS || config.MAX_POSITIONS || 15));
    if (openPositions.length >= maxPositions) {
      throw new Error(`MAX_POSITIONS_HARD_CAP:${openPositions.length}/${maxPositions}`);
    }

    const sameSymbol = openPositions.find((position) => position.symbol === order.symbol);
    if (sameSymbol) {
      throw new Error(`MAX_POSITIONS_PER_COIN_HARD_CAP:${order.symbol}`);
    }

    await this.ensureOpeningPositionSettings(order.symbol);

    const currentPrice = Number(await this.getCurrentPrice(order.symbol));
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      throw new Error(`ENTRY_HARD_CAP_PRICE_UNAVAILABLE:${order.symbol}`);
    }

    const maxNotionalUsdt = Number(process.env.TRADE_SIZE_USDT || config.TRADE_SIZE_USDT || 100);
    if (!Number.isFinite(maxNotionalUsdt) || maxNotionalUsdt <= 0) {
      throw new Error('TRADE_SIZE_USDT_INVALID');
    }

    const requestedQuantity = Number(order.quantity);
    if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
      throw new Error(`ENTRY_QUANTITY_INVALID:${order.quantity}`);
    }

    // AGROS R40.2: TRADE_SIZE_USDT is a ceiling, never a forced minimum.
    // The trading loop may deliberately request a smaller quantity when breadth
    // or structural-stop risk is worse. Preserve that reduction and only cap
    // oversized requests at the configured maximum.
    const requestedNotionalUsdt = requestedQuantity * currentPrice;
    const cappedQuantity = requestedNotionalUsdt > maxNotionalUsdt
      ? maxNotionalUsdt / currentPrice
      : requestedQuantity;
    const normalizedQuantity = await this.normalizeQuantity(order.symbol, cappedQuantity);
    const normalizedNotional = normalizedQuantity * currentPrice;
    if (!Number.isFinite(normalizedNotional) || normalizedNotional <= 0 || normalizedNotional > maxNotionalUsdt + 1e-8) {
      throw new Error(`ENTRY_NOTIONAL_HARD_CAP_FAILED:${normalizedNotional}/${maxNotionalUsdt}`);
    }

    logger.info('Opening MARKET notional ceiling enforced', {
      symbol: order.symbol,
      requestedQuantity,
      normalizedQuantity,
      currentPrice,
      requestedNotionalUsdt,
      finalNotionalUsdt: normalizedNotional,
      configuredMaxNotionalUsdt: maxNotionalUsdt,
      riskReduced: normalizedNotional + 1e-8 < maxNotionalUsdt
    });

    return {
      ...order,
      quantity: normalizedQuantity,
      newClientOrderId: order.newClientOrderId || this.generateClientOrderId('entry')
    };
  }

  async placeOrder(order) {
    const startedAt = Date.now();
    const orderType = order.type || ORDER_TYPE.MARKET;
    const isAlgoOrder = this.isAlgoOrderType(orderType);
    const isOpeningMarket = orderType === ORDER_TYPE.MARKET
      && order.reduceOnly !== true
      && order.closePosition !== true;
    const preparedOrder = isOpeningMarket
      ? await this.enforceOpeningMarketLimits(order)
      : order;
    this.logTrace('placeOrder.request', {
      timestamp: new Date(startedAt).toISOString(),
      symbol: preparedOrder.symbol,
      side: preparedOrder.side,
      type: orderType,
      quantity: preparedOrder.quantity ?? null,
      stopPrice: preparedOrder.stopPrice ?? null,
      reduceOnly: preparedOrder.reduceOnly === true,
      closePosition: preparedOrder.closePosition === true,
      workingType: preparedOrder.workingType || null,
      priceProtect: preparedOrder.priceProtect ?? null
    });
    try {
      let lastError;

      for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
        try {
          const type = orderType;
          const normalizedQuantity =
            preparedOrder.closePosition === true || preparedOrder.quantity == null
              ? null
              : await this.normalizeQuantity(preparedOrder.symbol, preparedOrder.quantity);

          if (!this.isLiveTradingEnabled()) {
            const placedOrder = this.createLocalOrder(
              { ...preparedOrder, type },
              normalizedQuantity
            );

            logger.info('Mock order placed (non-live mode)', {
              orderId: placedOrder.id,
              symbol: preparedOrder.symbol,
              side: preparedOrder.side,
              type,
              quantity: normalizedQuantity,
              stopPrice: preparedOrder.stopPrice ?? null,
              closePosition: preparedOrder.closePosition === true
            });

            const result = {
              success: true,
              orderId: placedOrder.id,
              order: placedOrder,
              live: false
            };

            this.logTrace('placeOrder.response', {
              timestamp: new Date().toISOString(),
              symbol: placedOrder.symbol,
              side: placedOrder.side,
              type,
              orderId: placedOrder.id,
              status: placedOrder.status,
              quantity: placedOrder.quantity,
              stopPrice: placedOrder.stopPrice || null,
              live: false,
              elapsedTimeMs: Date.now() - startedAt
            });

            return result;
          }

          const params = await this.buildOrderParams({
            ...preparedOrder,
            type,
            quantity: normalizedQuantity
          });
          if (type === ORDER_TYPE.MARKET && !params.newOrderRespType) {
            params.newOrderRespType = 'RESULT';
          }

          const endpoint = isAlgoOrder ? '/fapi/v1/algoOrder' : '/fapi/v1/order';
          const result = await this.signedRequest('POST', endpoint, params);
          const remoteOrder = this.normalizeRemoteOrder(result);
          const placedOrder = {
            ...preparedOrder,
            quantity: normalizedQuantity,
            ...remoteOrder,
            attempts: attempt
          };

          this.orders.set(placedOrder.id, placedOrder);

          logger.info('Live order placed', {
            orderId: placedOrder.id,
            symbol: placedOrder.symbol,
            side: placedOrder.side,
            type,
            quantity: placedOrder.quantity,
            status: placedOrder.status,
            stopPrice: placedOrder.stopPrice || null,
            closePosition: preparedOrder.closePosition === true
          });

          this.logTrace('placeOrder.response', {
            timestamp: new Date().toISOString(),
            symbol: placedOrder.symbol,
            side: placedOrder.side,
            type,
            orderId: placedOrder.id,
            status: placedOrder.status,
            quantity: placedOrder.quantity,
            stopPrice: placedOrder.stopPrice || null,
            live: true,
            elapsedTimeMs: Date.now() - startedAt
          });

          return { success: true, orderId: placedOrder.id, order: placedOrder, live: true };
        } catch (error) {
          lastError = error;

          if (isOpeningMarket && preparedOrder.newClientOrderId) {
            for (let recoveryAttempt = 1; recoveryAttempt <= 3; recoveryAttempt++) {
              try {
                if (recoveryAttempt > 1) {
                  await this.delay(250 * recoveryAttempt);
                }
                const recoveredOrder = await this.getOrderByClientOrderId(
                  preparedOrder.symbol,
                  preparedOrder.newClientOrderId
                );
                if (recoveredOrder) {
                  this.orders.set(recoveredOrder.id, recoveredOrder);
                  logger.warn('Opening MARKET order recovered by clientOrderId; duplicate retry suppressed', {
                    symbol: preparedOrder.symbol,
                    clientOrderId: preparedOrder.newClientOrderId,
                    orderId: recoveredOrder.id,
                    status: recoveredOrder.status
                  });
                  return {
                    success: true,
                    orderId: recoveredOrder.id,
                    order: recoveredOrder,
                    live: true,
                    recovered: true
                  };
                }
              } catch (recoveryError) {
                logger.warn('Opening MARKET recovery lookup failed', {
                  symbol: preparedOrder.symbol,
                  clientOrderId: preparedOrder.newClientOrderId,
                  recoveryAttempt,
                  error: recoveryError.message
                });
              }
            }

            // Opening MARKET orders are not safe to blindly POST twice.
            // If the first result is uncertain and cannot be recovered, fail closed.
            throw error;
          }

          this.logTrace('placeOrder.attemptFailed', {
            timestamp: new Date().toISOString(),
            symbol: preparedOrder.symbol,
            side: preparedOrder.side,
            type: preparedOrder.type || ORDER_TYPE.MARKET,
            attempt,
            retryAttempts: this.retryAttempts,
            errorMessage: error.message,
            elapsedTimeMs: Date.now() - startedAt
          });
          if (attempt < this.retryAttempts) {
            logger.warning(`Order retry ${attempt}/${this.retryAttempts}`, {
              symbol: preparedOrder.symbol,
              error: error.message
            });
            await this.delay(this.retryDelay);
          }
        }
      }

      throw lastError;
    } catch (error) {
      this.logTrace('placeOrder.error', {
        timestamp: new Date().toISOString(),
        symbol: preparedOrder.symbol,
        side: preparedOrder.side,
        type: preparedOrder.type || ORDER_TYPE.MARKET,
        quantity: preparedOrder.quantity ?? null,
        stopPrice: preparedOrder.stopPrice ?? null,
        errorMessage: error.message,
        httpStatus: error.response?.status ?? null,
        binanceErrorCode: error.response?.data?.code ?? null,
        binanceErrorMessage: error.response?.data?.msg ?? error.message,
        endpoint: isAlgoOrder ? '/fapi/v1/algoOrder' : '/fapi/v1/order',
        httpMethod: 'POST',
        requestUrl: this.sanitizeTraceUrl(error.config?.url || null),
        queryParameters: this.sanitizeTraceObject(error.config?.params || null),
        requestBody: this.sanitizeTraceObject(error.config?.data || null),
        responseBody: this.sanitizeTraceObject(error.response?.data || null),
        stackTrace: error.stack,
        elapsedTimeMs: Date.now() - startedAt
      });
      logger.error('Order placement failed', {
        error: error.message,
        symbol: preparedOrder.symbol,
        httpStatus: error.response?.status ?? null,
        binanceErrorCode: error.response?.data?.code ?? null,
        binanceErrorMessage: error.response?.data?.msg ?? error.message,
        endpoint: error.config?.url || (isAlgoOrder ? '/fapi/v1/algoOrder' : '/fapi/v1/order'),
        requestId: error.response?.headers?.['x-request-id'] || error.response?.headers?.['x-mbx-uuid'] || null,
        coin: order.symbol,
        orderType: order.type || ORDER_TYPE.MARKET,
        stackTrace: error.stack || null
      });
      throw error;
    }
  }

  async createStopLossOrder({ symbol, side, stopPrice, quantity = null }) {
    const startedAt = Date.now();
    this.logTrace('createStopLossOrder.request', {
      timestamp: new Date(startedAt).toISOString(),
      symbol,
      side,
      stopPrice,
      quantity
    });
    try {
      const exchangeInfo = await this.getExchangeInfo();
      const symbolInfo = (exchangeInfo.symbols || []).find((item) => item.symbol === symbol);
      const priceFilter = (symbolInfo?.filters || []).find((filter) => filter.filterType === 'PRICE_FILTER');
      const normalizedTriggerPrice = (() => {
        const numericStopPrice = Number(stopPrice);
        if (!Number.isFinite(numericStopPrice)) {
          return stopPrice;
        }
        if (!priceFilter) {
          return Number(numericStopPrice.toFixed(6));
        }

        const tickSizeText = String(priceFilter.tickSize || '0.01');
        const tickSize = Number(tickSizeText);
        if (!Number.isFinite(tickSize) || tickSize <= 0) {
          return Number(numericStopPrice.toFixed(6));
        }

        const precision = tickSizeText.includes('.')
          ? tickSizeText.replace(/0+$/, '').split('.')[1].length
          : 0;
        return Number((Math.round(numericStopPrice / tickSize) * tickSize).toFixed(precision));
      })();
      const normalizedQuantity = quantity == null
        ? null
        : await this.normalizeQuantity(symbol, quantity);
      const result = await this.placeOrder({
        symbol,
        side,
        quantity: normalizedQuantity,
        type: ORDER_TYPE.STOP_MARKET,
        reduceOnly: true,
        closePosition: true,
        workingType: 'MARK_PRICE',
        priceProtect: true,
        stopPrice: normalizedTriggerPrice
      });
      this.logTrace('createStopLossOrder.response', {
        timestamp: new Date().toISOString(),
        symbol,
        side,
        stopPrice,
        quantity,
        orderId: result?.orderId || null,
        success: result?.success === true,
        elapsedTimeMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      this.logTrace('createStopLossOrder.error', {
        timestamp: new Date().toISOString(),
        symbol,
        side,
        stopPrice,
        quantity,
        errorMessage: error.message,
        elapsedTimeMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async createTakeProfitOrder({ symbol, side, stopPrice, quantity = null }) {
    const startedAt = Date.now();
    this.logTrace('createTakeProfitOrder.request', {
      timestamp: new Date(startedAt).toISOString(),
      symbol,
      side,
      stopPrice,
      quantity
    });
    try {
      const exchangeInfo = await this.getExchangeInfo();
      const symbolInfo = (exchangeInfo.symbols || []).find((item) => item.symbol === symbol);
      const priceFilter = (symbolInfo?.filters || []).find((filter) => filter.filterType === 'PRICE_FILTER');
      const normalizedTriggerPrice = (() => {
        const numericStopPrice = Number(stopPrice);
        if (!Number.isFinite(numericStopPrice)) {
          return stopPrice;
        }
        if (!priceFilter) {
          return Number(numericStopPrice.toFixed(6));
        }

        const tickSizeText = String(priceFilter.tickSize || '0.01');
        const tickSize = Number(tickSizeText);
        if (!Number.isFinite(tickSize) || tickSize <= 0) {
          return Number(numericStopPrice.toFixed(6));
        }

        const precision = tickSizeText.includes('.')
          ? tickSizeText.replace(/0+$/, '').split('.')[1].length
          : 0;
        return Number((Math.round(numericStopPrice / tickSize) * tickSize).toFixed(precision));
      })();
      const normalizedQuantity = quantity == null
        ? null
        : await this.normalizeQuantity(symbol, quantity);
      const result = await this.placeOrder({
        symbol,
        side,
        quantity: normalizedQuantity,
        type: ORDER_TYPE.TAKE_PROFIT_MARKET,
        reduceOnly: true,
        closePosition: true,
        workingType: 'MARK_PRICE',
        priceProtect: true,
        stopPrice: normalizedTriggerPrice
      });
      this.logTrace('createTakeProfitOrder.response', {
        timestamp: new Date().toISOString(),
        symbol,
        side,
        stopPrice,
        quantity,
        orderId: result?.orderId || null,
        success: result?.success === true,
        elapsedTimeMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      this.logTrace('createTakeProfitOrder.error', {
        timestamp: new Date().toISOString(),
        symbol,
        side,
        stopPrice,
        quantity,
        errorMessage: error.message,
        elapsedTimeMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async replaceStopLoss({ symbol, cancelOrderId, side, stopPrice, quantity = null }) {
    const startedAt = Date.now();
    this.logTrace('replaceStopLoss.request', {
      timestamp: new Date(startedAt).toISOString(),
      symbol,
      cancelOrderId,
      side,
      stopPrice,
      quantity
    });
    try {
      if (!cancelOrderId) {
        const created = await this.createStopLossOrder({ symbol, side, stopPrice, quantity });
        this.logTrace('replaceStopLoss.response', {
          timestamp: new Date().toISOString(),
          symbol,
          cancelOrderId,
          side,
          stopPrice,
          quantity,
          orderId: created?.orderId || null,
          success: created?.success === true,
          strategy: 'create_only',
          elapsedTimeMs: Date.now() - startedAt
        });
        return created;
      }

      const previousStopSnapshot = this.orders.get(String(cancelOrderId)) || null;
      const rollbackStopPrice = Number(previousStopSnapshot?.stopPrice);
      const rollbackQuantity = previousStopSnapshot?.quantity ?? quantity;

      // Cancel/create is used because duplicate close-position protection is not
      // assumed to be accepted by every Binance Futures position mode. Refuse to
      // cancel unless the exact previous protection can be reconstructed.
      if (!Number.isFinite(rollbackStopPrice) || rollbackStopPrice <= 0) {
        const snapshotError = new Error('Cannot safely replace stop-loss: previous stop snapshot is unavailable');
        snapshotError.code = 'STOP_REPLACEMENT_SNAPSHOT_UNAVAILABLE';
        throw snapshotError;
      }

      const normalizedStopPrice = await this.normalizeTriggerPrice(symbol, stopPrice);
      if (Number(normalizedStopPrice) === rollbackStopPrice) {
        return {
          success: true,
          orderId: String(cancelOrderId),
          order: previousStopSnapshot,
          noOp: true,
          strategy: 'normalized_no_op'
        };
      }

      await this.cancelOrder(cancelOrderId, symbol);

      let replacementResult;
      try {
        replacementResult = await this.createStopLossOrder({ symbol, side, stopPrice: normalizedStopPrice, quantity });
      } catch (createError) {
        try {
          const rollbackResult = await this.createStopLossOrder({
            symbol,
            side,
            stopPrice: rollbackStopPrice,
            quantity: rollbackQuantity
          });

          createError.code = createError.code || 'STOP_REPLACEMENT_FAILED_ROLLED_BACK';
          createError.rollbackRestored = true;
          createError.rollbackResult = rollbackResult;
          createError.previousStopPrice = rollbackStopPrice;

          logger.error('[CRITICAL] Stop-loss replacement failed; previous protection was restored by rollback', {
            symbol,
            cancelOrderId,
            newStopPrice: stopPrice,
            rollbackStopPrice,
            restoredOrderId: rollbackResult?.orderId || null,
            createError: createError.message,
            elapsedTimeMs: Date.now() - startedAt
          });
        } catch (rollbackError) {
          createError.code = 'STOP_REPLACEMENT_AND_ROLLBACK_FAILED';
          createError.rollbackRestored = false;
          createError.rollbackError = rollbackError;
          createError.previousStopPrice = rollbackStopPrice;

          logger.error('[CRITICAL] Stop-loss replacement failed and rollback could not restore protection', {
            symbol,
            cancelOrderId,
            newStopPrice: stopPrice,
            rollbackStopPrice,
            createError: createError.message,
            rollbackError: rollbackError.message,
            elapsedTimeMs: Date.now() - startedAt
          });
        }

        throw createError;
      }

      const result = replacementResult;
      this.logTrace('replaceStopLoss.response', {
        timestamp: new Date().toISOString(),
        symbol,
        cancelOrderId,
        side,
        stopPrice,
        quantity,
        orderId: result?.orderId || null,
        success: result?.success === true,
        strategy: 'cancel_then_create_with_rollback',
        elapsedTimeMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      this.logTrace('replaceStopLoss.error', {
        timestamp: new Date().toISOString(),
        symbol,
        cancelOrderId,
        side,
        stopPrice,
        quantity,
        errorMessage: error.message,
        elapsedTimeMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async replaceTakeProfit({ symbol, cancelOrderId, side, stopPrice, quantity = null }) {
    const startedAt = Date.now();
    this.logTrace('replaceTakeProfit.request', {
      timestamp: new Date(startedAt).toISOString(),
      symbol,
      cancelOrderId,
      side,
      stopPrice,
      quantity
    });
    try {
      if (cancelOrderId) {
        await this.cancelOrder(cancelOrderId, symbol);
      }
      const result = await this.createTakeProfitOrder({ symbol, side, stopPrice, quantity });
      this.logTrace('replaceTakeProfit.response', {
        timestamp: new Date().toISOString(),
        symbol,
        cancelOrderId,
        side,
        stopPrice,
        quantity,
        orderId: result?.orderId || null,
        success: result?.success === true,
        elapsedTimeMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      this.logTrace('replaceTakeProfit.error', {
        timestamp: new Date().toISOString(),
        symbol,
        cancelOrderId,
        side,
        stopPrice,
        quantity,
        errorMessage: error.message,
        elapsedTimeMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async cancelOrder(orderId, symbol = null) {
    const startedAt = Date.now();
    this.logTrace('cancelOrder.request', {
      timestamp: new Date(startedAt).toISOString(),
      orderId,
      symbol
    });
    try {
      const trackedOrder = this.orders.get(orderId) || null;
      const symbolToCancel = symbol || trackedOrder?.symbol;
      if (!symbolToCancel) {
        throw new Error(`Cancel için symbol gerekli. orderId=${orderId}`);
      }

      if (!this.isLiveTradingEnabled()) {
        if (!trackedOrder) {
          throw new Error(`Order not found: ${orderId}`);
        }

        trackedOrder.status = ORDER_STATUS.CANCELED;
        trackedOrder.canceledAt = new Date();
        trackedOrder.updatedAt = new Date();
        logger.info('Mock order canceled', { orderId, symbol: symbolToCancel });
        this.logTrace('cancelOrder.response', {
          timestamp: new Date().toISOString(),
          orderId,
          symbol: symbolToCancel,
          success: true,
          live: false,
          elapsedTimeMs: Date.now() - startedAt
        });
        return { success: true, order: trackedOrder };
      }

      const isAlgoOrder = trackedOrder?.algo === true;
      const endpoint = isAlgoOrder ? '/fapi/v1/algoOrder' : '/fapi/v1/order';
      const params = isAlgoOrder
        ? { algoId: orderId }
        : { symbol: symbolToCancel, orderId };
      const result = await this.signedRequest('DELETE', endpoint, params);

      if (trackedOrder) {
        trackedOrder.status = ORDER_STATUS.CANCELED;
        trackedOrder.canceledAt = new Date();
        trackedOrder.updatedAt = new Date();
      }

      logger.info('Live order canceled', { orderId, symbol: symbolToCancel });
      this.logTrace('cancelOrder.response', {
        timestamp: new Date().toISOString(),
        orderId,
        symbol: symbolToCancel,
        success: true,
        elapsedTimeMs: Date.now() - startedAt
      });
      return { success: true, result };
    } catch (error) {
      this.logTrace('cancelOrder.error', {
        timestamp: new Date().toISOString(),
        orderId,
        symbol,
        errorMessage: error.message,
        httpStatus: error.response?.status ?? null,
        binanceErrorCode: error.response?.data?.code ?? null,
        binanceErrorMessage: error.response?.data?.msg ?? error.message,
        endpoint: trackedOrder?.algo === true ? '/fapi/v1/algoOrder' : '/fapi/v1/order',
        httpMethod: 'DELETE',
        requestUrl: this.sanitizeTraceUrl(error.config?.url || null),
        queryParameters: this.sanitizeTraceObject(error.config?.params || null),
        requestBody: this.sanitizeTraceObject(error.config?.data || null),
        responseBody: this.sanitizeTraceObject(error.response?.data || null),
        stackTrace: error.stack,
        elapsedTimeMs: Date.now() - startedAt
      });
      logger.error('Order cancellation failed', { error: error.message, orderId });
      throw error;
    }
  }

  async getOrder(orderId, symbol = null) {
    if (!this.isLiveTradingEnabled()) {
      return this.orders.get(orderId) || null;
    }

    const trackedOrder = this.orders.get(orderId) || null;
    const isAlgoOrder = trackedOrder?.algo === true;
    const symbolToQuery = symbol || trackedOrder?.symbol;
    if (!isAlgoOrder && !symbolToQuery) {
      throw new Error(`Order sorgusu için symbol gerekli. orderId=${orderId}`);
    }

    const endpoint = isAlgoOrder ? '/fapi/v1/algoOrder' : '/fapi/v1/order';
    const params = isAlgoOrder
      ? { algoId: orderId }
      : { symbol: symbolToQuery, orderId };
    const result = await this.signedRequest('GET', endpoint, params);
    const remoteOrder = this.normalizeRemoteOrder(result);
    const mergedOrder = { ...trackedOrder, ...remoteOrder };
    this.orders.set(mergedOrder.id, mergedOrder);
    return mergedOrder;
  }

  async getUserTrades(symbol, options = {}) {
    if (!symbol) {
      throw new Error('User trade sorgusu için symbol gerekli');
    }
    if (!this.isLiveTradingEnabled()) {
      return [];
    }

    const params = { symbol };
    const startTime = Number(options.startTime);
    const endTime = Number(options.endTime);
    const limit = Number(options.limit);
    if (Number.isFinite(startTime) && startTime > 0) params.startTime = Math.floor(startTime);
    if (Number.isFinite(endTime) && endTime > 0) params.endTime = Math.floor(endTime);
    params.limit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;

    const result = await this.signedRequest('GET', '/fapi/v1/userTrades', params);
    return Array.isArray(result) ? result.map((trade) => ({
      symbol: trade.symbol,
      id: trade.id != null ? String(trade.id) : null,
      orderId: trade.orderId != null ? String(trade.orderId) : null,
      side: trade.side,
      price: Number(trade.price || 0),
      quantity: Number(trade.qty || trade.quantity || 0),
      quoteQty: Number(trade.quoteQty || 0),
      realizedPnl: Number(trade.realizedPnl || 0),
      commission: Number(trade.commission || 0),
      commissionAsset: trade.commissionAsset || null,
      time: Number(trade.time || 0),
      positionSide: trade.positionSide || 'BOTH',
      buyer: Boolean(trade.buyer),
      maker: Boolean(trade.maker),
      raw: trade
    })) : [];
  }

  async getOpenOrders(symbol = null) {
    const startedAt = Date.now();
    this.logTrace('getOpenOrders.request', {
      timestamp: new Date(startedAt).toISOString(),
      symbol
    });
    try {
      if (!this.isLiveTradingEnabled()) {
        const openOrders = Array.from(this.orders.values()).filter((order) => {
          const matchesSymbol = symbol ? order.symbol === symbol : true;
          return matchesSymbol && ![
            ORDER_STATUS.CANCELED,
            ORDER_STATUS.FILLED,
            ORDER_STATUS.FAILED
          ].includes(order.status);
        });
        this.logTrace('getOpenOrders.response', {
          timestamp: new Date().toISOString(),
          symbol,
          openOrderCount: openOrders.length,
          live: false,
          elapsedTimeMs: Date.now() - startedAt
        });
        return openOrders;
      }

      const openOrders = this.openOrdersCycleCache instanceof Array
        ? this.openOrdersCycleCache.filter((order) => (symbol ? order.symbol === symbol : true))
        : await this.fetchAndMapOpenOrders(symbol);

      for (const order of openOrders) {
        this.orders.set(order.id, order);
      }

      this.logTrace('getOpenOrders.response', {
        timestamp: new Date().toISOString(),
        symbol,
        openOrderCount: openOrders.length,
        elapsedTimeMs: Date.now() - startedAt
      });
      return openOrders;
    } catch (error) {
      this.logTrace('getOpenOrders.error', {
        timestamp: new Date().toISOString(),
        symbol,
        errorMessage: error.message,
        elapsedTimeMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async fetchAndMapOpenOrders(symbol = null) {
    const params = symbol ? { symbol } : {};
    const regularResult = await this.signedRequest('GET', '/fapi/v1/openOrders', params);
    const algoResult = await this.signedRequest('GET', '/fapi/v1/openAlgoOrders', {});
    const regularOrders = Array.isArray(regularResult)
      ? regularResult.map((order) => this.normalizeRemoteOrder(order))
      : [];
    const algoOrders = Array.isArray(algoResult)
      ? algoResult
        .map((order) => this.normalizeRemoteOrder(order))
        .filter((order) => (symbol ? order.symbol === symbol : true))
      : [];
    return [...regularOrders, ...algoOrders];
  }

  async primeOpenOrdersCycleCache() {
    this.openOrdersCycleCache = await this.fetchAndMapOpenOrders();
    return this.openOrdersCycleCache;
  }

  clearOpenOrdersCycleCache() {
    this.openOrdersCycleCache = null;
  }

  async getOpenPositions() {
    const startedAt = Date.now();
    this.logTrace('getOpenPositions.request', {
      timestamp: new Date(startedAt).toISOString()
    });
    try {
      if (!this.isLiveTradingEnabled()) {
        this.logTrace('getOpenPositions.response', {
          timestamp: new Date().toISOString(),
          openPositionCount: 0,
          live: false,
          elapsedTimeMs: Date.now() - startedAt
        });
        return [];
      }

      const result = await this.signedRequest('GET', '/fapi/v2/positionRisk');
      const positions = Array.isArray(result) ? result : [];

      const mappedPositions = positions
        .filter((position) => Number(position.positionAmt) !== 0)
        .map((position) => {
          const quantity = Math.abs(Number(position.positionAmt));
          return {
            symbol: position.symbol,
            quantity,
            side: Number(position.positionAmt) > 0 ? 'BUY' : 'SELL',
            entryPrice: Number(position.entryPrice),
            markPrice: Number(position.markPrice),
            leverage: Number(position.leverage || 1),
            notional: Math.abs(Number(position.notional || 0)),
            unrealizedProfit: Number(position.unRealizedProfit || 0)
          };
        });

      this.logTrace('getOpenPositions.response', {
        timestamp: new Date().toISOString(),
        openPositionCount: mappedPositions.length,
        elapsedTimeMs: Date.now() - startedAt
      });

      return mappedPositions;
    } catch (error) {
      this.logTrace('getOpenPositions.error', {
        timestamp: new Date().toISOString(),
        errorMessage: error.message,
        elapsedTimeMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async primePositionRiskCycleCache() {
    const positions = await this.getOpenPositions();
    return this.primePositionRiskCycleCacheFromPositions(positions);
  }

  primePositionRiskCycleCacheFromPositions(positions = []) {
    const normalizedPositions = Array.isArray(positions) ? positions : [];
    this.positionRiskCycleId += 1;
    this.positionRiskActiveCycleId = this.positionRiskCycleId;
    this.positionRiskCycleStartedAt = Date.now();
    this.positionRiskCycleTtlMs = this.resolvePositionRiskCycleTtlMs();
    this.positionRiskCycleCache = new Map(normalizedPositions.map((position) => [position.symbol, position]));
    this.currentPriceCycleCache = new Map();
    return this.positionRiskCycleCache;
  }

  clearPositionRiskCycleCache() {
    this.positionRiskCycleCache = null;
    this.positionRiskActiveCycleId = null;
    this.positionRiskCycleStartedAt = 0;
    this.positionRiskCycleTtlMs = 0;
    this.currentPriceCycleCache = null;
  }

  async getOpenPosition(symbol) {
    if (this.positionRiskCycleCache instanceof Map) {
      return this.positionRiskCycleCache.get(symbol) || null;
    }
    const positions = await this.getOpenPositions();
    return positions.find((position) => position.symbol === symbol) || null;
  }

  async getCurrentPrice(symbol) {
    const startedAt = Date.now();
    this.logTrace('getCurrentPrice.request', {
      timestamp: new Date(startedAt).toISOString(),
      symbol
    });

    try {
      if (!this.isLiveTradingEnabled()) {
        // PAPER still needs a real market price for ST1 body-break triggers and
        // rescue-radar measurements. Use Binance Futures public mark price only;
        // this path is unsigned and can never place or modify an order.
        const response = await axios.get(`${this.getBaseUrl()}/fapi/v1/premiumIndex`, {
          params: { symbol },
          timeout: config.MARKET_DATA_REQUEST_TIMEOUT_MS
        });
        const publicMarkPrice = Number(response?.data?.markPrice);
        if (!Number.isFinite(publicMarkPrice) || publicMarkPrice <= 0) {
          throw new Error(`Invalid public mark price for ${symbol}`);
        }
        this.logTrace('getCurrentPrice.response', {
          timestamp: new Date().toISOString(),
          symbol,
          currentPrice: publicMarkPrice,
          source: 'publicPremiumIndex',
          live: false,
          elapsedTimeMs: Date.now() - startedAt
        });
        return publicMarkPrice;
      }

      const hasFreshCycleCache = this.isPositionRiskCacheFresh();

      const perCyclePrice = this.currentPriceCycleCache instanceof Map
        ? Number(this.currentPriceCycleCache.get(symbol))
        : Number.NaN;
      if (hasFreshCycleCache && Number.isFinite(perCyclePrice) && perCyclePrice > 0) {
        this.logTrace('getCurrentPrice.response', {
          timestamp: new Date().toISOString(),
          symbol,
          currentPrice: perCyclePrice,
          source: 'currentPriceCycleCache',
          elapsedTimeMs: Date.now() - startedAt
        });
        return perCyclePrice;
      }

      const cachedPosition = hasFreshCycleCache
        ? this.positionRiskCycleCache.get(symbol)
        : null;
      const cachedMarkPrice = Number(cachedPosition?.markPrice);
      if (Number.isFinite(cachedMarkPrice) && cachedMarkPrice > 0) {
        if (this.currentPriceCycleCache instanceof Map) {
          this.currentPriceCycleCache.set(symbol, cachedMarkPrice);
        }
        this.logTrace('getCurrentPrice.response', {
          timestamp: new Date().toISOString(),
          symbol,
          currentPrice: cachedMarkPrice,
          source: 'positionRiskCache',
          elapsedTimeMs: Date.now() - startedAt
        });
        return cachedMarkPrice;
      }

      const result = await this.signedRequest('GET', '/fapi/v1/premiumIndex', { symbol });
      const markPrice = Number(result?.markPrice);
      if (!Number.isFinite(markPrice) || markPrice <= 0) {
        throw new Error(`Invalid mark price for ${symbol}`);
      }

      if (this.currentPriceCycleCache instanceof Map) {
        this.currentPriceCycleCache.set(symbol, markPrice);
      }

      this.logTrace('getCurrentPrice.response', {
        timestamp: new Date().toISOString(),
        symbol,
        currentPrice: markPrice,
        source: 'premiumIndex',
        elapsedTimeMs: Date.now() - startedAt
      });
      return markPrice;
    } catch (error) {
      this.logTrace('getCurrentPrice.error', {
        timestamp: new Date().toISOString(),
        symbol,
        errorMessage: error.message,
        elapsedTimeMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async getFuturesAccountSnapshot() {
    if (!this.isLiveTradingEnabled()) {
      return null;
    }

    const result = await this.signedRequest('GET', '/fapi/v2/account');
    const walletBalance = Number(result?.totalWalletBalance);
    const availableBalance = Number(result?.availableBalance);
    const unrealizedPnl = Number(result?.totalUnrealizedProfit);
    const marginBalance = Number(result?.totalMarginBalance);

    if (!Number.isFinite(walletBalance)) {
      throw new Error('BINANCE_ACCOUNT_WALLET_BALANCE_INVALID');
    }

    return {
      walletBalance,
      availableBalance: Number.isFinite(availableBalance) ? availableBalance : null,
      unrealizedPnl: Number.isFinite(unrealizedPnl) ? unrealizedPnl : null,
      marginBalance: Number.isFinite(marginBalance) ? marginBalance : null,
      source: 'BINANCE_FUTURES_ACCOUNT'
    };
  }

  async simulateProtectiveOrderFill(position, markPrice) {
    if (this.isLiveTradingEnabled()) {
      return null;
    }

    const symbol = position.coin;
    const isLong = position.signal === 'BUY';
    const openOrders = await this.getOpenOrders(symbol);
    const stopOrder = openOrders.find((order) => order.id === position.stopOrderId)
      || openOrders.find((order) => order.type === ORDER_TYPE.STOP_MARKET);
    const takeProfitOrder = openOrders.find((order) => order.id === position.takeProfitOrderId)
      || openOrders.find((order) => order.type === ORDER_TYPE.TAKE_PROFIT_MARKET);

    const currentPrice = Number(markPrice);
    const stopPrice = Number(stopOrder?.stopPrice ?? position.stopPrice);
    const takeProfitPrice = Number(takeProfitOrder?.stopPrice ?? position.takeProfitPrice);

    let filledOrder = null;
    if (
      takeProfitOrder &&
      Number.isFinite(takeProfitPrice) &&
      ((isLong && currentPrice >= takeProfitPrice) || (!isLong && currentPrice <= takeProfitPrice))
    ) {
      filledOrder = takeProfitOrder;
      this.markOrderFilled(filledOrder.id, takeProfitPrice);
      if (stopOrder) {
        await this.cancelOrder(stopOrder.id, symbol);
      }
      return {
        filledOrder: { ...filledOrder, status: ORDER_STATUS.FILLED, avgPrice: takeProfitPrice },
        canceledOrderId: stopOrder?.id || null
      };
    }

    if (
      stopOrder &&
      Number.isFinite(stopPrice) &&
      ((isLong && currentPrice <= stopPrice) || (!isLong && currentPrice >= stopPrice))
    ) {
      filledOrder = stopOrder;
      this.markOrderFilled(filledOrder.id, stopPrice);
      if (takeProfitOrder) {
        await this.cancelOrder(takeProfitOrder.id, symbol);
      }
      return {
        filledOrder: { ...filledOrder, status: ORDER_STATUS.FILLED, avgPrice: stopPrice },
        canceledOrderId: takeProfitOrder?.id || null
      };
    }

    return null;
  }

  markOrderFilled(orderId, fillPrice = null) {
    const order = this.orders.get(orderId);
    if (!order) {
      return;
    }

    order.status = ORDER_STATUS.FILLED;
    order.avgPrice = fillPrice != null ? Number(fillPrice) : order.avgPrice;
    order.executedQty = Number(order.quantity || 0);
    order.filledAt = new Date();
    order.updatedAt = new Date();
  }

  getOrders(filter = {}) {
    const orders = Array.from(this.orders.values());
    if (filter.status) {
      return orders.filter((order) => order.status === filter.status);
    }
    if (filter.symbol) {
      return orders.filter((order) => order.symbol === filter.symbol);
    }
    return orders;
  }

  generateOrderId() {
    return `ORD_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new OrderService();
