import logger from '../services/logger.js';
import { TradeRepository } from '../repositories/repositories.js';
import config from '../config/config.js';

class TradeSnapshotService {
  constructor() {
    this.repository = new TradeRepository();
    this.snapshotIndex = new Map();
  }

  normalizeTelemetryPatch(snapshot = {}) {
    const normalized = { ...snapshot };
    const numericFields = [
      'sessionStartedAt',
      'targetRiskUsdt',
      'plannedRiskUsdt',
      'executedRiskUsdt',
      'plannedStructuralStopPrice',
      'structuralStopPrice',
      'structuralStopPercent',
      'emergencyStopPrice',
      'configuredMaxNotionalUsdt',
      'plannedNotionalUsdt',
      'executedNotionalUsdt',
      'requestedQuantity',
      'executedQuantity'
    ];

    for (const field of numericFields) {
      if (!Object.prototype.hasOwnProperty.call(normalized, field)) continue;
      if (normalized[field] === null || normalized[field] === '') {
        normalized[field] = null;
        continue;
      }
      const value = Number(normalized[field]);
      normalized[field] = Number.isFinite(value) ? value : null;
    }

    if (Object.prototype.hasOwnProperty.call(normalized, 'sessionId')) {
      normalized.sessionId = normalized.sessionId ? String(normalized.sessionId) : null;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'positionFollowMode')) {
      normalized.positionFollowMode = normalized.positionFollowMode
        ? String(normalized.positionFollowMode).trim().toUpperCase()
        : null;
    }

    return normalized;
  }

  recordEntry(snapshot) {
    try {
      const normalizedSnapshot = this.normalizeTelemetryPatch(snapshot);
      this.repository.create({
        ...normalizedSnapshot,
        btcTrend: normalizedSnapshot.btcTrend || null,
        ethTrend: normalizedSnapshot.ethTrend || null,
        similarityScore: normalizedSnapshot.similarityScore ?? null,
        entryReason: normalizedSnapshot.entryReason || null
      }).then((created) => {
        if (created?.id) {
          this.snapshotIndex.set(snapshot.tradeId, created.id);
        }
      }).catch((error) => {
        logger.warning('Trade snapshot entry record failed', {
          tradeId: snapshot?.tradeId,
          symbol: snapshot?.symbol,
          error: error.message
        });
      });
    } catch (error) {
      logger.warning('Trade snapshot entry record failed', {
        tradeId: snapshot?.tradeId,
        symbol: snapshot?.symbol,
        error: error.message
      });
    }
  }

  recordExit(snapshot) {
    try {
      const indexedId = this.snapshotIndex.get(snapshot.tradeId);
      const updateById = (id) => this.repository.update(id, {
        ...this.normalizeTelemetryPatch(snapshot)
      });

      const handleError = (error) => {
        logger.warning('Trade snapshot exit record failed', {
          tradeId: snapshot?.tradeId,
          symbol: snapshot?.symbol,
          error: error.message
        });
      };

      if (indexedId) {
        updateById(indexedId).catch(handleError);
        return;
      }

      this.repository.getAll()
        .then((snapshots) => snapshots.find((item) => item.tradeId === snapshot.tradeId))
        .then((existing) => {
          if (existing?.id) {
            this.snapshotIndex.set(snapshot.tradeId, existing.id);
            return updateById(existing.id);
          }
          return null;
        })
        .catch(handleError);
    } catch (error) {
      logger.warning('Trade snapshot exit record failed', {
        tradeId: snapshot?.tradeId,
        symbol: snapshot?.symbol,
        error: error.message
      });
    }
  }

  recordProtection(tradeId, data) {
    const indexedId = this.snapshotIndex.get(tradeId);
    const update = (id) => this.repository.update(id, this.normalizeTelemetryPatch(data));
    if (indexedId) {
      update(indexedId).catch((error) => logger.warning('Trade protection snapshot update failed', {
        tradeId,
        error: error.message
      }));
      return;
    }
    this.repository.findByTradeId(tradeId)
      .then((existing) => existing?.id ? update(existing.id) : null)
      .catch((error) => logger.warning('Trade protection snapshot update failed', { tradeId, error: error.message }));
  }

  async hasOpenSnapshotFor(
    symbol,
    side,
    entryPrice = null,
    priceToleranceRatio = config.SNAPSHOT_PRICE_TOLERANCE_RATIO
  ) {
    try {
      const normalizedSymbol = String(symbol || '').toUpperCase();
      const normalizedSide = String(side || '').toUpperCase();
      const targetEntryPrice = Number(entryPrice);
      const trades = await this.repository.getAll();
      const openSnapshots = (Array.isArray(trades) ? trades : []).filter((trade) => !trade.exitTime);

      return openSnapshots.some((trade) => {
        const tradeSymbol = String(trade.symbol || '').toUpperCase();
        const tradeSide = String(trade.side || '').toUpperCase();
        if (tradeSymbol !== normalizedSymbol || tradeSide !== normalizedSide) {
          return false;
        }

        if (!Number.isFinite(targetEntryPrice) || targetEntryPrice <= 0) {
          return true;
        }

        const snapshotEntryPrice = Number(trade.entryPrice);
        if (!Number.isFinite(snapshotEntryPrice) || snapshotEntryPrice <= 0) {
          return false;
        }

        const distanceRatio = Math.abs(snapshotEntryPrice - targetEntryPrice) / Math.max(targetEntryPrice, 1e-12);
        return distanceRatio <= Math.max(0, Number(priceToleranceRatio) || 0);
      });
    } catch (error) {
      logger.warning('Trade snapshot open ownership check failed', {
        symbol,
        side,
        error: error.message
      });
      return false;
    }
  }
}

export { TradeSnapshotService };
export default new TradeSnapshotService();
