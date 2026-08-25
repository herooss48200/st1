import Database from 'better-sqlite3';
import { Logger } from '../services/logger.js';
import { schema } from './schema.js';
import config from '../config/config.js';

const logger = Logger.getInstance();

export class DatabaseConnection {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  connect() {
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      logger.info(`Database connected: ${this.dbPath}`);
      return this;
    } catch (err) {
      logger.error('Database connection failed:', err);
      throw err;
    }
  }

  migrate() {
    try {
      const tables = [
        'coins', 'candles', 'similarity', 'sniper', 'trades',
        'positions', 'orders', 'state', 'logs',
      ];
      for (const table of tables) {
        this.db.exec(schema.tables[table]);
      }
      logger.info('Database migrations completed');
      return this;
    } catch (err) {
      logger.error('Migration error:', err);
      throw err;
    }
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  transaction(fn) {
    const transaction = this.db.transaction(fn);
    return transaction();
  }

  close() {
    if (this.db) {
      this.db.close();
      logger.info('Database closed');
    }
  }
}

export class TradeRepository {
  constructor(db) {
    this.db = db;
  }

  create(trade) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (symbol, side, entry_price, quantity, entry_time, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(trade.symbol, trade.side, trade.entryPrice, trade.quantity, Date.now(), 'OPEN');
  }

  findById(id) {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE id = ?');
    return stmt.get(id);
  }

  findOpen() {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY entry_time');
    return stmt.all('OPEN');
  }

  update(id, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(',');
    const values = Object.values(updates);
    const stmt = this.db.prepare(`UPDATE trades SET ${fields} WHERE id = ?`);
    return stmt.run(...values, id);
  }

  close(id, exitPrice, exitTime) {
    return this.update(id, { status: 'CLOSED', exit_price: exitPrice, exit_time: exitTime });
  }
}

export class PositionRepository {
  constructor(db) {
    this.db = db;
  }

  create(pos) {
    const stmt = this.db.prepare(`
      INSERT INTO positions (symbol, quantity, entry_price, take_profit, stop_loss, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(pos.symbol, pos.quantity, pos.entryPrice, pos.tp, pos.sl, Date.now());
  }

  findActive(symbol) {
    const stmt = this.db.prepare('SELECT * FROM positions WHERE symbol = ? AND status = ?');
    return stmt.get(symbol, 'ACTIVE');
  }

  update(id, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(',');
    const values = Object.values(updates);
    const stmt = this.db.prepare(`UPDATE positions SET ${fields} WHERE id = ?`);
    return stmt.run(...values, id);
  }
}

export class CandleRepository {
  constructor(db) {
    this.db = db;
  }

  insert(candle) {
    const stmt = this.db.prepare(`
      INSERT INTO candles (symbol, interval, open_time, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      candle.symbol,
      candle.interval,
      candle.openTime,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume
    );
  }

  findLast(symbol, interval, limit = config.DATABASE_QUERY_DEFAULT_LIMIT) {
    const stmt = this.db.prepare(`
      SELECT * FROM candles WHERE symbol = ? AND interval = ?
      ORDER BY open_time DESC LIMIT ?
    `);
    return stmt.all(symbol, interval, limit).reverse();
  }
}
