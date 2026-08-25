import logger from '../services/logger.js';
import { ERROR_TYPE } from '../shared/types/index.js';
import config from '../config/config.js';

class ErrorManager {
  constructor() {
    this.errorCount = new Map();
    this.maxRetries = config.RECOVERY_MAX_RETRIES;
  }

  async handle(error, context = {}) {
    try {
      const errorType = this.classifyError(error);
      const errorKey = `${errorType}:${context.module}`;
      
      const count = (this.errorCount.get(errorKey) || 0) + 1;
      this.errorCount.set(errorKey, count);

      logger.error('Error handled', {
        type: errorType,
        message: error.message,
        module: context.module,
        retryCount: count,
        ...context
      });

      // Determine recovery action
      const recovery = this.getRecoveryStrategy(errorType, count);
      
      if (recovery.action === 'retry') {
        logger.warning('Attempting recovery...', recovery);
        await this.delay(recovery.delay);
        return { action: 'retry', delay: recovery.delay };
      } else if (recovery.action === 'reconnect') {
        logger.warning('Reconnecting...', recovery);
        await this.delay(recovery.delay);
        return { action: 'reconnect', delay: recovery.delay };
      } else if (recovery.action === 'shutdown') {
        logger.critical('Graceful shutdown initiated', recovery);
        return { action: 'shutdown' };
      }

      return { action: 'ignore' };
    } catch (err) {
      logger.fatal('Error handler failed', err);
      throw err;
    }
  }

  classifyError(error) {
    const message = error.message || '';
    
    if (message.includes('validation') || message.includes('required')) {
      return ERROR_TYPE.VALIDATION;
    } else if (message.includes('API') || message.includes('HTTP')) {
      return ERROR_TYPE.EXCHANGE;
    } else if (message.includes('database') || message.includes('SQL')) {
      return ERROR_TYPE.DATABASE;
    } else if (message.includes('network') || message.includes('ECONNREFUSED')) {
      return ERROR_TYPE.NETWORK;
    } else if (message.includes('risk') || message.includes('limit')) {
      return ERROR_TYPE.RISK;
    } else if (message.includes('config') || message.includes('environment')) {
      return ERROR_TYPE.CONFIGURATION;
    }
    return ERROR_TYPE.UNKNOWN;
  }

  getRecoveryStrategy(errorType, retryCount) {
    const basedelay = config.RECOVERY_BASE_DELAY_MS;
    const multiplier = config.RECOVERY_BACKOFF_MULTIPLIER;
    const delayMs = Math.min(
      basedelay * Math.pow(multiplier, retryCount - 1),
      config.RECOVERY_MAX_DELAY_MS
    );

    if (retryCount >= this.maxRetries) {
      return { action: 'shutdown', delay: 0 };
    }

    switch (errorType) {
      case ERROR_TYPE.NETWORK:
      case ERROR_TYPE.EXCHANGE:
        return { action: 'reconnect', delay: delayMs };
      case ERROR_TYPE.DATABASE:
        return { action: 'retry', delay: delayMs };
      case ERROR_TYPE.VALIDATION:
      case ERROR_TYPE.CONFIGURATION:
        return { action: 'shutdown', delay: 0 };
      case ERROR_TYPE.RISK:
        return { action: 'ignore', delay: 0 };
      default:
        return { action: 'ignore', delay: 0 };
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  resetErrorCount(errorKey) {
    this.errorCount.delete(errorKey);
  }
}

export default new ErrorManager();
