# STONURV.003 — FIXED 100 USDT / ISOLATED / 10X / 15 SLOT

Yeni açılacak gerçek MARKET pozisyonları için:
- Sabit hedef notional: 100 USDT (`TRADE_SIZE_USDT=100`)
- Margin mode: ISOLATED
- Leverage: 10x (`LEVERAGE=10`)
- Maksimum eşzamanlı pozisyon: 15 (`MAX_POSITIONS=15`)
- Binance quantity-step nedeniyle gerçekleşen notional 100 USDT'nin çok az altında olabilir.
- Mevcut açık pozisyonlar değiştirilmez.
- Aynı sembolde ikinci pozisyon açılmaz.
- ISOLATED veya 10x Binance tarafında uygulanamaz/doğrulanamazsa yeni giriş fail-closed reddedilir.
- Stop/TP/trailing/BE ve FINAL DIRECTIONAL GATE / RESCUE mantığı korunmuştur.

Not: RISK_PER_TRADE_USDT ve breadth risk değerleri raporlama/karar bağlamında korunur; yeni giriş notionalını küçültmez. Gerçek parasal stop riski, 100 USDT notional × yapısal stop yüzdesidir.
