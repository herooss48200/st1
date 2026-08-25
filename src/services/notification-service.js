import axios from 'axios';
import config from '../config/config.js';
import logger from './logger.js';

export class NotificationService {
  constructor() {
    this.logger = logger;
    this.config = config;
    this.botToken = this.config.TELEGRAM_BOT_TOKEN;
    this.chatId = this.config.TELEGRAM_CHAT_ID;
    this.telegramUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.performanceReportMessageId = null;
  }

  static getInstance() {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  async wait(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async sendMessage(text, parseMode = 'HTML') {
    if (!this.config.ENABLE_TELEGRAM) {
      this.logger.debug('Telegram disabled', { service: 'notification' });
      return false;
    }

    const maxAttempts = Math.max(1, Number(this.config.TELEGRAM_RETRY_ATTEMPTS) || 1);
    const retryDelayMs = Math.max(0, Number(this.config.TELEGRAM_RETRY_DELAY_MS) || 0);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios.post(
          `${this.telegramUrl}/sendMessage`,
          {
            chat_id: this.chatId,
            text,
            parse_mode: parseMode,
            disable_web_page_preview: true,
          },
          { timeout: this.config.TELEGRAM_REQUEST_TIMEOUT_MS }
        );

        if (response?.data?.ok) {
          this.logger.debug('Telegram message sent', { service: 'notification', attempt });
          return true;
        }

        throw new Error(response?.data?.description || 'Telegram API returned ok=false');
      } catch (error) {
        this.logger.warning('Telegram send warning', {
          service: 'notification',
          attempt,
          maxAttempts,
          error: error?.response?.data?.description || error.message,
        });
        if (attempt < maxAttempts) await this.wait(retryDelayMs);
      }
    }

    return false;
  }

  async sendBootMessage(status = {}) {
    const bootTime = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    const mode = this.config.APP_MODE.toUpperCase();
    const env = this.config.NODE_ENV === 'production' ? 'Production' : 'Development';
    const loaded = Number.isInteger(status.loaded) ? status.loaded : 0;
    const total = Number.isInteger(status.total) ? status.total : loaded;

    const text = `
🚀 <b>ST1 PAPER Başlatıldı</b>
━━━━━━━━━━━━━━━━━━━━
📅 Saat: ${bootTime}
🔧 Mode: <code>${mode}</code>
🌐 Ortam: <code>${env}</code>
⚙️ Services: <code>${loaded}/${total}</code>
✅ Sistem hazır, işlemler başlayacak...
    `;

    return this.sendMessage(text);
  }

  async sendEntry(coin, price, quantity, tp, sl, context = {}) {
    const signal = context.signal === 'SELL' ? 'SHORT' : context.signal === 'BUY' ? 'LONG' : (context.signal || '-');
    const notional = Number(context.notionalUsdt);
    const leverage = Number(context.leverage);
    const tpText = Number.isFinite(Number(tp)) ? Number(tp).toFixed(8) : '-';
    const slText = Number.isFinite(Number(sl)) ? Number(sl).toFixed(8) : '-';
    const text = `
📈 <b>ST1 PAPER POZİSYON AÇILDI</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📍 Yön: <code>${signal}</code>
💵 Entry: <code>${Number(price).toFixed(8)}</code>
📊 Miktar: <code>${Number(quantity).toFixed(4)}</code>
${Number.isFinite(notional) ? `💼 Notional: <code>${notional.toFixed(4)} USDT</code>
` : ''}${Number.isFinite(leverage) ? `⚙️ Kaldıraç: <code>${leverage}x</code>
` : ''}🎯 TP: <code>${tpText}</code>
🛑 SL: <code>${slText}</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;
    return this.sendMessage(text);
  }

  async sendProtectionActivated(coin, context = {}) {
    const signal = context.signal || '-';
    const delaySeconds = Math.max(0, Math.round(Number(context.delayMs) / 1000) || 0);
    const delayMinutes = Math.floor(delaySeconds / 60);
    const remainingSeconds = delaySeconds % 60;
    const delayText = remainingSeconds > 0
      ? `${delayMinutes} dk ${remainingSeconds} sn`
      : `${delayMinutes} dk`;
    const stopPrice = Number(context.stopPrice);
    const profitLockPrice = Number(context.profitLockPrice);
    const entryPrice = Number(context.entryPrice);
    const entryPriceText = Number.isFinite(entryPrice) ? entryPrice.toFixed(8) : '-';
    const interval = context.interval || '15m';
    const lookback = Number(context.lookback) || 20;
    const text = `
🛡️ <b>Pozisyon Koruması Aktif</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📍 Yön: <code>${signal}</code>
💵 Giriş: <code>${entryPriceText}</code>
⏳ Korumasız Süre: <code>${delayText}</code>
📊 Yapı: <code>Son ${lookback} kapanmış ${interval} mum</code>
🛑 Yapısal SL: <code>${stopPrice.toFixed(8)}</code>
🎯 %0,5 Kâr Kilidi Hedefi: <code>${profitLockPrice.toFixed(8)}</code>
ℹ️ Hedefe ulaşınca SL bu seviyeye taşınır ve ATR trailing başlar.
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;

    return this.sendMessage(text);
  }

  async sendExit(coin, entryPrice, exitPrice, pnl, pnlPercent, reason = '-', stats = null, context = {}) {
    const netPnl = Number.isFinite(Number(context.netPnlUsdt)) ? Number(context.netPnlUsdt) : Number(pnl);
    const grossPnl = Number.isFinite(Number(context.grossPnlUsdt)) ? Number(context.grossPnlUsdt) : Number(pnl);
    const commission = Number.isFinite(Number(context.commissionUsdt)) ? Number(context.commissionUsdt) : 0;
    const signal = context.signal === 'SELL' ? 'SHORT' : context.signal === 'BUY' ? 'LONG' : (context.signal || '-');
    const durationMs = Number(context.durationMs);
    let durationText = '-';
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      const totalSeconds = Math.floor(durationMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      durationText = `${hours > 0 ? `${hours} sa ` : ''}${minutes} dk ${seconds} sn`;
    }
    const statsText = stats ? `📊 All-Time: <code>${stats.successful}W / ${stats.failed}L</code>` : '';
    const text = `
📉 <b>ST1 PAPER POZİSYON KAPANDI</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📍 Yön: <code>${signal}</code>
🔼 Entry: <code>${Number(entryPrice).toFixed(8)}</code>
🔽 Exit: <code>${Number(exitPrice).toFixed(8)}</code>
🚪 Kapanış Nedeni: <code>${reason}</code>
💵 Brüt PnL: <code>${grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(4)} USDT</code>
💸 Komisyon: <code>${commission.toFixed(4)} USDT</code>
${netPnl >= 0 ? '✅' : '❌'} Net PnL: <code>${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} USDT (${Number(pnlPercent).toFixed(2)}%)</code>
⏱️ Pozisyonda Kalma: <code>${durationText}</code>
${statsText}
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;
    return this.sendMessage(text);
  }

  async sendAmbush(coin, similarity, metrics) {
    const text = `
🎯 <b>Pusu Oluşturuldu</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📊 BTC Benzerliği: <code>${similarity.toFixed(2)}%</code>
📋 Metrikler:
  • Body: ${metrics.body}%
  • Wick Up: ${metrics.wickUp}%
  • Wick Low: ${metrics.wickLow}%
  • Range: ${metrics.range}%
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;

    return this.sendMessage(text);
  }

  async sendTrigger(coin, triggerType, price) {
    const typeEmoji = triggerType === 'BUY' ? '📈' : '📉';
    const text = `
🔔 <b>Tetik Oluştu</b>
━━━━━━━━━━━━━━━━━━━━
${typeEmoji} Tip: <code>${triggerType}</code>
💰 Coin: <code>${coin}</code>
💵 Fiyat: <code>${price.toFixed(8)}</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;

    return this.sendMessage(text);
  }

  async sendBreakEven(coin, breakEvenPrice, context = {}) {
    const signal = context.signal || '-';
    const triggerPercent = Number.isFinite(context.triggerPercent) ? context.triggerPercent.toFixed(2) : '-';
    const stopStatus = context.stopAdjusted === false ? 'Mevcut stop zaten daha koruyucuydu' : 'Stop BE seviyesine taşındı';
    const text = `
⚖️ <b>Break-Even Aktif</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📍 Yön: <code>${signal}</code>
🚀 BE Tetik: <code>%${triggerPercent}</code>
🛡️ SL (BE): <code>${breakEvenPrice.toFixed(8)}</code>
ℹ️ Durum: <code>${stopStatus}</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;
    return this.sendMessage(text);
  }

  async sendStopUpdate(coin, newStop, context = {}) {
    const signal = context.signal || '-';
    const reason = context.reason || 'PRICE_REVISION';
    const text = `
🛡️ <b>Stop Loss Gerçekten Güncellendi</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📍 Yön: <code>${signal}</code>
🧭 Neden: <code>${reason}</code>
🛡️ Yeni SL: <code>${newStop.toFixed(8)}</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;
    return this.sendMessage(text);
  }

  async sendTrailingActivated(coin, context = {}) {
    const signal = context.signal || '-';
    const currentStop = Number(context.currentStop);
    const stopText = Number.isFinite(currentStop) ? currentStop.toFixed(8) : '-';
    return this.sendMessage(`
🧭 <b>ATR Trailing Aktif</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📍 Yön: <code>${signal}</code>
🛡️ Mevcut SL: <code>${stopText}</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `);
  }

  async sendTakeProfitUpdate(coin, newTakeProfit, context = {}) {
    const signal = context.signal || '-';
    const reason = context.reason || 'ATR_DYNAMIC_TP';
    return this.sendMessage(`
🎯 <b>Take-Profit Güncellendi</b>
━━━━━━━━━━━━━━━━━━━━
💰 Coin: <code>${coin}</code>
📍 Yön: <code>${signal}</code>
🧭 Neden: <code>${reason}</code>
🎯 Yeni TP: <code>${newTakeProfit.toFixed(8)}</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `);
  }

  async sendError(errorType, message) {
    const text = `
❌ <b>Hata Oluştu</b>
━━━━━━━━━━━━━━━━━━━━
🔴 Tip: <code>${errorType}</code>
📋 Mesaj: <code>${message}</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;

    return this.sendMessage(text);
  }

  async sendStatus(uptime, activeTrades, totalProfit) {
    const text = `
📊 <b>Bot Durumu</b>
━━━━━━━━━━━━━━━━━━━━
⏱️ Çalışma Süresi: <code>${uptime}</code>
💼 Açık Pozisyon: <code>${activeTrades}</code>
💹 Toplam Kâr: <code>${totalProfit.toFixed(2)} USDT</code>
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
    `;

    return this.sendMessage(text);
  }

  async sendAmbushSummary(summary = {}) {
    const similarityInterval = summary.similarityInterval || '4h';
    const refreshIntervalMinutes = Number.isFinite(summary.refreshIntervalMinutes) ? summary.refreshIntervalMinutes : 30;
    const status = (summary.status || 'COMPLETED').toUpperCase();
    const targetCoins = Number.isFinite(summary.targetCoins)
      ? summary.targetCoins
      : (Number.isFinite(summary.topCoins) ? summary.topCoins : 0);
    const fetchedCoins = Number.isFinite(summary.fetchedCoins)
      ? summary.fetchedCoins
      : (Number.isFinite(summary.topCoins) ? summary.topCoins : 0);
    const scannedCoins = Number.isFinite(summary.scannedCoins)
      ? summary.scannedCoins
      : (Number.isFinite(summary.topCoins) ? summary.topCoins : 0);
    const qualifiedAmbushes = Number.isFinite(summary.qualifiedAmbushes)
      ? summary.qualifiedAmbushes
      : (Number.isFinite(summary.ambushCount) ? summary.ambushCount : 0);
    const ambushCount = Number.isFinite(summary.ambushCount) ? summary.ambushCount : qualifiedAmbushes;
    const threshold = Number.isFinite(summary.threshold) ? summary.threshold : 0;
    const btcTrend = summary.btcTrend || summary.trend || '-';
    const ethTrend = summary.ethTrend || '-';
    const longCount = Number.isFinite(summary.longCount) ? summary.longCount : 0;
    const shortCount = Number.isFinite(summary.shortCount) ? summary.shortCount : 0;
    const reasonCode = summary.reason || null;
    const breadth15m = summary.breadth15m || null;
    const breadthState = breadth15m?.state || 'UNAVAILABLE';
    const breadthLongCount = Number.isFinite(breadth15m?.upCount) ? breadth15m.upCount : 0;
    const breadthShortCount = Number.isFinite(breadth15m?.downCount) ? breadth15m.downCount : 0;
    const breadthFlatCount = Number.isFinite(breadth15m?.flatCount) ? breadth15m.flatCount : 0;
    const breadthTargetCoins = Number.isFinite(summary.breadthTargetCoins)
      ? summary.breadthTargetCoins
      : Number(config.MARKET_BREADTH_TOP_COINS || 0);
    const breadthValidCoins = Number.isFinite(breadth15m?.validCoins)
      ? breadth15m.validCoins
      : breadthLongCount + breadthShortCount + breadthFlatCount;
    const breadthText = breadth15m
      ? `🌐 Breadth (15m): <code>${breadthState}</code>
📚 Breadth Hedefi: <code>${breadthTargetCoins}</code>
✅ Geçerli Coin: <code>${breadthValidCoins}/${breadthTargetCoins}</code>
🟢 Long Coin: <code>${breadthLongCount}</code> | 🔴 Short Coin: <code>${breadthShortCount}</code> | ⚪ Yatay Coin: <code>${breadthFlatCount}</code>`
      : '🌐 Breadth (15m): <code>VERİ YOK</code>';

    const reasonMap = {
      BTC_TREND_INVALID_OR_SIDEWAYS: 'BTC trendi yatay veya geçersiz olduğu için yeni aday taraması yapılmadı.',
      ETH_TREND_INVALID_OR_SIDEWAYS: 'ETH trendi yatay veya geçersiz olduğu için yeni aday taraması yapılmadı.',
      BTC_ETH_TREND_MISMATCH: 'BTC ve ETH trend yönleri uyuşmadığı için yeni aday taraması yapılmadı.',
      BTC_TREND_DATA_UNAVAILABLE: 'BTC trend verisi yetersiz.',
      ETH_TREND_DATA_UNAVAILABLE: 'ETH trend verisi yetersiz.',
      BTC_SIMILARITY_DATA_UNAVAILABLE: 'BTC benzerlik verisi yetersiz.',
      ETH_SIMILARITY_DATA_UNAVAILABLE: 'ETH benzerlik verisi yetersiz.',
      TOP_COINS_FETCH_FAILED: 'Coin listesi alınamadı.'
    };

    const readableReason = reasonMap[reasonCode] || 'Tarama güvenli şekilde atlandı.';

    let text;
    if (status === 'SKIPPED') {
      text = `
⏭️ <b>Pusu Taraması Atlandı</b>
━━━━━━━━━━━━━━━━━━━━
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
📌 Neden: <code>${readableReason}</code>
⏱️ Periyot: <code>${similarityInterval}</code>
🔁 Yenileme: <code>${refreshIntervalMinutes} dk</code>
📚 Hedef Coin: <code>${targetCoins}</code>
📥 Alınan Coin: <code>${fetchedCoins}</code>
✅ Gerçekten Taranan: <code>${scannedCoins}</code>
📈 BTC Trend: <code>${btcTrend}</code>
📉 ETH Trend: <code>${ethTrend}</code>
${breadthText}
🎯 Mevcut/Aktif Pusu: <code>${ambushCount}</code>
🟢 Long Pusu: <code>${longCount}</code> | 🔴 Short Pusu: <code>${shortCount}</code>
      `;
    } else if (status === 'FAILED') {
      text = `
⚠️ <b>Pusu Taraması Başarısız</b>
━━━━━━━━━━━━━━━━━━━━
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
📌 Neden: <code>${readableReason}</code>
⏱️ Periyot: <code>${similarityInterval}</code>
🔁 Yenileme: <code>${refreshIntervalMinutes} dk</code>
📚 Hedef Coin: <code>${targetCoins}</code>
📥 Alınan Coin: <code>${fetchedCoins}</code>
✅ Gerçekten Taranan: <code>${scannedCoins}</code>
📈 BTC Trend: <code>${btcTrend}</code>
📉 ETH Trend: <code>${ethTrend}</code>
${breadthText}
      `;
    } else {
      text = `
🎯 <b>Pusu Taraması Tamamlandı</b>
━━━━━━━━━━━━━━━━━━━━
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}
⏱️ Periyot: <code>${similarityInterval}</code>
🔁 Yenileme: <code>${refreshIntervalMinutes} dk</code>
📚 Hedef Coin: <code>${targetCoins}</code>
📥 Alınan Coin: <code>${fetchedCoins}</code>
✅ Gerçekten Taranan: <code>${scannedCoins}</code>
📊 Benzerlik Esigi: <code>%${threshold}</code>
📈 BTC Trend: <code>${btcTrend}</code>
📉 ETH Trend: <code>${ethTrend}</code>
${breadthText}
🎯 Toplam Pusu: <code>${qualifiedAmbushes}</code>
🟢 Long Pusu: <code>${longCount}</code> | 🔴 Short Pusu: <code>${shortCount}</code>
      `;
    }

    return this.sendMessage(text);
  }

  async sendSt1EntryAndRescueRadar({ funnel = {}, rescue = null } = {}) {
    if (!this.config.ENABLE_TELEGRAM) return false;
    const fmt = (value, digits = 3) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '-';
    const long = funnel.LONG || {};
    const short = funnel.SHORT || {};
    const pusu = funnel.pusu || { LONG: 0, SHORT: 0 };
    const rejected = Array.isArray(funnel.recentRejections) ? funnel.recentRejections : [];
    const rejectLines = rejected.length > 0
      ? rejected.map((item) => `• ${item.coin} ${item.side} → <code>${item.reason}</code>`).join('\n')
      : '• Yok';
    const r = rescue || {};
    const m = r.metrics || {};
    const level = r.level || 'VERİ_YOK';
    const riskSide = r.riskSide || 'YOK';

    const text = `🔬 <b>ST1 GİRİŞ + KURTARMA RADARI</b>
━━━━━━━━━━━━━━━━━━━━
🕐 Saat: ${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}

<b>GİRİŞ HUNİSİ — SON 15 DK</b>
🟢 LONG: Pusu <code>${pusu.LONG || 0}</code> → Setup <code>${long.setup || 0}</code> → BodyBreak <code>${long.bodyBreak || 0}</code> → Coin EMA/ST <code>${long.coinDirection || 0}</code> → BTC/ETH <code>${long.trendGuard || 0}</code> → Breadth <code>${long.breadth || 0}</code> → Risk <code>${long.risk || 0}</code> → Açılan <code>${long.opened || 0}</code>
🔴 SHORT: Pusu <code>${pusu.SHORT || 0}</code> → Setup <code>${short.setup || 0}</code> → BodyBreak <code>${short.bodyBreak || 0}</code> → Coin EMA/ST <code>${short.coinDirection || 0}</code> → BTC/ETH <code>${short.trendGuard || 0}</code> → Breadth <code>${short.breadth || 0}</code> → Risk <code>${short.risk || 0}</code> → Açılan <code>${short.opened || 0}</code>

🚫 <b>Son Yakın Reddedilenler</b>
${rejectLines}

🛡️ <b>KURTARMA RADARI — ${level}</b>
Risk Altındaki Taraf: <code>${riskSide}</code>
Neden: <code>${r.reason || 'RADAR_CLEAR'}</code>
BTC ST 1/3/5/15: <code>${m.btc1Supertrend || '-'} / ${m.btc3Supertrend || '-'} / ${m.btc5Supertrend || '-'} / ${m.btc15Supertrend || '-'}</code>
BTC 5dk: <code>${fmt(m.btcReturn5mPercent)}%</code> | 10dk: <code>${fmt(m.btcReturn10mPercent)}%</code>
BTC15 Fiyat↔EMA50: <code>${fmt(m.btc15CloseVsEma50Percent)}%</code>
ST1 Karşı SHORT 3m/5m: <code>${m.btc3RawSt1Short ? 'EVET' : 'HAYIR'} / ${m.btc5RawSt1Short ? 'EVET' : 'HAYIR'}</code>
ST1 Karşı LONG 3m/5m: <code>${m.btc3RawSt1Long ? 'EVET' : 'HAYIR'} / ${m.btc5RawSt1Long ? 'EVET' : 'HAYIR'}</code>
Breadth: <code>${m.breadthState || '-'}</code>
Açık LONG: <code>${m.managedLongCount || 0}</code> | Negatif: <code>${fmt((m.negativeLongRatio || 0) * 100, 1)}%</code> | PnL: <code>${fmt(m.longPortfolioPnlUsdt)} USDT</code>
Açık SHORT: <code>${m.managedShortCount || 0}</code> | Negatif: <code>${fmt((m.negativeShortRatio || 0) * 100, 1)}%</code> | PnL: <code>${fmt(m.shortPortfolioPnlUsdt)} USDT</code>

ℹ️ NORMAL/YELLOW/ORANGE: gözlem. RED: yalnız PAPER riskli sepeti kapatır ve RECOVERY kilidi uygular.`;
    return this.sendMessage(text);
  }

  async sendTradeSummary(summary) {
    const opened = summary.opened || [];
    const closed = summary.closed || [];
    const ambushCount = summary.ambushCount || 0;
    const openPositionCount = summary.openPositionCount || 0;
    const stats = summary.stats || {
      total: 0, openedTotal: 0, successful: 0, failed: 0, neutral: 0, breakEven: 0, tp: 0, sl: 0, external: 0,
      tpLong: 0, tpShort: 0, trailLong: 0, trailShort: 0,
      slLong: 0, slShort: 0, beLong: 0, beShort: 0, externalLong: 0, externalShort: 0
    };
    const wallet = summary.wallet || {
      initial: config.NOTIFICATION_DEFAULT_WALLET_USDT,
      current: config.NOTIFICATION_DEFAULT_WALLET_USDT,
      realizedPnl: 0
    };
    const totalCommission = Number.isFinite(summary.commission) ? summary.commission : 0;
    const walletSource = String(wallet.source || 'BOT_LEDGER');
    const walletAvailable = Number(wallet.available);
    const unrealizedPnl = Number(wallet.unrealizedPnl);
    const botRealizedPnl = Number(wallet.realizedPnl);
    const mode = (summary.mode || 'paper').toLowerCase() === 'paper' ? 'SANAL' : (summary.mode || 'paper').toUpperCase();
    const maxPositions = summary.unlimitedPositions === true ? 'SINIRSIZ' : (Number.isFinite(summary.maxPositions) ? summary.maxPositions : 5);
    const ambushDirection = summary.ambushDirection || { longCount: 0, shortCount: 0 };
    const successRate = stats.total > 0 ? (stats.successful / stats.total) * 100 : 0;
    const neutralCount = Number.isFinite(Number(stats.neutral))
      ? Number(stats.neutral)
      : Math.max(0, Number(stats.total || 0) - Number(stats.successful || 0) - Number(stats.failed || 0));
    const session = summary.session || { openedTotal: 0, successful: 0, failed: 0, neutral: 0, netPnlUsdt: 0 };
    const sessionLine = `🧭 ST1 Session: ${Number(session.successful || 0)}W / ${Number(session.failed || 0)}L / ${Number(session.neutral || 0)}BE | Açılan ${Number(session.openedTotal || 0)} | Net ${Number(session.netPnlUsdt || 0) >= 0 ? '+' : ''}${Number(session.netPnlUsdt || 0).toFixed(4)} USDT`;

    const latestOpened = opened.length > 0 ? opened[opened.length - 1] : null;
    const latestClosed = closed.length > 0 ? closed[closed.length - 1] : null;
    const latestOpenedLine = latestOpened
      ? `🆕 Son Açılan: ${latestOpened.coin} ${latestOpened.signal} | Örtüşme: ${Number.isFinite(latestOpened.similarityPercent) ? latestOpened.similarityPercent.toFixed(2) : '-'}%`
      : '🆕 Son Açılan: -';
    const latestClosedLine = latestClosed
      ? (() => {
          const signalLabel = latestClosed.signal === 'BUY' ? '🟢 LONG' : latestClosed.signal === 'SELL' ? '🔴 SHORT' : latestClosed.signal;
          const netPnl = Number.isFinite(latestClosed.netPnlForTradeSizeUsdt) ? latestClosed.netPnlForTradeSizeUsdt : 0;
          const netPnlStr = (netPnl >= 0 ? '+' : '') + netPnl.toFixed(4);
          const entryStr = Number.isFinite(latestClosed.entryPrice) ? latestClosed.entryPrice.toFixed(8) : '-';
          const exitStr = Number.isFinite(latestClosed.exitPrice) ? latestClosed.exitPrice.toFixed(8) : '-';
          const outcomeLabel = netPnl > 0 ? '✅ NET KÂR' : netPnl < 0 ? '❌ NET ZARAR' : '⚖️ NET BAŞABAŞ';
          return `🧾 Son Kapanan:\n${latestClosed.coin} | ${signalLabel}\n🚪 Tetik: ${latestClosed.reason}\n📌 Sonuç: ${outcomeLabel}\n\nEntry : ${entryStr}\nExit  : ${exitStr}\n\nNet PnL : ${netPnlStr} USDT`;
        })()
      : '🧾 Son Kapanan: -';

    const text = `
📊 ST1 PAPER RAPORU
(${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })})
--------------------------------
🧪 Emir Modu: ${mode}
📦 Aktif Pozisyon: ${openPositionCount} / ${maxPositions}
🔄 Toplam Açılan Emir: ${stats.openedTotal}
🎯 Aktif Pusu: ${ambushCount} | 🟢 Long: ${ambushDirection.longCount} | 🔴 Short: ${ambushDirection.shortCount}

✅ NET KÂRLI İŞLEMLER: ${stats.successful}
❌ NET ZARARLI İŞLEMLER: ${stats.failed}
⚖️ NET BAŞABAŞ İŞLEMLER: ${neutralCount}
🏅 KASA BAŞARI ORANI: %${successRate.toFixed(1)}
${sessionLine}

🚪 KAPANIŞ TETİKLERİ (ekonomik sonuç değildir)
   🎯 TP Long: ${stats.tpLong} | 🎯 TP Short: ${stats.tpShort}
   🧲 Trail Long: ${stats.trailLong || 0} | 🧲 Trail Short: ${stats.trailShort || 0}
   ⚖️ BE Long: ${stats.beLong} | ⚖️ BE Short: ${stats.beShort}
   🛑 SL Long: ${stats.slLong} | 🛑 SL Short: ${stats.slShort}
   🚪 Harici Long: ${stats.externalLong || 0} | 🚪 Harici Short: ${stats.externalShort || 0}
--------------------------------
💸 BOT KOMİSYONU: ${totalCommission.toFixed(4)} USDT
💰 BOT NET GERÇEKLEŞMİŞ: ${Number.isFinite(botRealizedPnl) ? botRealizedPnl.toFixed(4) : '0.0000'} USDT
💡 KASA DEĞİŞİMİ: ${(wallet.current - wallet.initial).toFixed(4)} USDT
💼 GÜNCEL KASA: ${wallet.current.toFixed(4)} USDT
${Number.isFinite(walletAvailable) ? `🏦 Kullanılabilir: ${walletAvailable.toFixed(4)} USDT\n` : ''}${Number.isFinite(unrealizedPnl) ? `📈 Açık PnL: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} USDT\n` : ''}🔎 Muhasebe Kaynağı: ${walletSource}
${latestOpenedLine}
${latestClosedLine}`;

    return this.sendMessage(text);
  }

  async sendOrUpdatePerformanceReport(data = {}) {
    if (!this.config.ENABLE_TELEGRAM) {
      this.logger.debug('Telegram disabled', { service: 'notification' });
      return false;
    }

    const stats = data.stats || { successful: 0, failed: 0, breakEven: 0, total: 0 };
    const wallet = data.wallet || { current: 0 };
    const totalCompleted = Number.isFinite(data.totalCompleted) ? data.totalCompleted : (Number.isFinite(stats.total) ? stats.total : 0);
    const successful = Number.isFinite(stats.successful) ? stats.successful : 0;
    const failed = Number.isFinite(stats.failed) ? stats.failed : 0;
    const neutral = Number.isFinite(stats.neutral)
      ? stats.neutral
      : Math.max(0, totalCompleted - successful - failed);
    const successRate = totalCompleted > 0 ? (successful / totalCompleted) * 100 : 0;
    const netPnl = Number.isFinite(data.netPnl) ? data.netPnl : 0;
    const totalCommission = Number.isFinite(data.totalCommission) ? data.totalCommission : 0;
    const currentWallet = Number.isFinite(wallet.current) ? wallet.current : 0;
    const availableWallet = Number(wallet.available);
    const unrealizedPnl = Number(wallet.unrealizedPnl);
    const walletSource = String(wallet.source || 'BOT_LEDGER');
    const openPositionCount = Number.isFinite(data.openPositionCount) ? data.openPositionCount : 0;
    const ambushCount = Number.isFinite(data.ambushCount) ? data.ambushCount : 0;
    const uptime = data.uptime || '0s 0dk';
    const session = data.session || {};
    const sessionOpened = Number.isFinite(session.openedTotal) ? session.openedTotal : 0;
    const sessionSuccessful = Number.isFinite(session.successful) ? session.successful : 0;
    const sessionFailed = Number.isFinite(session.failed) ? session.failed : 0;
    const sessionNeutral = Number.isFinite(session.neutral) ? session.neutral : 0;
    const sessionNetPnl = Number.isFinite(session.netPnlUsdt) ? session.netPnlUsdt : 0;

    const text = `📈 ST1 PAPER PERFORMANS

⏱ Çalışma Süresi
${uptime}

🔄 ST1 SESSION
Açılan: ${sessionOpened}
Sonuç: ${sessionSuccessful}W / ${sessionFailed}L / ${sessionNeutral}BE
Net: ${sessionNetPnl >= 0 ? '+' : ''}${sessionNetPnl.toFixed(4)} USDT

📈 ALL-TIME Tamamlanan İşlem
${totalCompleted}

✅ Başarılı
${successful}

❌ Başarısız
${failed}

⚖️ Net Başabaş
${neutral}

🏆 Başarı Oranı
${successRate.toFixed(2)} %

💰 Net PnL
${netPnl.toFixed(4)} USDT

💸 Toplam Komisyon
${totalCommission.toFixed(4)} USDT

💼 Güncel Kasa
${currentWallet.toFixed(4)} USDT

${Number.isFinite(availableWallet) ? `🏦 Kullanılabilir\n${availableWallet.toFixed(4)} USDT\n\n` : ''}${Number.isFinite(unrealizedPnl) ? `📈 Açık PnL\n${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(4)} USDT\n\n` : ''}🔎 Muhasebe Kaynağı
${walletSource}

📦 Açık Pozisyon
${openPositionCount}

🎯 Aktif Pusu
${ambushCount}

🕒 Son Güncelleme
${new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;

    try {
      if (!this.performanceReportMessageId) {
        const response = await axios.post(
          `${this.telegramUrl}/sendMessage`,
          {
            chat_id: this.chatId,
            text,
            disable_web_page_preview: true,
          },
          { timeout: config.TELEGRAM_REQUEST_TIMEOUT_MS }
        );

        if (response?.data?.ok) {
          this.performanceReportMessageId = response.data?.result?.message_id || null;
          
          if (this.performanceReportMessageId) {
            try {
              await axios.post(
                `${this.telegramUrl}/pinChatMessage`,
                {
                  chat_id: this.chatId,
                  message_id: this.performanceReportMessageId,
                  disable_notification: true,
                },
                { timeout: config.TELEGRAM_REQUEST_TIMEOUT_MS }
              );
            } catch (pinError) {
              this.logger.warning('Telegram pin message warning', {
                service: 'notification',
                error: pinError.message,
              });
            }
          }
          
          return true;
        }

        return false;
      }

      const response = await axios.post(
        `${this.telegramUrl}/editMessageText`,
        {
          chat_id: this.chatId,
          message_id: this.performanceReportMessageId,
          text,
          disable_web_page_preview: true,
        },
        { timeout: config.TELEGRAM_REQUEST_TIMEOUT_MS }
      );

      return Boolean(response?.data?.ok);
    } catch (error) {
      const errorMsg = error?.response?.data?.description || error.message;
      
      this.logger.warning('Telegram performance report warning', {
        service: 'notification',
        error: error.message,
        response: error?.response?.data,
      });
      
      if (
        errorMsg.includes('message to edit not found') ||
        errorMsg.includes("message can't be edited") ||
        errorMsg.includes('message not found')
      ) {
        this.performanceReportMessageId = null;
        
        try {
          const newResponse = await axios.post(
            `${this.telegramUrl}/sendMessage`,
            {
              chat_id: this.chatId,
              text,
              disable_web_page_preview: true,
            },
            { timeout: config.TELEGRAM_REQUEST_TIMEOUT_MS }
          );
          
          if (newResponse?.data?.ok) {
            this.performanceReportMessageId = newResponse.data?.result?.message_id || null;
            
            if (this.performanceReportMessageId) {
              try {
                await axios.post(
                  `${this.telegramUrl}/pinChatMessage`,
                  {
                    chat_id: this.chatId,
                    message_id: this.performanceReportMessageId,
                    disable_notification: true,
                  },
                  { timeout: config.TELEGRAM_REQUEST_TIMEOUT_MS }
                );
              } catch (pinError) {
                this.logger.warning('Telegram pin message warning', {
                  service: 'notification',
                  error: pinError.message,
                });
              }
            }
            
            return true;
          }
        } catch (retryError) {
          this.logger.warning('Telegram retry send warning', {
            service: 'notification',
            error: retryError.message,
          });
        }
      }
      
      return false;
    }
  }
}

export default NotificationService.getInstance();

