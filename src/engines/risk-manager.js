import logger from '../services/logger.js';
import { TRADING_CONSTANTS } from '../shared/constants/trading-constants.js';
import config from '../config/config.js';

class RiskManager {
  constructor() {
    this.maxDailyLoss = TRADING_CONSTANTS.MAX_DAILY_LOSS_PERCENT;
    this.maxMonthlyLoss = TRADING_CONSTANTS.MAX_MONTHLY_LOSS_PERCENT;
    this.maxPositionsTotal = TRADING_CONSTANTS.MAX_TOTAL_POSITIONS;
    this.maxPositionsPerCoin = TRADING_CONSTANTS.MAX_POSITIONS_PER_COIN;
    this.accountBaseUsdt = config.RISK_ACCOUNT_BASE_USDT;
    this.maxDailyNetLossUsdt = config.MAX_DAILY_NET_LOSS_USDT;
    this.maxMonthlyNetLossUsdt = config.MAX_MONTHLY_NET_LOSS_USDT;
    this.minRiskRewardRatio = config.PRE_TRADE_MIN_RISK_REWARD_RATIO;
  }

  async validatePosition(coin, context = {}) {
    try {
      const {
        entryPrice,
        stopLoss,
        takeProfit,
        currentPositions = [],
        tradingHistory = []
      } = context;

      if (entryPrice != null && stopLoss != null && takeProfit != null) {
        const validation = await this.validateTrade(
          {
            id: context.positionId || `PRECHECK_${coin}_${Date.now()}`,
            coin,
            entryPrice: Number(entryPrice),
            stopLoss: Number(stopLoss),
            takeProfit: Number(takeProfit)
          },
          currentPositions,
          tradingHistory
        );

        return {
          allowed: validation.approved,
          reason: validation.reason,
          checks: validation.checks
        };
      }

      logger.info('✓ Position validation passed', { coin });
      return { allowed: true, reason: 'OK' };
    } catch (error) {
      logger.error('Position validation error', error);
      return { allowed: false, reason: error.message };
    }
  }

  async validateTrade(position, currentPositions, tradingHistory, options = {}) {
    try {
      const checks = {
        positionCount: this.checkPositionCount(currentPositions),
        coinConcentration: this.checkCoinConcentration(position.coin, currentPositions),
        dailyLoss: this.checkDailyLoss(tradingHistory),
        monthlyLoss: this.checkMonthlyLoss(tradingHistory),
        riskReward: this.checkRiskReward(position, options),
        dailyActivity: this.checkDailyActivity(tradingHistory, options)
      };

      const approved = Object.values(checks).every(c => c.passed);

      logger.info('Trade validation', {
        positionId: position.id,
        approved,
        checks
      });

      return {
        approved,
        checks,
        reason: approved ? 'All checks passed' : this.getFailureReason(checks)
      };
    } catch (error) {
      logger.error('Risk validation failed', error);
      throw error;
    }
  }

  checkPositionCount(currentPositions) {
    const count = currentPositions.length;
    const unlimitedPaper = String(process.env.APP_MODE || config.APP_MODE || 'paper').toLowerCase() === 'paper'
      && String(process.env.PAPER_UNLIMITED_POSITIONS ?? config.PAPER_UNLIMITED_POSITIONS) === 'true';
    if (unlimitedPaper) {
      return { passed: true, current: count, max: null, unlimited: true };
    }

    const passed = count < this.maxPositionsTotal;
    return { passed, current: count, max: this.maxPositionsTotal, unlimited: false };
  }

  checkCoinConcentration(coin, currentPositions) {
    const coinCount = currentPositions.filter(p => p.coin === coin).length;
    const passed = coinCount < this.maxPositionsPerCoin;
    return {
      passed,
      coin,
      count: coinCount,
      max: this.maxPositionsPerCoin
    };
  }

  checkDailyLoss(tradingHistory) {
    const today = new Date().toDateString();
    const todayTrades = tradingHistory.filter((t) => {
      const closedAt = t.closedAt || t.exitTime;
      if (!closedAt) return false;
      return new Date(closedAt).toDateString() === today;
    });

    let netPnl = 0;
    todayTrades.forEach((t) => {
      const pnl = Number(
        t.profitLoss ??
        t.netPnlForTradeSizeUsdt ??
        t.netPnl ??
        t.pnl ??
        0
      );
      if (Number.isFinite(pnl)) netPnl += pnl;
    });

    const netLossUsdt = Math.max(0, -netPnl);
    const lossPercent = netLossUsdt / this.accountBaseUsdt * 100;
    const passed = netLossUsdt < this.maxDailyNetLossUsdt;

    return {
      passed,
      lossPercent: lossPercent.toFixed(2),
      netPnlUsdt: Number(netPnl.toFixed(8)),
      netLossUsdt: Number(netLossUsdt.toFixed(8)),
      maxNetLossUsdt: this.maxDailyNetLossUsdt,
      max: this.maxDailyLoss
    };
  }

  checkMonthlyLoss(tradingHistory) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const monthTrades = tradingHistory.filter((t) => {
      const closedAt = t.closedAt || t.exitTime;
      if (!closedAt) return false;
      return new Date(closedAt) >= monthStart;
    });

    let netPnl = 0;
    monthTrades.forEach((t) => {
      const pnl = Number(
        t.profitLoss ??
        t.netPnlForTradeSizeUsdt ??
        t.netPnl ??
        t.pnl ??
        0
      );
      if (Number.isFinite(pnl)) netPnl += pnl;
    });

    const netLossUsdt = Math.max(0, -netPnl);
    const lossPercent = netLossUsdt / this.accountBaseUsdt * 100;
    const passed = netLossUsdt < this.maxMonthlyNetLossUsdt;

    return {
      passed,
      lossPercent: lossPercent.toFixed(2),
      netPnlUsdt: Number(netPnl.toFixed(8)),
      netLossUsdt: Number(netLossUsdt.toFixed(8)),
      maxNetLossUsdt: this.maxMonthlyNetLossUsdt,
      max: this.maxMonthlyLoss
    };
  }

  checkRiskReward(position, options = {}) {
    const minRequired = Number.isFinite(Number(options.minRiskRewardRatio))
      ? Number(options.minRiskRewardRatio)
      : this.minRiskRewardRatio;
    const risk = Math.abs(position.entryPrice - position.stopLoss);
    const grossReward = Math.abs(position.takeProfit - position.entryPrice);
    const estimatedCosts = Math.max(0, Number(options.estimatedCostsPerUnit) || 0);
    const reward = Math.max(0, grossReward - estimatedCosts);
    const ratio = risk > 0 ? reward / risk : 0;
    const epsilon = Math.max(0, Number(config.RISK_REWARD_EPSILON) || 0);
    const passed = risk > 0 && ratio + epsilon >= minRequired;

    return {
      passed,
      risk: risk.toFixed(8),
      grossReward: grossReward.toFixed(8),
      estimatedCosts: estimatedCosts.toFixed(8),
      reward: reward.toFixed(8),
      ratio: ratio.toFixed(2),
      ratioRaw: ratio,
      ratioDisplay: ratio.toFixed(8),
      minRequired
    };
  }

  checkDailyActivity(tradingHistory, options = {}) {
    const today = new Date().toDateString();
    const todayTrades = tradingHistory.filter((trade) => {
      const at = trade.closedAt || trade.exitTime || trade.enteredAt;
      return at && new Date(at).toDateString() === today;
    });
    const commission = todayTrades.reduce((sum, trade) => sum + Number(trade.totalTradeCommission || 0), 0);
    const turnover = todayTrades.reduce((sum, trade) => sum + Number(trade.turnoverUsdt || 0), 0);
    const projectedTrades = todayTrades.length + 1;
    const projectedCommission = commission + Number(options.projectedCommissionUsdt || 0);
    const projectedTurnover = turnover + Number(options.projectedTurnoverUsdt || 0);
    const subchecks = {
      trades: {
        passed: projectedTrades <= config.MAX_DAILY_TRADES,
        current: todayTrades.length,
        projected: projectedTrades,
        max: config.MAX_DAILY_TRADES
      },
      commission: {
        passed: projectedCommission <= config.MAX_DAILY_COMMISSION_USDT,
        current: commission,
        projected: projectedCommission,
        max: config.MAX_DAILY_COMMISSION_USDT
      },
      turnover: {
        passed: projectedTurnover <= config.MAX_DAILY_TURNOVER_USDT,
        current: turnover,
        projected: projectedTurnover,
        max: config.MAX_DAILY_TURNOVER_USDT
      }
    };
    const failedLimits = Object.entries(subchecks)
      .filter(([, check]) => !check.passed)
      .map(([name]) => name);

    return {
      passed: failedLimits.length === 0,
      failedLimits,
      subchecks,
      trades: todayTrades.length,
      commission: projectedCommission,
      turnover: projectedTurnover
    };
  }

  getFailureReason(checks) {
    for (const [key, value] of Object.entries(checks)) {
      if (!value.passed) {
        if (key === 'dailyActivity' && Array.isArray(value.failedLimits) && value.failedLimits.length > 0) {
          return `Failed: dailyActivity.${value.failedLimits.join('+')}`;
        }
        return `Failed: ${key}`;
      }
    }
    return 'Unknown reason';
  }
}

export { RiskManager };
export default new RiskManager();
