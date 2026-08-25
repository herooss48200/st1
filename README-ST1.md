# ST1 R41.0

Bu proje, doğrulanmış çalışan R40.3 kod ağacı teknik baz alınarak ST1 stratejisi olarak geliştirilmiştir. Proje kimliği bundan sonra ST1'dir.

ST1 aktifken giriş sırası:

`pusu havuzu -> 15m BB setup -> sonraki 15m renk teyidi -> 1/2/3 mum canlı gövde kırılımı -> coin EMA50/200 -> coin SuperTrend -> breadth/risk -> strict BTC15 SuperTrend -> Binance emir`

## Paper / ileride ilk canlı deneme limitleri

- Kaldıraç: 10x
- Marjin: ISOLATED
- Maksimum pozisyon notional: 50 USDT
- PAPER maksimum eşzamanlı pozisyon: sınır yok (aynı coinde en fazla 1 pozisyon)
- İleride LIVE güvenlik sınırı: 5 eşzamanlı pozisyon
- Breadth uyumlu hedef risk: 0.75 USDT
- Breadth NEUTRAL hedef risk: 0.40 USDT
- Breadth ters hedef risk: 0.25 USDT
- BTC EMA50/200 rejimi ve %0.15 geçiş kilidi korunur.
- Tarama evreni: hacme göre ilk 300 coin (`TOP_COINS_COUNT=300`).

Detay: `R41.0-ST1-NOTES.md`.

## Şimdiki çalışma modu

- Varsayılan mod: `paper`
- Gerçek emir: `ENABLE_REAL_TRADING=false`
- Yerel deneme: `npm run paper`
- PAPER: `50 USDT / toplam slot sınırı yok / aynı coinde 1 / 10x`.
- İleride LIVE: `50 USDT / 5 slot / aynı coinde 1 / 10x`. Canlıya geçişte çalışma modu, gerçek-emir yetkisi ve Binance API/IP whitelist ayrıca açılacaktır.
- PAPER modunda Binance API key/secret zorunlu değildir; public Futures market data kullanılır.
