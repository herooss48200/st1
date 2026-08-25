// Database schema for GPTSONO
// Version: 1.0

const SCHEMA = {
  coins: `
    CREATE TABLE IF NOT EXISTS coins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT UNIQUE NOT NULL,
      base_asset TEXT NOT NULL,
      quote_asset TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      tick_size REAL NOT NULL,
      step_size REAL NOT NULL,
      min_qty REAL NOT NULL,
      min_notional REAL NOT NULL,
      max_leverage INTEGER DEFAULT 125,
      max_position_amount REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_coins_symbol ON coins(symbol);
    CREATE INDEX idx_coins_status ON coins(status);
  `,

  candles: `
    CREATE TABLE IF NOT EXISTS candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin_id INTEGER NOT NULL,
      interval TEXT NOT NULL,
      open_time INTEGER NOT NULL,
      close_time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      quote_volume REAL NOT NULL,
      trades INTEGER,
      taker_buy_volume REAL,
      taker_buy_quote_volume REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (coin_id) REFERENCES coins(id),
      UNIQUE(coin_id, interval, open_time)
    );
    CREATE INDEX idx_candles_coin_interval ON candles(coin_id, interval);
    CREATE INDEX idx_candles_open_time ON candles(open_time);
  `,

  similarity: `
    CREATE TABLE IF NOT EXISTS similarity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin_id INTEGER NOT NULL,
      btc_id INTEGER NOT NULL,
      score REAL NOT NULL,
      body_score REAL,
      wick_upper_score REAL,
      wick_lower_score REAL,
      range_score REAL,
      volume_score REAL,
      momentum_score REAL,
      trend_score REAL,
      pattern_score REAL,
      window_start_time INTEGER,
      window_end_time INTEGER,
      analysis_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (coin_id) REFERENCES coins(id),
      FOREIGN KEY (btc_id) REFERENCES coins(id)
    );
    CREATE INDEX idx_similarity_coin ON similarity(coin_id);
    CREATE INDEX idx_similarity_score ON similarity(score);
    CREATE INDEX idx_similarity_timestamp ON similarity(analysis_timestamp);
  `,

  sniper: `
    CREATE TABLE IF NOT EXISTS sniper (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sniper_id TEXT UNIQUE NOT NULL,
      coin_id INTEGER NOT NULL,
      similarity_score REAL NOT NULL,
      btc_trend TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'WAITING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      triggered_at DATETIME,
      expired_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (coin_id) REFERENCES coins(id)
    );
    CREATE INDEX idx_sniper_status ON sniper(status);
    CREATE INDEX idx_sniper_coin ON sniper(coin_id);
    CREATE INDEX idx_sniper_created ON sniper(created_at);
  `,

  trades: `
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id TEXT UNIQUE NOT NULL,
      sniper_id TEXT NOT NULL,
      coin_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      trigger_price REAL NOT NULL,
      trigger_time DATETIME NOT NULL,
      similarity_score REAL NOT NULL,
      btc_trend TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (coin_id) REFERENCES coins(id)
    );
    CREATE INDEX idx_trades_coin ON trades(coin_id);
    CREATE INDEX idx_trades_status ON trades(status);
    CREATE INDEX idx_trades_created ON trades(created_at);
  `,

  positions: `
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id TEXT UNIQUE NOT NULL,
      trade_id TEXT NOT NULL,
      coin_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      entry_price REAL NOT NULL,
      entry_time DATETIME NOT NULL,
      quantity REAL NOT NULL,
      leverage INTEGER NOT NULL,
      notional_value REAL NOT NULL,
      take_profit REAL,
      stop_loss REAL,
      break_even REAL,
      trailing_stop REAL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      exit_price REAL,
      exit_time DATETIME,
      profit_loss REAL,
      profit_loss_percent REAL,
      closed_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      FOREIGN KEY (coin_id) REFERENCES coins(id)
    );
    CREATE INDEX idx_positions_coin ON positions(coin_id);
    CREATE INDEX idx_positions_status ON positions(status);
    CREATE INDEX idx_positions_entry_time ON positions(entry_time);
  `,

  orders: `
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      position_id TEXT NOT NULL,
      coin_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      order_type TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      binance_order_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      filled_at DATETIME,
      failed_at DATETIME,
      FOREIGN KEY (coin_id) REFERENCES coins(id)
    );
    CREATE INDEX idx_orders_coin ON orders(coin_id);
    CREATE INDEX idx_orders_status ON orders(status);
    CREATE INDEX idx_orders_binance_id ON orders(binance_order_id);
  `,

  state: `
    CREATE TABLE IF NOT EXISTS state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      data_type TEXT DEFAULT 'string',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_state_key ON state(key);
  `,

  logs: `
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_logs_level ON logs(level);
    CREATE INDEX idx_logs_created ON logs(created_at);
  `
};

export default SCHEMA;
