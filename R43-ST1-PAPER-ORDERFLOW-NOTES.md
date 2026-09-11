# ST1 R43 — PAPER Renko Order-Flow Teyidi

## Amaç

Tek ve zayıf karşı-renk Renko hareketlerinde erken giriş yapılmasını ve pusu kurulmadan önce aşılmış seviyelerin kovalanmasını azaltmak.

## LONG

1. Son kapanan 15m kaynaklı Renko tuğlası kırmızı, Renko RSI(14) `<30` ve alt Bollinger mesafesi en fazla `0.25T` olur.
2. Hedef kırmızı tuğla yüksek fiyatı `+0.25T` olarak saklanır.
3. Pusu kurulduktan sonra fiyatın hedefin güvenli tarafında görülmesi zorunludur.
4. Kapanmış 1m mum hedefi aşağıdan yukarı ilk kez geçer.
5. Son üç kapanmış 1m mumda taker alıcı quote-volume oranı en az `0.58` olur.
6. Bu order-flow koşulu iki ardışık kapanmış 1m kontrolde sağlanır.
7. Fiyat hedeften en fazla `0.25T` uzaktayken PAPER pozisyon açılır.

## SHORT

LONG kurallarının tersidir: yeşil Renko, RSI `>70`, üst Bollinger, `brickLow - 0.25T`, yukarıdan aşağı taze 1m geçiş, taker alıcı oranı en fazla `0.42` ve iki ardışık teyit.

## İptal

- Pusu kurulmadan önce aşılmış fiyat doğrudan giriş yaptıramaz.
- Kırılım sonrası 1m kapanış hedefin yanlış tarafına dönerse aynı setup iptal edilir.
- İki teyit üç dakika içinde tamamlanmazsa aynı setup iptal edilir.
- Kapanmış 1m fiyat veya emir anındaki fiyat hedeften `0.25T` fazla kaçarsa işlem kovalanmaz ve setup iptal edilir.
- Yeni bir 15m Renko setup imzası oluşmadan iptal edilen setup yeniden kullanılamaz.

## Güvenlik ve çıkış

- Sürüm kod seviyesinde PAPER-only'dir; LIVE/TESTNET başlangıcını reddeder.
- Emir servisi PAPER-only kilidi altında Binance'e gerçek emir göndermez.
- Kurtarma radarı kapalıdır; deney sonucunu dış müdahaleyle bozmaz.
- Acil/yapısal stop, `%0.5` ilk kâr kilidi ve ATR trailing mantığı değiştirilmemiştir.
