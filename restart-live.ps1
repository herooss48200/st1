$ProjectPath = "C:\Users\BERRAK\Desktop\gptsono tüm ai\githup gptsono\gptsono"
Set-Location $ProjectPath

# 1) Bu projeden çalışan node süreçlerini durdur
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*$ProjectPath*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2) Geçmişi temizle (log/db/cache/temp)
Remove-Item ".\logs\*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item ".\data\*.db*" -Force -ErrorAction SilentlyContinue
Remove-Item ".\storage\temp\*" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item ".\storage\cache\*" -Recurse -Force -ErrorAction SilentlyContinue

# 3) Oturum env çakışmalarını temizle
Remove-Item Env:APP_MODE -ErrorAction SilentlyContinue
Remove-Item Env:ENABLE_REAL_TRADING -ErrorAction SilentlyContinue

# 4) Canlı modda başlat
$env:APP_MODE = "live"
$env:ENABLE_REAL_TRADING = "true"
node .\src\index.js
