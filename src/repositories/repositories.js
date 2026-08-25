import logger from '../services/logger.js';
import fs from 'fs';
import path from 'path';

class TradeRepository {
  constructor() {
    this.storagePath = path.join(process.cwd(), 'data', 'trade-snapshots.json');
    this.trades = this.loadTradesFromDisk();
  }

  loadTradesFromDisk() {
    try {
      if (!fs.existsSync(this.storagePath)) {
        return [];
      }
      const raw = fs.readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      logger.warning('Trade snapshot storage load failed', { error: error.message });
      return [];
    }
  }

  saveTradesToDisk() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.trades, null, 2), 'utf8');
    } catch (error) {
      logger.warning('Trade snapshot storage save failed', { error: error.message });
    }
  }

  async create(trade) {
    const existing = this.trades.find(t => t.tradeId === trade.tradeId);
    if (existing) {
      return existing;
    }
    const newTrade = {
      ...trade,
      id: `TRADE_${Date.now()}`,
      createdAt: new Date()
    };
    this.trades.push(newTrade);
    this.saveTradesToDisk();
    logger.info('Trade record created', { tradeId: newTrade.id });
    return newTrade;
  }

  async findById(id) {
    return this.trades.find(t => t.id === id) || null;
  }

  async findByTradeId(tradeId) {
    return this.trades.find(t => t.tradeId === tradeId) || null;
  }

  async findByStatus(status) {
    return this.trades.filter(t => t.status === status);
  }

  async update(id, data) {
    const trade = this.trades.find(t => t.id === id);
    if (!trade) return null;
    Object.assign(trade, data, { updatedAt: new Date() });
    this.saveTradesToDisk();
    return trade;
  }

  async getAll() {
    return this.trades;
  }
}

class PositionRepository {
  constructor() {
    this.positions = [];
  }

  async create(position) {
    const newPosition = {
      ...position,
      id: `POS_${Date.now()}`,
      createdAt: new Date()
    };
    this.positions.push(newPosition);
    logger.info('Position record created', { positionId: newPosition.id });
    return newPosition;
  }

  async findById(id) {
    return this.positions.find(p => p.id === id) || null;
  }

  async findByStatus(status) {
    return this.positions.filter(p => p.status === status);
  }

  async findBySymbol(symbol) {
    return this.positions.filter(p => p.symbol === symbol);
  }

  async update(id, data) {
    const position = this.positions.find(p => p.id === id);
    if (!position) return null;
    Object.assign(position, data, { updatedAt: new Date() });
    return position;
  }

  async getAll() {
    return this.positions;
  }
}

class CandleRepository {
  constructor() {
    this.candles = [];
  }

  async create(candle) {
    this.candles.push(candle);
    return candle;
  }

  async findBySymbolAndInterval(symbol, interval) {
    return this.candles.filter(c => c.symbol === symbol && c.interval === interval);
  }

  async deleteOldCandles(symbol, interval, keepCount) {
    const matching = this.candles.filter(c => c.symbol === symbol && c.interval === interval);
    if (matching.length > keepCount) {
      this.candles = this.candles.filter(c => !matching.includes(c) || matching.indexOf(c) >= matching.length - keepCount);
    }
  }
}

export {
  TradeRepository,
  PositionRepository,
  CandleRepository
};
