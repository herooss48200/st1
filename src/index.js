import bootstrap from './bootstrap/bootstrap.js';
import logger from './services/logger.js';
import TradingLoop from './trading-loop.js';
import NotificationService from './services/notification-service.js';
import { CandleService } from './services/candle-service.js';
import config from './config/config.js';
import installAmbushPipelineDiagnostics from './diagnostics/ambush-pipeline-diagnostics.js';
import PositionMonitor from './services/position-monitor.js';
import HealthServer from './services/health-server.js';

let tradingLoop = null;
let positionMonitor = null;
const healthServer = new HealthServer({ host: config.HEALTH_HOST, port: config.HEALTH_PORT });

async function loadBTCTrendCandles(candleService, marketData, historicalCandleCache) {
  try {
    const interval = config.BTC_TREND_INTERVAL;
    const limit = config.BTC_TREND_CANDLE_LIMIT;
    
    logger.info(`📊 Loading BTC ${interval.toUpperCase()} Candles (${limit})...`, { service: 'gptsono' });

    const candles = historicalCandleCache
      ? await historicalCandleCache.getOrFetchCandles('BTCUSDT', interval, limit)
      : await marketData.getKlines('BTCUSDT', interval, limit);
    candleService.btcTrendCandles = candles;

    const daysEstimate = interval === '1h' ? Math.floor(limit / 24) : interval === '4h' ? Math.floor(limit / 6) : '~';
    logger.info('✅ BTC Candles Loaded', {
      service: 'gptsono',
      count: candles.length,
      interval: interval,
      timespan: daysEstimate !== '~' ? `~${daysEstimate} days` : 'variable'
    });

    return candles;
  } catch (error) {
    logger.error('Failed to load BTC candles', {
      service: 'gptsono',
      error: error.message
    });
    return [];
  }
}

async function main() {
  try {
    await healthServer.start();
    // Step 1: Initialize Bootstrap (all services & engines)
    await bootstrap.initialize();

    logger.info('ST1 is running', {
      mode: process.env.APP_MODE,
      environment: process.env.NODE_ENV
    });

    // Step 2: Get Services & Engines from Bootstrap
    const candleService = bootstrap.services.candleService;
    const marketData = bootstrap.services.marketData;
    const historicalCandleCache = bootstrap.services.historicalCandleCache;
    const engines = bootstrap.engines;

    // Step 3: Load BTC trend candles
    await loadBTCTrendCandles(candleService, marketData, historicalCandleCache);

    // Step 3.1: Warm historical candle cache (startup-only)
    await historicalCandleCache.preloadOnStartup();

    // Step 4: Send Boot Notification
    const loadedServices = Object.keys(bootstrap.services).length;
    const loadedEngines = Object.keys(bootstrap.engines).length;
    const loadedModules = loadedServices + loadedEngines;
    await NotificationService.sendBootMessage({
      loaded: loadedModules,
      total: loadedModules
    });

    // Step 5: Start 24/7 Trading Loop (Anayasa: Bölüm 1 - continuous operation)
    tradingLoop = new TradingLoop(bootstrap.services, engines);
    installAmbushPipelineDiagnostics(tradingLoop);
    await tradingLoop.start();

    positionMonitor = new PositionMonitor({
      tradingLoop,
      intervalMs: tradingLoop.resolvePositionMonitorIntervalMs()
    });
    positionMonitor.start();
    healthServer.setReady(true);

    logger.info('✅ Trading Loop Active (24/7)', {
      service: 'gptsono',
      mode: process.env.APP_MODE,
      interval: '60 seconds'
    });

  } catch (error) {
    healthServer.setReady(false);
    logger.fatal('Fatal error in main', { error: error.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  if (positionMonitor) {
    await positionMonitor.stop();
  }
  if (tradingLoop) {
    tradingLoop.stop();
  }
  await healthServer.stop();
  process.exit(0);
});

// Start application
main().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
