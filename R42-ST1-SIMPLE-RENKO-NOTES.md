# ST1 R42 — Basit Renko Giriş Mantığı

## Veri ve göstergeler

- Kaynak: yalnızca kapanmış 15 dakikalık mumlar.
- Renko tuğla boyu `T`: 15m ATR(14).
- Renko: bir kutu devam, iki kutu dönüş mantığı.
- Bollinger: Renko kapanışları, periyot 20, standart sapma 2.
- RSI: Renko kapanışları, Wilder RSI(14).

## LONG

1. Son kapanan Renko tuğlası kırmızı olmalı.
2. Aynı tuğladaki RSI kesinlikle `30'dan küçük` olmalı.
3. Tuğla alt Bollinger bandına değmeli/geçmeli veya banda en fazla `0.25T` uzakta olmalı.
4. Coin pusuya alınır.
5. Giriş seviyesi: `kırmızı tuğla yüksek fiyatı + 0.25T`.
6. Canlı fiyat giriş seviyesinin kesinlikle üzerine geçince LONG açılır.

## SHORT

1. Son kapanan Renko tuğlası yeşil olmalı.
2. Aynı tuğladaki RSI kesinlikle `70'ten büyük` olmalı.
3. Tuğla üst Bollinger bandına değmeli/geçmeli veya banda en fazla `0.25T` uzakta olmalı.
4. Coin pusuya alınır.
5. Giriş seviyesi: `yeşil tuğla düşük fiyatı - 0.25T`.
6. Canlı fiyat giriş seviyesinin kesinlikle altına geçince SHORT açılır.

## Kaldırılan giriş filtreleri

BTC/ETH trendi, benzerlik, market breadth, EMA, SuperTrend, sonraki mum rengi, formasyon, bir dakikalık teyit, minimum risk/getiri ve tahmini net avantaj R42 giriş kararına dahil değildir.

Operasyonel kontroller korunur: geçerli piyasa verisi, hariç tutulan sembol, aynı coinde tek pozisyon, pozisyon boyutlandırma, günlük/aylık zarar ve aktivite limitleri, emir ve koruma mekanikleri.
