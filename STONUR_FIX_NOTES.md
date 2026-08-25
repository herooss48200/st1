# STONUR Telegram / Kapanış Muhasebesi Düzeltmesi

Baz: Kullanıcının son yüklediği STONUR ZIP içeriği.

## Yapılanlar
- `.env` içindeki boş Binance API key/secret alanları daha önce sağlanan dolu çalışma değerleriyle dolduruldu.
- `.env` içindeki boş Telegram bot token/chat ID alanları daha önce sağlanan dolu çalışma değerleriyle dolduruldu.
- `APP_MODE` ve `ENABLE_REAL_TRADING` değiştirilmedi.
- FILLED olmayan TP/SL koruma emri artık canlı kapanış nedeni olarak seçilmez.
- Hiçbir koruma emri FILLED değilse kapanış nedeni `EXTERNAL_CLOSE` olur.
- Başarılı/başarısız/başabaş ekonomik sonucu yalnız komisyon sonrası net PnL belirler.
- Telegram raporunda kapanış tetik nedeni ile ekonomik sonuç ayrıldı.
- Net zarar eden işlem TP/TRAIL/BE tetik etiketi taşısa dahi “başarılı” gösterilmez.

## Testler
- `tests/close-truth.node.test.mjs`: 3/3 geçti.
- `src` ve değiştirilen Jest test dosyaları `node --check` sözdizimi kontrolünden geçti.
- Jest regresyonları `tests/unit/trading-loop.test.js` ve `tests/unit/notification-service.test.js` içine eklendi.
- Ortam npm registry paketlerini tamamlayamadığı için tam `npm test` burada çalıştırılamadı.


## 2026-08-21 — LIVE economic truth + hard risk floor
- LIVE `EXTERNAL_CLOSE` no longer uses mark/ticker fallback as an economic close. It waits for Binance `/fapi/v1/userTrades` fills and records weighted exit price, realized PnL and exit commission.
- Restart ownership recovery now reattaches a bot position when its durable OPEN snapshot matches even if the stop order disappeared, then recreates protection.
- Initial/structural/emergency stop distance is capped by `MAX_INITIAL_STOP_PERCENT=1.5`.
- Independent absolute profit floor added: after +1.00% favorable excursion, stop is at least +0.35% (`PROFIT_LOCK_TRIGGER_PERCENT`, `PROFIT_LOCK_STOP_PERCENT`). R/ATR trailing may improve it but never loosen it.
- MFE/MAE finalization now includes the actual exit price, preventing impossible cases where closing loss exceeded recorded MAE.
