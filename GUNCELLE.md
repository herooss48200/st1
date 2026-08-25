# Güncelleme Rehberi

Bu dosya, projeyi yerel bilgisayarda güncel `main` dalına geçirmek ve son önemli değişiklikleri takip etmek için hazırlanmıştır.

## Yerel projeyi güncelleme

PowerShell veya Komut İstemi'nde:

```powershell
cd "C:\Users\BERRAK\Desktop\gptsonoev"
git status
git switch main
git pull --ff-only origin main
```

> `git status` yerel değişiklik gösterirse devam etmeden önce değişikliklerinizi commit edin veya güvenli biçimde saklayın. Yerel değişiklikleri silmek için `reset --hard` kullanmayın.

Güncelleme sonrasında mevcut commit'i kontrol etmek için:

```powershell
git log -1 --oneline
```

## Son özellik güncellemesi — PR #29

PR: https://github.com/dtepe42-dev/gptsonoev/pull/29

Main commit: https://github.com/dtepe42-dev/gptsonoev/commit/2cae3cd2cffbfa76b9fed315ec002a928353a9d2

### Yapılan değişiklikler

- Market breadth sonucu artık yalnız loglanmıyor; ters, eksik, geçersiz veya bayat breadth yeni BUY/SELL girişini engelliyor.
- 15 dakikalık breadth `NEUTRAL` olduğunda hedef işlem riski `0.5 USDT` olarak uygulanıyor.
- Breadth sinyalle uyumlu olduğunda normal `RISK_PER_TRADE_USDT` değeri korunuyor.
- `MARKET_BREADTH_TOP_COINS` varsayılanı `100` değerinden `200` değerine çıkarıldı.
- Pusu hedefi 100 olsa bile breadth değerlendirmesi için en az 200 aday getiriliyor.
- Breadth sonucuna `upCount`, `downCount` ve `flatCount` alanları eklendi.
- Telegram pusu taraması mesajında breadth Long/Short/Yatay coin sayıları, Long/Short pusu sayılarından ayrı gösteriliyor.
- Eski tek yönlü `SELECTIVE_UP_UP_BREADTH_VETO_ENABLED` ayarı kaldırıldı.

### Yeni ortam ayarları

```env
MARKET_BREADTH_TOP_COINS=200
MARKET_BREADTH_ENTRY_VETO_ENABLED=true
MARKET_BREADTH_NEUTRAL_RISK_USDT=0.5
```

Canlı ortamın `.env` dosyasında `MARKET_BREADTH_TOP_COINS=100` açıkça tanımlıysa varsayılan değer geçersiz kalır. Bu durumda değeri elle `200` yapın.

### Telegram mesajı örneği

```text
🌐 Breadth (15m): DOWN
🟢 Long Coin: 42 | 🔴 Short Coin: 151 | ⚪ Yatay Coin: 7

🎯 Toplam Pusu: 12
🟢 Long Pusu: 7 | 🔴 Short Pusu: 5
```

### Doğrulama

PR #29 birleştirilmeden önce:

- lint başarılı,
- 22 test paketi başarılı,
- 190 test başarılı,
- build başarılı,
- Docker kontrolü başarılı.

## Özellik güncellemesi — PR #31

PR: https://github.com/dtepe42-dev/gptsonoev/pull/31

Main commit: https://github.com/dtepe42-dev/gptsonoev/commit/40c445102faaa4cec73ede631f697be314657294

### Yapılan değişiklikler

- Benzerlik eşiği `%51` değerinden `%52` değerine yükseltildi.
- Breadth hedefi en yüksek hacimli uygun 200 coin olarak korundu.
- Filtreleme sonrasında 200 uygun coine ulaşabilmek için varsayılan aday havuzu 2 katına, yani 400 coine çıkarıldı.
- Telegram pusu özetine breadth hedefi ile geçerli coin sayısı eklendi.
- BTC, ETH ve 15 dakikalık breadth tamamen aynı yöndeyken pusu hazırlığında Bollinger yerine 15 dakikalık EMA50 temas/geri-alım kuralı kullanılıyor.
- LONG için fiyatın EMA50'ye üstten yaklaşması, ATR toleransı içinde temas etmesi, EMA50 üzerinde kapanması ve EMA50 eğiminin yukarı olması gerekiyor. SHORT için simetrik koşullar uygulanıyor.
- EMA50 teması yalnız pusu hazırlığıdır; mevcut bağımsız 1 dakikalık işlem teyidi zorunlu kalır.
- Tam hizalanma kaybolursa EMA-hazır durumu sıfırlanır.
- Nötr breadth için Bollinger hazırlığı ve `0.5 USDT` risk; ters breadth veto kuralı değişmedi.

### Yeni ve güncellenen ortam ayarları

```env
SIMILARITY_THRESHOLD=52
MARKET_BREADTH_TOP_COINS=200
MARKET_BREADTH_CANDIDATE_MULTIPLIER=2
FULL_ALIGNMENT_EMA_READY_ENABLED=true
FULL_ALIGNMENT_EMA_PERIOD=50
FULL_ALIGNMENT_EMA_TOUCH_ATR_MULTIPLIER=0.10
FULL_ALIGNMENT_EMA_REQUIRE_RECLAIM=true
FULL_ALIGNMENT_EMA_REQUIRE_SLOPE=true
```

### Doğrulama

PR #31 birleştirilmeden önce:

- lint başarılı,
- 22 test paketi başarılı,
- 196 test başarılı,
- build ve diff kontrolleri başarılı.

## Dokümantasyon güncellemesi — PR #32

### PR #32 — PR #31 strateji kaydının güncelleme dosyasına eklenmesi

- PR: https://github.com/dtepe42-dev/gptsonoev/pull/32
- Durum: Birleştirildi
- Kaynak dal: `codex/document-pr-31-update`
- PR head SHA: `46bf323cf2941845c7f0c018b5ecfb871e045918`
- Squash merge commit: https://github.com/dtepe42-dev/gptsonoev/commit/e125183e67b0b7b6d788157e213d28b2d27f3cd0

### Değişiklik kapsamı

- PR #31 ile gelen EMA50 pusu hazırlığı ve 200 coin breadth değişiklikleri `GUNCELLE.md` içine kaydedildi.
- Yeni ve güncellenen ortam değişkenleri belgelendi.
- Yerel `.env` güncellemesinde yalnız ilgili anahtarların değiştirilmesi gerektiği netleştirildi.

### Kaynaklar

- https://github.com/dtepe42-dev/gptsonoev/pull/31
- https://github.com/dtepe42-dev/gptsonoev/pull/32
