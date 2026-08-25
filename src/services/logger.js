import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_LEVELS = {
  INFO: 'info',
  WARNING: 'warn',
  ERROR: 'error',
  DEBUG: 'debug'
};

class Logger {
  constructor() {
    this.initializeLogger();
  }

  initializeLogger() {
    const resolveLogFile = (configuredPath) => path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(process.cwd(), configuredPath);
    const parseSize = (value) => {
      const match = String(value).trim().match(/^(\d+(?:\.\d+)?)([kmg])?$/i);
      if (!match) return 10 * 1024 * 1024;
      const multiplier = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase()] || 1;
      return Math.round(Number(match[1]) * multiplier);
    };

    // Console format
    const consoleFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `[${timestamp}] [${level}] ${message}${metaStr ? '\n' + metaStr : ''}`;
      })
    );

    // File format
    const fileFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );

    this.logger = winston.createLogger({
      level: config.LOG_LEVEL || 'info',
      format: fileFormat,
      defaultMeta: { service: 'gptsono' },
      transports: [
        // Console
        new winston.transports.Console({
          format: consoleFormat
        }),
        // File - All logs
        new winston.transports.File({
          filename: resolveLogFile(config.LOG_FILE),
          maxsize: parseSize(config.LOG_MAX_SIZE),
          maxFiles: config.LOG_MAX_FILES || 10
        }),
        // File - Errors only
        new winston.transports.File({
          filename: resolveLogFile(config.LOG_ERROR_FILE),
          level: 'error',
          maxsize: parseSize(config.LOG_MAX_SIZE),
          maxFiles: config.LOG_ERROR_MAX_FILES
        })
      ]
    });
  }

  summarizePositionRiskTrace(message, meta) {
    const isPositionRiskResponse =
      message === '[TRACE][BINANCE] signedRequest.response' &&
      typeof meta?.endpoint === 'string' &&
      meta.endpoint.includes('/positionRisk') &&
      Array.isArray(meta.responseBody);

    if (!isPositionRiskResponse) {
      return meta;
    }

    const openPositions = meta.responseBody
      .filter((position) => Math.abs(Number(position?.positionAmt || 0)) > 0)
      .map((position) => ({
        symbol: position.symbol,
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
        unRealizedProfit: position.unRealizedProfit,
        leverage: position.leverage,
        marginType: position.marginType,
        positionSide: position.positionSide,
        liquidationPrice: position.liquidationPrice
      }));

    return {
      ...meta,
      responseBody: {
        totalSymbols: meta.responseBody.length,
        openPositionCount: openPositions.length,
        openPositions
      }
    };
  }

  info(message, meta = {}) {
    const summarized = this.summarizePositionRiskTrace(message, meta);
    this.logger.info(message, this.sanitizeSecurityData(summarized));
  }

  warning(message, meta = {}) {
    this.logger.warn(message, this.sanitizeSecurityData(meta));
  }

  warn(message, meta = {}) {
    this.warning(message, meta);
  }

  error(message, error = null, meta = {}) {
    const errorMeta = error instanceof Error 
      ? { ...meta, stack: error.stack, errorMessage: error.message }
      : meta;
    this.logger.error(message, this.sanitizeSecurityData(errorMeta));
  }

  critical(message, meta = {}) {
    this.logger.error(message, this.sanitizeSecurityData(meta));
  }

  fatal(message, meta = {}) {
    this.logger.error(message, this.sanitizeSecurityData(meta));
    // Signal fatal error for graceful shutdown
    process.emit('FATAL_ERROR', { message, ...meta });
  }

  debug(message, meta = {}) {
    if (config.NODE_ENV === 'development') {
      this.logger.debug(message, this.sanitizeSecurityData(meta));
    }
  }

  // Security-sensitive logging (masked values)
  securityEvent(message, meta = {}) {
    const sanitized = this.sanitizeSecurityData(meta);
    this.logger.warn(`[SECURITY] ${message}`, sanitized);
  }

  sanitizeSecurityData(data) {
    const sensitive = ['key', 'secret', 'token', 'password', 'apikey', 'authorization', 'signature'];

    const sanitize = (value) => {
      if (Array.isArray(value)) {
        return value.map((item) => sanitize(item));
      }
      if (!value || typeof value !== 'object') {
        return value;
      }

      const sanitized = {};
      for (const [key, item] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        sanitized[key] = sensitive.some((needle) => lowerKey.includes(needle))
          ? '***REDACTED***'
          : sanitize(item);
      }
      return sanitized;
    };

    return sanitize(data);
  }
}

const logger = new Logger();
export default logger;
export { Logger, LOG_LEVELS };
