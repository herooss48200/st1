# ORDER SERVICE AUDIT

## Kapsam

İncelenen dosyalar:

- `src/services/order-service.js`
- `src/trading-loop.js`
- `src/engines/position-manager.js`

Bu raporda **kod değiştirilmemiştir**. Amaç, canlı Binance Futures entegrasyonundaki HTTP 400 hatalarının muhtemel gerçek nedenlerini ve riskli noktaları tespit etmektir.

---

## Sonuç Özeti

### En kritik bulgu

**Position Sync sırasında görülen HTTP 400 hatasının en güçlü muhtemel sebebi, `STOP_MARKET` ve `TAKE_PROFIT_MARKET` emirleri oluşturulurken aynı request içinde hem `closePosition=true` hem de `reduceOnly=true` gönderilmesidir.**

- Çağrı zinciri:
  - `src/trading-loop.js:1005-1076` `syncLiveOpenPositionsOnStart()` → `fetchLiveOpenPositions()`
  - `src/trading-loop.js:1072` `ensureProtectionOrders(position)`
  - `src/trading-loop.js:626-643` `createStopLossOrder()` / `createTakeProfitOrder()`
  - `src/services/order-service.js:274-299`
  - `src/services/order-service.js:148-185`
  - `src/services/order-service.js:232` `POST /fapi/v1/order`

Binance Futures `closePosition=true` kullanılan `STOP_MARKET` / `TAKE_PROFIT_MARKET` emirlerinde **`reduceOnly` alanını birlikte kabul etmeyebilir**. Bu durumda tipik sonuç HTTP 400 olur.

### İkinci kritik bulgular

1. **`stopPrice` ve `price` için tick-size / precision normalizasyonu yok.**
2. **Entry order gerçekten FILLED mı kontrol edilmeden TP/SL oluşturuluyor.**
3. **Position Sync hatası logda GET kaynaklı gibi görünse de gerçek hata çoğunlukla startup sırasında atılan koruma emirlerinden geliyor olabilir.**
4. **OrderService catch blokları Binance hata detaylarını loglamıyor; bu yüzden 400’ün gerçek nedeni görünmüyor.**

---

## Öncelik Sırasına Göre Problemler

| Öncelik | Fonksiyon | Satır | Endpoint | Method | Problem | Muhtemel Sonuç |
|---|---|---:|---|---|---|---|
| Kritik | `createStopLossOrder()` / `createTakeProfitOrder()` + `buildOrderParams()` | `order-service.js:156-176, 274-299` | `/fapi/v1/order` | `POST` | `closePosition=true` ile birlikte `reduceOnly=true` gönderiliyor | HTTP 400, Binance parametre uyuşmazlığı |
| Kritik | `syncLiveOpenPositionsOnStart()` → `fetchLiveOpenPositions()` → `ensureProtectionOrders()` | `trading-loop.js:1005-1076, 610-652` | `/fapi/v1/order` | `POST` | Startup sync sırasında var olan pozisyonlara hemen koruma emri basılıyor; hata burada oluşursa tüm sync “position sync failed” gibi raporlanıyor | 400 kaynağının yanlış yerde sanılması |
| Yüksek | `buildOrderParams()` | `order-service.js:162-166` | `/fapi/v1/order` | `POST` | `price` / `stopPrice` için symbol tick-size normalizasyonu yok | Precision/invalid price kaynaklı 400 |
| Yüksek | `enterPosition()` | `trading-loop.js:442-477` | `/fapi/v1/order` | `POST` | Entry response başarılı diye kabul ediliyor; FILLED / executedQty doğrulanmadan TP/SL oluşturuluyor | Eksik dolumda yanlış koruma emri, 400 veya mantık bozulması |
| Orta | `getApiCredentials()` | `order-service.js:28-35` | Tüm signed endpointler | Çeşitli | `config.getApiCredentials()` yerine doğrudan live key alanları kullanılıyor | Testnet/live karışıklığında yanlış key ile istek |
| Orta | `signedRequest()` | `order-service.js:37-60` | Tüm signed endpointler | Çeşitli | `undefined` değerleri temizleyen bir guard yok | `symbol=undefined` gibi bozuk query ile 400 ihtimali |
| Orta | Catch blokları | `order-service.js:268-270, 349-351` | Tüm endpointler | Çeşitli | HTTP status / Binance code / body / request query loglanmıyor | Gerçek 400 sebebi görünmüyor |
| Düşük | `position-manager.js` | `position-manager.js:24-35, 60-75, 104-113` | - | - | `direction=LONG/SHORT` bekliyor, trading-loop ise `signal=BUY/SELL` kullanıyor | REST 400 değil, ama entegrasyon uyumsuzluğu |

---

## Görev 1-2: OrderService REST Denetimi

## `signedRequest()`

- **Satır:** `src/services/order-service.js:37-60`
- **Amaç:** Tüm signed Binance Futures çağrılarını gönderiyor.
- **Endpoint/Method:** Parametreye bağlı
- **İnceleme:**
  - `timestamp` ekleniyor: **doğru**
  - `recvWindow=5000` ekleniyor: **doğru**
  - HMAC SHA256 signature: **doğru yaklaşım**
  - Query string imzalanıp URL’ye ekleniyor: **Binance ile uyumlu**
- **Risk:**
  - `params` içindeki `undefined` / boş değerler ayıklanmıyor.
  - `URLSearchParams` ile `undefined` değerler `"undefined"` stringine dönüşebilir.
- **Muhtemel 400 sebebi:**
  - `symbol=undefined`
  - `orderId=undefined`
  - yanlış veya boş parametrelerin query’ye düşmesi
- **Sonuç:** Signature mantığı doğru; ama **request payload sanitization eksik**.

## `placeOrder()`

- **Satır:** `src/services/order-service.js:187-272`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **İnceleme:**
  - Quantity önce normalize ediliyor: **iyi**
  - `MARKET` order için `newOrderRespType=RESULT` veriliyor: **uygun**
  - Request tekrar deneme mantığı var: **var**
- **Risk:**
  - Deterministic 400 hatalarında da retry yapıyor; kök neden değişmediği halde tekrar deniyor.
  - Catch bloğu yalnız `error.message` logluyor.
- **Beklenen Binance formatı:**
  - `symbol`, `side`, `type` zorunlu
  - tip bazlı alanlar (`quantity`, `stopPrice`, `closePosition`) uyumlu olmalı
- **Sonuç:** Temel akış doğru, fakat **hatalı parametre kombinasyonları yukarıdan geldiğinde placeOrder bunları engellemiyor**.

## `buildOrderParams()`

- **Satır:** `src/services/order-service.js:148-185`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **İnceleme:**
  - `closePosition=true` ise quantity gönderilmiyor: **doğru**
  - `stopPrice` ekleniyor: **doğru alan adı**
  - `workingType` ekleniyor: **uygun**
  - `priceProtect` ekleniyor: **uygun alan**
- **Kritik problem:**
  - `closePosition=true` iken `reduceOnly=true` de ekleniyor (`168-170`).
- **Yüksek riskli problem:**
  - `price` ve `stopPrice` için tick-size / precision normalizasyonu yok.
- **Muhtemel 400 sebepleri:**
  - Binance parametre kombinasyonunu reddeder
  - `stopPrice` precision hatası
  - `price` / `stopPrice` sembol filter’ına uymama
- **Sonuç:** **HTTP 400 için en kritik üretici fonksiyonlardan biri.**

## `createStopLossOrder()`

- **Satır:** `src/services/order-service.js:274-286`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **Gönderilen request şekli:**
  - `type=STOP_MARKET`
  - `reduceOnly=true`
  - `closePosition=true`
  - `workingType=MARK_PRICE`
  - `priceProtect=true`
  - `stopPrice=...`
- **Beklenen Binance formatı:**
  - `STOP_MARKET` + `closePosition=true` kullanılabilir
  - ancak `reduceOnly` aynı request içinde sorun yaratabilir
- **Muhtemel 400 sebebi:**
  - **en güçlü aday:** `reduceOnly + closePosition` kombinasyonu
  - `stopPrice` precision sorunu
- **Sonuç:** Startup sync ve BE/trailing sırasında hata üretme potansiyeli çok yüksek.

## `createTakeProfitOrder()`

- **Satır:** `src/services/order-service.js:288-300`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **Durum:** `createStopLossOrder()` ile aynı riskleri taşıyor.
- **Muhtemel 400 sebepleri:**
  - `reduceOnly + closePosition`
  - `stopPrice` normalizasyon eksikliği

## `replaceStopLoss()`

- **Satır:** `src/services/order-service.js:302-307`
- **Endpointler:**
  - `/fapi/v1/order` `DELETE`
  - `/fapi/v1/order` `POST`
- **Method:** `DELETE` → `POST`
- **İnceleme:**
  - Önce cancel, sonra create yapıyor
- **Risk:**
  - Cancel başarılı, create 400 olursa korumasız kalma riski var
  - Yeni stop için yine aynı parametre kombinasyonu kullanılıyor
- **Muhtemel 400 sebebi:**
  - Yeni `STOP_MARKET` request’i

## `replaceTakeProfit()`

- **Satır:** `src/services/order-service.js:309-314`
- **Endpointler:**
  - `/fapi/v1/order` `DELETE`
  - `/fapi/v1/order` `POST`
- **Method:** `DELETE` → `POST`
- **Durum:** Stop replacement ile aynı risk profili.

## `cancelOrder()`

- **Satır:** `src/services/order-service.js:316-353`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `DELETE`
- **Beklenen Binance formatı:**
  - `symbol` zorunlu
  - `orderId` veya `origClientOrderId` gerekir
- **İnceleme:**
  - `symbol` guard var: **iyi**
  - `orderId` doğrudan gönderiliyor: **uygun**
- **Risk:**
  - `orderId` null/undefined ise ekstra guard yok
  - canlı hata logunda HTTP body görünmüyor
- **Muhtemel 400 sebepleri:**
  - bozuk `orderId`
  - cancel edilmeye çalışılan order’ın geçmiş/uyumsuz durumda olması
- **Sonuç:** Birincil 400 kaynağı gibi görünmüyor.

## `getOrder()`

- **Satır:** `src/services/order-service.js:355-374`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `GET`
- **Beklenen Binance formatı:**
  - `symbol` zorunlu
  - `orderId` veya `origClientOrderId` gerekir
- **İnceleme:**
  - `symbol` guard var: **iyi**
  - request şekli doğru
- **Sonuç:** Bariz REST uyuşmazlığı yok.

## `getOpenOrders()`

- **Satır:** `src/services/order-service.js:376-397`
- **Endpoint:** `/fapi/v1/openOrders`
- **Method:** `GET`
- **İnceleme:**
  - `symbol` opsiyonel kullanılıyor
  - signed GET yapılıyor
- **Sonuç:** Endpoint/method doğru. Bariz 400 kaynağı görünmüyor.

## `getOpenPositions()`

- **Satır:** `src/services/order-service.js:399-422`
- **Endpoint:** `/fapi/v2/positionRisk`
- **Method:** `GET`
- **İnceleme:**
  - Signed request doğru endpoint’e gidiyor
  - Query boş, sadece timestamp/recvWindow var
- **Sonuç:** **Bu fonksiyonun kendisinde belirgin REST hatası yok.**
- **Önemli not:** Position Sync’te görülen 400, çok büyük ihtimalle bu GET’ten sonra aynı akış içinde tetiklenen koruma emri POST’larından kaynaklanıyor.

## `getOpenPosition()`

- **Satır:** `src/services/order-service.js:424-427`
- **İnceleme:**
  - `getOpenPositions()` sonucunu filtreliyor
- **Sonuç:** Kendi başına REST hatası üretmiyor.

---

## Görev 3: TradingLoop Akış Denetimi

## Entry → TP/SL oluşturma

- **Satır:** `src/trading-loop.js:442-477`
- Akış:
  1. `placeOrder(MARKET)` çağrılıyor
  2. `orderResult.success` ise işlem başarılı kabul ediliyor
  3. `ensureProtectionOrders(position)` çağrılıyor

### Problem

`orderResult.success` kontrol ediliyor ama:

- `order.status === FILLED` kontrol edilmiyor
- `executedQty > 0` kontrol edilmiyor
- partial fill / delayed fill durumuna karşı doğrulama yok

### Risk

Entry tamamen dolmadan TP/SL gönderilirse:

- close-position stop/tp tarafında Binance 400 dönebilir
- veya koruma mantığı gerçek pozisyon boyutundan kopabilir

### Sonuç

**“Entry tamamen dolmadan TP/SL oluşturuluyor mu?” sorusunun cevabı: evet, bu ihtimale karşı açık bir koruma yok.**

---

## Uygulama Durumu Guncellemesi (Bagimsiz Position Monitor)

Bu dokumanin ust kisimlarindaki analiz notlari tarihsel audit bulgularidir. Asagidaki bolum son gelistirme turunda uygulanan degisiklikleri ozetler.

### Tamamlananlar

1. Bagimsiz scheduler eklendi:
- `src/services/position-monitor.js`
- `setTimeout` tabanli non-overlap cycle
- `start()` idempotent
- `stop()` in-flight cycle bekleyip guvenli kapatma yapiyor

2. `TradingLoop` icinde position management ayrisimi yapildi:
- `monitorManagedPositions(...)`
- `runIndependentPositionMonitorCycle()`
- `syncManagedPositionsFromLivePositions(...)`
- Sadece bot ownership dogrulanmis pozisyonlar yonetiliyor

3. Ownership guvenlik kurali eklendi:
- Koruma emri pattern kontrolu (`STOP_MARKET` + `TAKE_PROFIT_MARKET`, `MARK_PRICE`, `closePosition=true`)
- `TradeSnapshotService.hasOpenSnapshotFor(...)` ile acik snapshot eslesmesi
- Dogrulanamayan canli pozisyonlar loglanip unmanaged birakiliyor (otomatik aksiyon yok)

4. Konfigrasyon eklendi:
- `POSITION_MONITOR_INTERVAL_MS` (default: `5000`, min: `1000`)
- `src/config/config.js` validate guard eklendi

5. Uygulama lifecycle entegrasyonu:
- `src/index.js` icinde `PositionMonitor` baslatiliyor
- `SIGINT` kapanisinda monitor `await stop()` ile guvenli sekilde durduruluyor

6. Order-service cache entegrasyonu:
- `primePositionRiskCycleCacheFromPositions(...)` yardimcisi eklendi
- TTL hesabinda `POSITION_MONITOR_INTERVAL_MS` kullaniliyor

### Test ve Dogrulama Sonuclari

Calistirilan komutlar:

- `npm test`
- `npm run lint`
- `npm run build`
- `git diff --check`

Sonuc:

- Test suiti: **13/13 PASS**
- Testler: **96/96 PASS**
- Lint: **PASS**
- Build (`node --check`): **PASS**
- Diff whitespace kontrolu: **temiz**


## `ensureProtectionOrders()`

- **Satır:** `src/trading-loop.js:610-652`
- Akış:
  - open orders çekiliyor
  - stop/tp order’lar filtreleniyor
  - eksikse yeni order basılıyor

### Problem

Bu fonksiyon, var olan pozisyonun gerçekten Binance tarafında aktif ve korunmaya uygun durumda olduğunu ayrıca doğrulamıyor.

### Risk

- Startup sync sırasında pozisyon yeni kapanmışsa stale veriyle koruma order denenebilir
- Hata burada oluşursa üst seviye log yalnız “position sync failed” gibi görünür

## Break Even

- **Satır:** `src/trading-loop.js:688-713`
- Akış:
  - mevcut stop cancel
  - yeni stop create

### REST tarafı risk

Yeni stop yine `createStopLossOrder()` üzerinden gittiği için aynı parametre kombinasyonu problemi burada da tekrar eder.

## Trailing

- **Satır:** `src/trading-loop.js:715-747`
- Akış:
  - mevcut stop cancel
  - yeni stop create

### REST tarafı risk

- Aynı `STOP_MARKET` request formatı tekrar kullanılıyor
- stopPrice precision sorunu burada da sürüyor

## Position Sync

- **Satır:** `src/trading-loop.js:1005-1076`

### Gerçek akış

1. `syncLiveOpenPositionsOnStart()`
2. `fetchLiveOpenPositions()`
3. `orderService.getOpenPositions()` → `GET /fapi/v2/positionRisk`
4. Her açık pozisyon için `ensureProtectionOrders(position)`
5. Gerekirse `createStopLossOrder()` / `createTakeProfitOrder()` → `POST /fapi/v1/order`

### Kritik tespit

Position Sync hatası yalnızca `positionRisk` endpointinden kaynaklanmıyor olabilir. Hatta mevcut kod akışında **daha olası hata noktası**, senkron esnasında var olan pozisyona TP/SL oluşturmaya çalışılan POST emirleridir.

### Sonuç

**Position Sync HTTP 400 için birincil şüpheli GET değil, sync içindeki koruma emri POST akışıdır.**

---

## Görev 4: Position Sync HTTP 400 Kök Sebep Analizi

## En olası kök sebep

### Nokta

- **Fonksiyon:** `createStopLossOrder()` / `createTakeProfitOrder()`
- **Satır:** `src/services/order-service.js:274-299`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`

### Gönderilen request özeti

```text
symbol=...
side=SELL|BUY
type=STOP_MARKET | TAKE_PROFIT_MARKET
closePosition=true
reduceOnly=true
workingType=MARK_PRICE
priceProtect=TRUE
stopPrice=...
timestamp=...
recvWindow=5000
signature=...
```

### Beklenen Binance formatı

`closePosition=true` ile açılan close-all stop/tp emrinde parametre kombinasyonları çok sıkı kontrol edilir. `reduceOnly` alanı aynı request’te kabul edilmeyebilir.

### Muhtemel sebep

**`closePosition=true` + `reduceOnly=true` kombinasyonu**

Bu, mevcut kod tabanındaki HTTP 400 için en güçlü ve en spesifik adaydır.

## İkinci olası sebep

### Nokta

- **Fonksiyon:** `buildOrderParams()`
- **Satır:** `src/services/order-service.js:162-166`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`

### Problem

`stopPrice` yalnız `Number(stopPrice)` ile çevriliyor, fakat:

- symbol tick size’a göre kırpılmıyor
- exchange precision’ına göre ayarlanmıyor

### Muhtemel sonuç

- `Precision is over the maximum defined for this asset`
- invalid trigger price
- HTTP 400

## Daha düşük olasılıklı sebep

### Nokta

- **Fonksiyon:** `signedRequest()`
- **Satır:** `src/services/order-service.js:37-60`

### Problem

Çağıran kod yanlış veri verirse `undefined` query’ye düşebilir.

### Bu senaryoda neden daha düşük?

Mevcut sync akışında `symbol` canlı pozisyondan geliyor; bu yüzden `undefined symbol` olasılığı, `reduceOnly + closePosition` probleminden daha zayıf.

---

## Görev 5: HTTP 400 Oluşabilecek Noktalar

## 1. Stop Loss oluşturma

- **Fonksiyon:** `createStopLossOrder()`
- **Satır:** `src/services/order-service.js:274-286`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **Request:** `STOP_MARKET + closePosition=true + reduceOnly=true + stopPrice`
- **Beklenen Binance formatı:** `STOP_MARKET` close-all parametreleri uyumlu olmalı
- **Muhtemel sebep:** `reduceOnly` fazlalığı, `stopPrice` precision

## 2. Take Profit oluşturma

- **Fonksiyon:** `createTakeProfitOrder()`
- **Satır:** `src/services/order-service.js:288-300`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **Request:** `TAKE_PROFIT_MARKET + closePosition=true + reduceOnly=true + stopPrice`
- **Beklenen Binance formatı:** close-all TP parametreleri uyumlu olmalı
- **Muhtemel sebep:** `reduceOnly` fazlalığı, `stopPrice` precision

## 3. Break-even stop replacement

- **Fonksiyon:** `replaceStopLoss()` → `createStopLossOrder()`
- **Satır:** `src/services/order-service.js:302-307`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **Request:** yeni `STOP_MARKET`
- **Muhtemel sebep:** aynı parametre kombinasyonu

## 4. Trailing stop replacement

- **Fonksiyon:** `replaceStopLoss()` → `createStopLossOrder()`
- **Satır:** `src/services/order-service.js:302-307`
- **Endpoint:** `/fapi/v1/order`
- **Method:** `POST`
- **Request:** yeni `STOP_MARKET`
- **Muhtemel sebep:** aynı parametre kombinasyonu, hassasiyet problemi

## 5. Startup position sync

- **Fonksiyon:** `fetchLiveOpenPositions()` → `ensureProtectionOrders()`
- **Satır:** `src/trading-loop.js:1041-1076`, `610-652`
- **Endpoint:** dolaylı olarak `/fapi/v1/order`
- **Method:** `POST`
- **Muhtemel sebep:** sync sırasında var olan pozisyona koruma emri atılırken yukarıdaki stop/tp parametre problemi tetikleniyor

---

## Görev 6: Catch Block Denetimi

## Mevcut durum

### `placeOrder()`

- **Satır:** `src/services/order-service.js:268-270`
- Şu an loglanan alanlar:
  - `error.message`
  - `symbol`

### `cancelOrder()`

- **Satır:** `src/services/order-service.js:349-351`
- Şu an loglanan alanlar:
  - `error.message`
  - `orderId`

## Eksik log alanları

Promtta istenen ama şu an loglanmayan alanlar:

- HTTP Status
- Binance Error Code
- Binance Message
- Request URL
- Method
- Query
- Request Body
- Response Body
- Stack

## Sonuç

Mevcut log seviyesi, HTTP 400’ün gerçek nedenini teşhis etmek için yetersiz. Bu yüzden aynı hata:

- “position sync failed”
- “order placement failed”

olarak görülüyor, fakat Binance’ın tam reddetme sebebi görünmüyor.

---

## PositionManager İncelemesi

- **Dosya:** `src/engines/position-manager.js`
- **REST çağrısı:** yok
- **HTTP 400 üretme ihtimali:** doğrudan yok

### Not edilen uyumsuzluk

`PositionManager` şu alanları bekliyor:

- `position.direction`
- `LONG / SHORT`

Ama `TradingLoop` tarafında kullanılan yapı:

- `position.signal`
- `BUY / SELL`

Bu nedenle `PositionManager` ile `TradingLoop` tam uyumlu değil. Ancak bu durum **REST 400 kök sebebi değil**, daha çok iç model uyumsuzluğu.

---

## Nihai Değerlendirme

### En muhtemel HTTP 400 kaynağı

**`POST /fapi/v1/order` request’lerinde `closePosition=true` ile birlikte `reduceOnly=true` gönderilmesi**

### En muhtemel ikinci neden

**`stopPrice` / `price` için Binance symbol precision normalizasyonunun olmaması**

### Position Sync için özel sonuç

`syncLiveOpenPositionsOnStart()` sırasında görülen HTTP 400, yüksek olasılıkla:

1. `GET /fapi/v2/positionRisk`
2. pozisyon bulundu
3. `ensureProtectionOrders()`
4. `createStopLossOrder()` veya `createTakeProfitOrder()`
5. **POST /fapi/v1/order` HTTP 400**

şeklinde oluşuyor.

Yani hata adı “position sync” olsa da, **asıl hata sync içindeki protection order creation aşamasında olabilir**.


---

## PR #7 Sonrası Güvenlik Kapısı

### Bağlam

- PR: [#7 - Fix ambush scan status and counters](https://github.com/dtepe42-dev/gptsonoev/pull/7)
- PR #7, `main` dalına `91e7a24` merge commit'i ile birleştirildi.
- Bağımsız position-monitor güncellemesi daha sonra `07e9ecd` commit'iyle `main` dalına eklendi.
- Bu bölüm, PR #7 sonrasında yapılan position-monitor ve stop yenileme güncellemesinin güvenlik değerlendirmesidir.

### Canlı Deployment Kararı

**DURUM: BLOKE — canlı deployment yapılmamalıdır.**

Aşağıdaki güvenlik şartlarının tamamı kod ve testlerle doğrulanmadan canlıya geçiş yasaktır:

1. Ownership kontrolü yalnız açık ve güvenilir biçimde `BOT_CONFIRMED` olan pozisyonları yönetmelidir.
2. Eksik, belirsiz, çelişkili veya doğrulanamayan ownership bilgisi fail-closed davranmalıdır.
3. Stop yenilemesi sırasında pozisyon korumasız kalmamalıdır.
4. Rollback ile oluşturulan yeni stop emrinin kimliği position state'e doğru aktarılmalıdır.
5. Restart sonrası algo stop emirleri doğru endpoint üzerinden bulunmalı ve iptal edilmelidir.
6. Ana trading loop ile bağımsız monitor aynı pozisyonu çift yönetmemelidir.
7. Mojibake/Türkçe karakter bozulmaları giderilmelidir.
8. İstenen kritik senaryolar otomatik testlerle kapsanmalı; tüm test, lint, build ve `git diff --check` kontrolleri geçmelidir.

### Doğrulanmış Açıklar

- `isPositionBotManaged()` içinde ownership eksik olduğunda yönetimi kabul eden fail-open davranış bulunmuştur.
- Pozisyon state oluşturma akışında eksik ownership'in `BOT_CONFIRMED` kabul edilme riski vardır.
- Stop yenileme rollback'i kısmen eklenmiş olsa da rollback emrinin yeni order ID'sinin state'e aktarılması ve rollback test kapsamı tamamlanmamıştır.
- Eski stop cache'de bulunamadığında korumayı geri kurma garantisi yoktur.
- `src/trading-loop.js` içinde gerçek mojibake metinler kalmıştır.
- Ownership, rollback, restart/algo endpoint ve state güncelleme senaryolarının test kapsamı eksiktir.

### Kabul Kriterleri

Canlı deployment engeli ancak aşağıdakilerin tamamı sağlandığında kaldırılabilir:

- Ownership varsayılanı unmanaged/unverified olur ve yalnız `BOT_CONFIRMED` yönetilir.
- Belirsiz pozisyonlarda SL, TP, break-even, trailing ve close çağrılarının yapılmadığı testlerle kanıtlanır.
- Stop replacement güvenli create-first veya eksiksiz cancel/create/rollback modeliyle uygulanır.
- Başarısız create ve başarısız rollback kritik seviyede görünür olur; state iptal edilmiş order ID'sinde kalmaz.
- Algo ve normal order endpoint ayrımı restart senaryosuyla test edilir.
- Position-monitor non-overlap, idempotent start, in-flight shutdown ve çift-yönetim korumaları geçer.
- UTF-8/mojibake taraması temizdir.
- `npm test`, `npm run lint`, `npm run build` ve `git diff --check` başarılıdır.

### Son Doğrulama Kaydı

`07e9ecd` için kullanıcı tarafından bildirilen yerel sonuç:

- Test suite: **13/13 PASS**
- Test: **102/102 PASS**
- Lint: **PASS**
- Build: **PASS**
- `git diff --check`: **PASS**

Bu sonuçlar mevcut testlerin geçtiğini gösterir; yukarıdaki eksik güvenlik senaryolarını kapsamadığı için canlı deployment onayı değildir.


## PR #7 Sonrası Güvenlik Güncellemesi

Bu bölüm, PR #7 sonrasında eklenen bağımsız position monitor için
`fix/fail-closed-position-safety` dalında uygulanan güvenlik düzeltmesini kaydeder.

### Stop yenileme modeli

Binance Futures'ın tüm position mode kombinasyonlarında aynı pozisyon için iki
`closePosition` koruma emrini güvenilir biçimde kabul ettiği varsayılmamıştır.
Bu nedenle akış `cancel -> create -> rollback` modelini kullanır:

1. Eski stop'un fiyat ve miktar snapshot'ı cache'de yoksa eski emir iptal edilmez.
2. Eski emrin iptali başarısızsa yeni stop oluşturulmaz.
3. Yeni stop bütün retry denemelerinden sonra başarısızsa eski stop aynı fiyat ve
   miktarla yeniden oluşturulur.
4. Rollback sonucu yeni order ID hata nesnesinde çağırana aktarılır ve pozisyon
   state'i geri kurulan order ID/fiyat ile senkronlanır.
5. Rollback de başarısızsa `[CRITICAL]` logu ve
   `STOP_REPLACEMENT_AND_ROLLBACK_FAILED` kodu görünür kalır.

Bu modelde cancel ile rollback/create arasındaki kısa pencere tamamen ortadan
kaldırılamaz. Bilinen kalan risk budur; create-first'in Binance hesap/position
mode davranışı doğrulanmadan create-first'e geçilmemiştir.

### Ownership fail-closed

- Yalnız normalize edilmiş ownership değeri tam olarak `BOT_CONFIRMED` olan
  state'ler yönetilir.
- Eksik, boş, `UNMANAGED`, `UNKNOWN` veya başka bir değer otomatik olarak
  unmanaged kabul edilir.
- `createPositionState()` eksik ownership'i artık `BOT_CONFIRMED` yapmaz.
- Monitor, doğrulanmamış state için lifecycle/SL/TP/trailing/close çağrısı
  yapmaz ve throttled warning üretir.
- Canlı pozisyonu yeniden bağlamak için hem bot koruma-emri pattern'i hem de
  açık trade snapshot eşleşmesi gerekir.

### Kodlama

`src/trading-loop.js` içindeki doğrulanmış mojibake satırları UTF-8 metinlerle
değiştirildi. Davranışsal ifadeler korunarak yalnız log, bildirim ve yorum
metinleri temizlendi.

### Eklenen doğrulamalar

- Eski stop snapshot'ı yoksa cancel yapılmaması.
- Replacement başarısızlığında rollback ve restored order ID aktarımı.
- Rollback başarısızlığının kritik hata olarak görünmesi.
- Başarılı cancel/create sırası.
- Eksik/belirsiz ownership'in unmanaged olması.
- Unverified state için doğrudan stop replacement'ın engellenmesi.
- Rollback sonrası position state'in geri kurulan stop ile senkronlanması.
- Restart cache'inde bulunan algo stop'un `/fapi/v1/algoOrder` ile iptali.
- Önceden mevcut position-monitor non-overlap, idempotent start, in-flight
  shutdown ve ana loop ile çift-yönetim testleri korunmuştur.

GitHub dalındaki değişiklikler connector üzerinden uygulanmıştır. Bu çalışma
ortamında repository checkout bağımlılıkları bulunmadığından `npm test`,
`npm run lint`, `npm run build` ve `git diff --check` yerel olarak
çalıştırılamamıştır. GitHub CI sonucu varsa PR üzerinde ayrıca doğrulanmalıdır;
çalıştırılmamış kontrol başarılı yazılmamıştır.
