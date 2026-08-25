import config from '../config/config.js';
import logger from './logger.js';

const STABLE_BASES = new Set([
  'USDC','FDUSD','TUSD','USDP','DAI','BUSD','USDE','USDS','PYUSD','EUR','TRY'
]);

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class MarketBreadthService {
  constructor(marketData, settings = config) {
    this.marketData = marketData;
    this.settings = settings;
    this.universe = [];
    this.universeCandidateCount = 0;
    this.universeRefreshedAt = 0;
    this.history = [];
    this.current = null;
    this.state24h = 'NEUTRAL';
    this.state15m = 'NEUTRAL';
  }

  classify(upRatio, downRatio, previous) {
    const enter = this.settings.MARKET_BREADTH_ENTER_THRESHOLD_PERCENT;
    const exit = this.settings.MARKET_BREADTH_EXIT_THRESHOLD_PERCENT;
    if (previous === 'UP' && upRatio >= exit) return 'UP';
    if (previous === 'DOWN' && downRatio >= exit) return 'DOWN';
    if (upRatio >= enter) return 'UP';
    if (downRatio >= enter) return 'DOWN';
    return 'NEUTRAL';
  }

  isEligible(coin) {
    const symbol = String(coin?.symbol || '');
    if (!symbol.endsWith('USDT') || symbol === 'BTCUSDT' || symbol === 'ETHUSDT') return false;
    const base = symbol.slice(0, -4);
    return !STABLE_BASES.has(base) && !base.endsWith('UP') && !base.endsWith('DOWN')
      && !base.endsWith('BULL') && !base.endsWith('BEAR');
  }

  async refreshUniverse(now, candidatesOverride = null) {
    if (this.universe.length && now - this.universeRefreshedAt < this.settings.MARKET_BREADTH_UNIVERSE_TTL_MS) {
      return this.universe;
    }
    const candidates = Array.isArray(candidatesOverride)
      ? candidatesOverride
      : await this.marketData.getTop100Coins(
          this.settings.MARKET_BREADTH_TOP_COINS
          * Math.max(1, Number(this.settings.MARKET_BREADTH_CANDIDATE_MULTIPLIER) || 2)
        );
    this.universeCandidateCount = candidates.length;
    this.universe = candidates.filter((coin) => this.isEligible(coin))
      .slice(0, this.settings.MARKET_BREADTH_TOP_COINS);
    this.universeRefreshedAt = now;
    return this.universe;
  }

  async mapConcurrent(items, worker) {
    const output = [];
    let cursor = 0;
    const runners = Array.from(
      { length: Math.min(this.settings.MARKET_BREADTH_15M_CONCURRENCY, items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor++;
          try { output[index] = await worker(items[index]); } catch { output[index] = null; }
        }
      }
    );
    await Promise.all(runners);
    return output;
  }

  summarize(rows, previousState, period) {
    const valid = rows.filter((row) => row && Number.isFinite(row.returnPercent));
    const flat = this.settings.MARKET_BREADTH_FLAT_THRESHOLD_PERCENT;
    let up = 0, down = 0, totalWeight = 0, upWeight = 0, downWeight = 0;
    for (const row of valid) {
      const weight = Math.sqrt(Math.max(0, Number(row.volume24h) || 0));
      totalWeight += weight;
      if (row.returnPercent > flat) { up += 1; upWeight += weight; }
      else if (row.returnPercent < -flat) { down += 1; downWeight += weight; }
    }
    const count = valid.length;
    const flatCount = Math.max(0, count - up - down);
    const upRatio = count ? up * 100 / count : 0;
    const downRatio = count ? down * 100 / count : 0;
    const state = count >= this.settings.MARKET_BREADTH_MIN_VALID_COINS
      ? this.classify(upRatio, downRatio, previousState)
      : 'INVALID';
    return {
      period, state, validCoins: count, upCount: up, downCount: down, flatCount, upRatio, downRatio,
      volumeWeightedUpRatio: totalWeight ? upWeight * 100 / totalWeight : 0,
      volumeWeightedDownRatio: totalWeight ? downWeight * 100 / totalWeight : 0,
      medianReturnPercent: median(valid.map((row) => row.returnPercent))
    };
  }

  async refresh(now = Date.now(), candidates = null) {
    if (this.current && now - this.current.calculatedAt < this.settings.MARKET_BREADTH_15M_CACHE_TTL_MS) {
      return this.current;
    }
    const universe = await this.refreshUniverse(now, candidates);
    const rows24h = universe.map((coin) => ({
      ...coin,
      returnPercent: Number(coin.priceChangePercent)
    }));
    const rows15m = await this.mapConcurrent(universe, async (coin) => {
      const candles = await this.marketData.getKlines(coin.symbol, '15m', 2);
      if (!Array.isArray(candles) || candles.length < 2) return null;
      const previous = Number(candles.at(-2).close);
      const current = Number(candles.at(-1).close);
      if (!(previous > 0) || !Number.isFinite(current)) return null;
      return { ...coin, returnPercent: ((current - previous) / previous) * 100 };
    });
    const breadth24h = this.summarize(rows24h, this.state24h, '24h');
    const breadth15m = this.summarize(rows15m, this.state15m, '15m');
    this.state24h = breadth24h.state;
    this.state15m = breadth15m.state;
    this.history.push({ at: now, upRatio: breadth15m.upRatio, downRatio: breadth15m.downRatio });
    this.history = this.history.slice(-3);
    const first = this.history[0];
    const momentum = this.history.length > 1 ? breadth15m.upRatio - first.upRatio : 0;
    const stateScore = (state) => state === 'UP' ? 1 : state === 'DOWN' ? -1 : 0;
    const breadthScore = (stateScore(breadth24h.state) * 0.4)
      + (stateScore(breadth15m.state) * 0.6);
    this.current = {
      mode: 'WEIGHTED_TREND',
      calculatedAt: now,
      targetUniverseSize: this.settings.MARKET_BREADTH_TOP_COINS,
      candidateUniverseSize: this.universeCandidateCount,
      universeSize: universe.length,
      breadth24h,
      breadth15m,
      momentum,
      score: Math.max(-1, Math.min(1, breadthScore))
    };
    logger.info('Weighted market breadth refreshed', this.current);
    return this.current;
  }

  evaluate(signal, now = Date.now()) {
    const snapshot = this.current;
    const direction = signal === 'BUY' ? 'UP' : 'DOWN';
    const opposite = direction === 'UP' ? 'DOWN' : 'UP';
    let verdict = 'WOULD_CONFIRM';
    let reason = 'BREADTH_ALIGNED_OR_NEUTRAL';
    if (!snapshot || now - snapshot.calculatedAt > this.settings.MARKET_BREADTH_MAX_RESULT_AGE_MS) {
      verdict = 'WOULD_VETO'; reason = 'BREADTH_MISSING_OR_STALE';
    } else if (snapshot.breadth15m.state === opposite) {
      verdict = 'WOULD_VETO'; reason = '15M_BREADTH_OPPOSES_ENTRY';
    } else if (snapshot.breadth15m.state === 'INVALID') {
      verdict = 'WOULD_VETO'; reason = '15M_BREADTH_INVALID';
    } else if (snapshot.breadth24h.state === opposite && snapshot.breadth15m.state !== direction) {
      verdict = 'WOULD_VETO'; reason = '24H_AND_15M_NOT_SUPPORTIVE';
    }
    return { mode: 'WEIGHTED_TREND', verdict, reason, signal, ...snapshot };
  }
}

export default MarketBreadthService;
