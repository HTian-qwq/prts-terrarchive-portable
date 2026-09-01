# PRTS Terrarchive Portable - 本地 Windows 构建脚本
# 用法：在普通 PowerShell 中执行  .\build-local.ps1
# 已完成的前置（无需重复）：工具链装在 d:\ds\.tools、DSH 源码固定 cd5ef81、
# pnpm install 已完成、桌面 EXE 已发布到 .build\desktop。

$ErrorActionPreference = 'Stop'
$repo = 'd:\ds\prts-terrarchive-portable'

# ===== 前置环境（便携工具链 + 代理）=====
$env:PATH = 'd:\ds\.tools\node;d:\ds\.tools\git\cmd;d:\ds\.tools\dotnet;' + $env:PATH
$env:HTTP_PROXY  = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'

# ===== 1. 构建官方 DSH（增量，上次中断可续跑）=====
Set-Location "$repo\.build\dsh"
pnpm run build:official
if ($LASTEXITCODE -ne 0) { throw 'build:official 失败' }

# ===== 2. 准备 deploy 精确白名单 =====
Set-Location $repo
node scripts/prepare-dsh-workspace.mjs .build\dsh

# ===== 3. 部署官方锁定的 DSH 运行闭包（hoisted）=====
Set-Location "$repo\.build\dsh"
pnpm --config.node-linker=hoisted --config.inject-workspace-packages=true `
  --filter dsh-python-runtime-closure --prod deploy --frozen-lockfile `
  "$repo\.build\dsh-deploy"
if ($LASTEXITCODE -ne 0) { throw 'pnpm deploy 失败' }

# ===== 4. 补齐声明的 workspace peer 闭包 =====
Set-Location $repo
node scripts/complete-dsh-workspace-closure.mjs .build\dsh .build\dsh-deploy

# ===== 4.5 发布自包含桌面程序（多文件：小 EXE + .NET DLL 随目录）=====
Set-Location $repo
Remove-Item -Recurse -Force "$repo\.build\desktop" -ErrorAction SilentlyContinue
dotnet restore desktop/PrtsTerrarchive.Desktop.csproj -r win-x64 --locked-mode
if ($LASTEXITCODE -ne 0) { throw 'dotnet restore 失败' }
dotnet publish desktop/PrtsTerrarchive.Desktop.csproj -c Release -r win-x64 `
  --self-contained true --no-restore -p:DebugType=None -p:DebugSymbols=false `
  -o .build/desktop
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish 失败' }
if (-not (Test-Path '.build\desktop\PRTS Terrarchive.exe')) { throw '桌面程序缺失' }

# ===== 5. 组装发行目录（插件来自本地 d:\ds\prts-terrarchive）=====
node scripts/assemble.mjs `
  --dsh-deploy .build\dsh-deploy `
  --dsh-source .build\dsh `
  --plugin d:\ds\prts-terrarchive `
  --node-dir d:\ds\.tools\node `
  --desktop-exe .build\desktop `
  --out dist\PRTS-Terrarchive-Portable-windows-x64

# ===== 6. 冒烟测试（真实拉起 Host 验证插件路由和客户端 bundle）=====
node scripts/smoke-artifact.mjs dist\PRTS-Terrarchive-Portable-windows-x64

# ===== 7. 打包 ZIP + SHA-256 =====
$name = 'PRTS-Terrarchive-Portable-windows-x64'
Compress-Archive -Path "dist\$name" -DestinationPath "dist\$name.zip" -CompressionLevel Optimal
$hash = (Get-FileHash "dist\$name.zip" -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $name.zip" | Set-Content "dist\$name.zip.sha256" -Encoding ascii
Write-Host "完成：dist\$name.zip" -ForegroundColor Green
Write-Host "SHA-256：$hash"
