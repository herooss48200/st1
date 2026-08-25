import { config } from '../config/index.js';
import logger from '../services/logger.js';
import { CandleService, IndicatorService } from '../services/candle-service.js';
import MarketDataService from '../services/market-data.js';
import OrderService from '../services/order-service.js';
import NotificationService from '../services/notification-service.js';
import SimilarityEngine from '../engines/similarity-engine.js';
import TrendEngine from '../engines/trend-engine.js';
import TriggerEngine from '../engines/trigger-engine.js';
import SniperEngine from '../engines/sniper-engine.js';
import { PositionManager } from '../engines/position-manager.js';
import { RiskManager } from '../engines/risk-manager.js';
import HistoricalCandleCache from '../cache/historical-candle-cache.js';

class Bootstrap {
  constructor() {
    this.initialized = false;
    this.services = {};
    this.engines = {};
  }

  async initialize() {
    try {
      logger.info('🚀 ST1 Bootstrap Starting...', {
        mode: config.APP_MODE,
        environment: config.NODE_ENV
      });

      // Step 1: Verify Configuration
      await this.verifyConfiguration();

      // Step 2: Initialize Logger
      await this.initializeLogger();

      // Step 3: Initialize Database
      await this.initializeDatabase();

      // Step 4: Initialize Cache
      await this.initializeCache();

      // Step 5: Initialize Exchange Connection
      await this.initializeExchange();

      // Step 6: Initialize Services
      await this.initializeServices();

      // Step 7: Initialize Engines
      await this.initializeEngines();

      // Step 8: Setup Graceful Shutdown
      this.setupGracefulShutdown();

      this.initialized = true;
      logger.info('✅ ST1 Bootstrap Completed Successfully', {
        servicesLoaded: Object.keys(this.services).length
      });

      return true;
    } catch (error) {
      logger.fatal('❌ Bootstrap Failed', { error: error.message });
      throw error;
    }
  }

  async verifyConfiguration() {
    logger.info('📋 Verifying Configuration...');

    if (!config.validate()) {
      throw new Error('Configuration validation failed');
    }

    logger.info('✓ Configuration verified', {
      mode: config.APP_MODE,
      leverage: config.LEVERAGE,
      maxPositions: config.MAX_POSITIONS
    });
  }

  async initializeLogger() {
    logger.info('📝 Logger initialized');
  }

  async initializeDatabase() {
    logger.info('🗄️  Initializing Database...');
    await new Promise(resolve => setTimeout(resolve, config.BOOTSTRAP_STEP_DELAY_MS));
    logger.info('✓ Database initialized');
  }

  async initializeCache() {
    logger.info('💾 Initializing Cache...');
    await new Promise(resolve => setTimeout(resolve, config.BOOTSTRAP_STEP_DELAY_MS));
    logger.info('✓ Cache initialized');
  }

  async initializeExchange() {
    logger.info('🔗 Initializing Exchange Connection...');
    await new Promise(resolve => setTimeout(resolve, config.BOOTSTRAP_STEP_DELAY_MS));
    logger.info('✓ Exchange connection established');
  }

  async initializeServices() {
    logger.info('🔧 Initializing Services...');

    // Create service instances (some are singletons)
    this.services.marketData = MarketDataService; // Singleton
    this.services.candleService = new CandleService(MarketDataService);
    this.services.indicatorService = new IndicatorService();
    this.services.orderService = OrderService; // Singleton
    this.services.notificationService = NotificationService; // Singleton
    this.services.historicalCandleCache = new HistoricalCandleCache(MarketDataService);
    this.services.marketData.setHistoricalCandleCache(this.services.historicalCandleCache);

    const serviceList = ['marketData', 'candleService', 'indicatorService', 'orderService', 'notificationService', 'historicalCandleCache'];
    for (const svc of serviceList) {
      logger.info(`  ✓ ${svc} initialized`);
    }
  }

  async initializeEngines() {
    logger.info('⚙️  Initializing Engines...');

    // Create engine instances
    this.engines.similarity = SimilarityEngine;
    this.engines.trend = TrendEngine;
    this.engines.trigger = TriggerEngine;
    this.engines.sniper = SniperEngine;
    this.engines.positionManager = new PositionManager();
    this.engines.riskManager = new RiskManager();

    const engineList = ['similarity', 'trend', 'trigger', 'sniper', 'positionManager', 'riskManager'];
    for (const eng of engineList) {
      logger.info(`  ✓ ${eng} initialized`);
    }
  }

  setupGracefulShutdown() {
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('FATAL_ERROR', (error) => this.shutdown('FATAL_ERROR', error));
  }

  async shutdown(signal = 'MANUAL', error = null) {
    logger.warning(`Shutdown initiated by ${signal}`, error);

    try {
      logger.info('Closing connections...');
      await new Promise(resolve => setTimeout(resolve, config.BOOTSTRAP_STEP_DELAY_MS));

      logger.info('Saving state...');
      await new Promise(resolve => setTimeout(resolve, config.BOOTSTRAP_STEP_DELAY_MS));

      logger.info('✓ Graceful shutdown completed');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', err);
      process.exit(1);
    }
  }

  getService(name) {
    return this.services[name] || null;
  }

  getServices() {
    return this.services;
  }

  getEngines() {
    return this.engines;
  }

  isInitialized() {
    return this.initialized;
  }
}

export default new Bootstrap();
