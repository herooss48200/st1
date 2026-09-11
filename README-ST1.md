# ST1 R43 — PAPER Renko + RSI + 3m Taker Akışı

ST1'in aktif giriş mantığı kapanmış 15 dakikalık mumlardan üretilen Renko tuğlalarına dayanır. `T`, ilgili coinin 15m ATR(14) değerinden hesaplanan Renko tuğla boyudur.

## Giriş kuralları

- LONG pusu: son kapanan Renko tuğlası kırmızı, tuğlanın Renko RSI(14) değeri kesinlikle `30'dan küçük` ve tuğla alt Bollinger bandına değmiş/geçmiş veya en fazla `0.25T` yaklaşmış olmalıdır.
- LONG teyit: fiyat pusu kurulduktan sonra kırmızı tuğla yüksek fiyatı `+0.25T` seviyesini kapanmış 1m mumla aşağıdan yukarı geçer; son üç 1m mumun taker alıcı oranı en az `%58` olur ve iki ardışık teyit tamamlanır.
- SHORT pusu: son kapanan Renko tuğlası yeşil, tuğlanın Renko RSI(14) değeri kesinlikle `70'ten büyük` ve tuğla üst Bollinger bandına değmiş/geçmiş veya en fazla `0.25T` yaklaşmış olmalıdır.
- SHORT teyit: fiyat pusu kurulduktan sonra yeşil tuğla düşük fiyatı `-0.25T` seviyesini kapanmış 1m mumla yukarıdan aşağı geçer; son üç 1m mumun taker alıcı oranı en fazla `%42` olur ve iki ardışık teyit tamamlanır.

`RSI = 30`, `RSI = 70` veya fiyatın yalnızca anlık olarak tetik seviyesini aşması giriş için yeterli değildir. Teyit üç dakika içinde tamamlanmazsa, fiyat 1m kapanışla geri dönerse veya tetikten `0.25T` fazla uzaklaşırsa aynı kurulum iptal edilir.

BTC/ETH trendi, benzerlik, breadth, EMA, SuperTrend ve formasyon kontrolleri R43 giriş yolunda kullanılmaz. Kurtarma radarı kapalıdır. Geçerli veri, hariç tutulan sembol, aynı coinde açık pozisyon, pozisyon boyutlandırma ve hesap güvenlik limitleri korunur.

## PAPER limitleri

- Kaldıraç: 10x
- Marjin: ISOLATED
- Maksimum pozisyon notional: 50 USDT
- PAPER maksimum eşzamanlı pozisyon: sınır yok (aynı coinde en fazla 1 pozisyon)
- Hedef işlem riski: 0.75 USDT
- Tarama evreni: hacme göre ilk 300 coin (`TOP_COINS_COUNT=300`).

Detay: `R43-ST1-PAPER-ORDERFLOW-NOTES.md`.

## Şimdiki çalışma modu

- Kod zorunlu modu: `paper`
- Gerçek emir: kapalı ve kod seviyesinde kilitli
- Yerel deneme: `npm run paper`
- PAPER: `50 USDT / toplam slot sınırı yok / aynı coinde 1 / 10x`.
- PAPER modunda Binance API key/secret zorunlu değildir; public Futures market data kullanılır.
- `APP_MODE=live`, `ENABLE_REAL_TRADING=true`, `npm run live` ve `npm run testnet` başlatmayı reddeder.
