# ST1 R42 — Basit 15m Renko + RSI

ST1'in aktif giriş mantığı kapanmış 15 dakikalık mumlardan üretilen Renko tuğlalarına dayanır. `T`, ilgili coinin 15m ATR(14) değerinden hesaplanan Renko tuğla boyudur.

## Giriş kuralları

- LONG pusu: son kapanan Renko tuğlası kırmızı, tuğlanın Renko RSI(14) değeri kesinlikle `30'dan küçük` ve tuğla alt Bollinger bandına değmiş/geçmiş veya en fazla `0.25T` yaklaşmış olmalıdır.
- LONG emir: canlı fiyat bu kırmızı tuğlanın en yüksek fiyatını `0.25T` eklenmiş seviyenin kesinlikle üzerine geçince açılır.
- SHORT pusu: son kapanan Renko tuğlası yeşil, tuğlanın Renko RSI(14) değeri kesinlikle `70'ten büyük` ve tuğla üst Bollinger bandına değmiş/geçmiş veya en fazla `0.25T` yaklaşmış olmalıdır.
- SHORT emir: canlı fiyat bu yeşil tuğlanın en düşük fiyatından `0.25T` çıkarılmış seviyenin kesinlikle altına geçince açılır.

`RSI = 30`, `RSI = 70` veya canlı fiyatın tam tetik seviyesine eşit olması giriş için yeterli değildir.

BTC/ETH trendi, benzerlik, breadth, EMA, SuperTrend, mum rengi teyidi, formasyon, 1 dakikalık teyit, minimum risk/getiri ve net avantaj kontrolleri R42 giriş yolunda kullanılmaz. Geçerli veri, hariç tutulan sembol, aynı coinde açık pozisyon, pozisyon boyutlandırma ve hesap güvenlik limitleri korunur.

## Paper / ileride ilk canlı deneme limitleri

- Kaldıraç: 10x
- Marjin: ISOLATED
- Maksimum pozisyon notional: 50 USDT
- PAPER maksimum eşzamanlı pozisyon: sınır yok (aynı coinde en fazla 1 pozisyon)
- İleride LIVE güvenlik sınırı: 5 eşzamanlı pozisyon
- Hedef işlem riski: 0.75 USDT
- Tarama evreni: hacme göre ilk 300 coin (`TOP_COINS_COUNT=300`).

Detay: `R42-ST1-SIMPLE-RENKO-NOTES.md`.

## Şimdiki çalışma modu

- Varsayılan mod: `paper`
- Gerçek emir: `ENABLE_REAL_TRADING=false`
- Yerel deneme: `npm run paper`
- PAPER: `50 USDT / toplam slot sınırı yok / aynı coinde 1 / 10x`.
- İleride LIVE: `50 USDT / 5 slot / aynı coinde 1 / 10x`. Canlıya geçişte çalışma modu, gerçek-emir yetkisi ve Binance API/IP whitelist ayrıca açılacaktır.
- PAPER modunda Binance API key/secret zorunlu değildir; public Futures market data kullanılır.
