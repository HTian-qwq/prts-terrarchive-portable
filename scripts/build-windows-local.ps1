[CmdletBinding()]
param (
    [string]$PluginPath = "",
    [switch]$DesktopOnly,
    [string]$OutputName = "PRTS-Terrarchive-Desktop-windows-x64-dev"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$BuildRoot = Join-Path $RepositoryRoot ".build"
$DistRoot = Join-Path $RepositoryRoot "dist"
$Versions = Get-Content (Join-Path $RepositoryRoot "versions.json") -Raw | ConvertFrom-Json
$OutputDirectory = Join-Path $DistRoot $OutputName
$DesktopPublishDirectory = Join-Path $BuildRoot "desktop-local"

function Invoke-Checked {
    param (
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Assert-Command {
    param ([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Assert-Dotnet10 {
    Assert-Command "dotnet"
    $sdks = & dotnet --list-sdks
    $requiredSdk = [string]$Versions.desktop.dotnetSdk
    if (-not ($sdks | Where-Object { $_ -match "^$([regex]::Escape($requiredSdk))\s" })) {
        throw ".NET SDK $requiredSdk is required. Install it from https://dotnet.microsoft.com/download/dotnet/10.0"
    }
}

function Get-PortableNode {
    $nodeDirectory = Join-Path $BuildRoot "node"
    $nodeExecutable = Join-Path $nodeDirectory "node.exe"
    if (Test-Path $nodeExecutable) {
        return $nodeDirectory
    }

    $version = [string]$Versions.node
    $archiveName = "node-v$version-win-x64.zip"
    $archivePath = Join-Path $BuildRoot $archiveName
    $checksumPath = Join-Path $BuildRoot "SHASUMS256.txt"
    $baseUrl = "https://nodejs.org/dist/v$version"
    Write-Host "Downloading Node.js $version..." -ForegroundColor Cyan
    Invoke-WebRequest "$baseUrl/$archiveName" -OutFile $archivePath
    Invoke-WebRequest "$baseUrl/SHASUMS256.txt" -OutFile $checksumPath

    $line = Get-Content $checksumPath | Where-Object { $_ -match "  $([regex]::Escape($archiveName))$" }
    if (-not $line) { throw "Node.js checksum entry not found: $archiveName" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Node.js checksum mismatch" }

    $expanded = Join-Path $BuildRoot "node-expanded"
    if (Test-Path $expanded) { Remove-Item -LiteralPath $expanded -Recurse -Force }
    Expand-Archive $archivePath -DestinationPath $expanded
    Move-Item (Join-Path $expanded "node-v$version-win-x64") $nodeDirectory
    Remove-Item -LiteralPath $expanded -Recurse -Force
    return $nodeDirectory
}

function Get-PinnedRepository {
    param (
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Ref,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path (Join-Path $Destination ".git"))) {
        Write-Host "Cloning $Repository..." -ForegroundColor Cyan
        Invoke-Checked git clone --no-checkout "https://github.com/$Repository.git" $Destination
    }
    Invoke-Checked git -C $Destination fetch origin $Ref --depth 1
    Invoke-Checked git -C $Destination checkout --detach $Ref
    $actual = (& git -C $Destination rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actual -ne $Ref) {
        throw "$Repository commit mismatch: expected $Ref, got $actual"
    }
    return $Destination
}

function Publish-Desktop {
    Assert-Dotnet10
    if (Test-Path $DesktopPublishDirectory) {
        Remove-Item -LiteralPath $DesktopPublishDirectory -Recurse -Force
    }
    Write-Host "Publishing desktop executable..." -ForegroundColor Cyan
    Invoke-Checked dotnet restore (Join-Path $RepositoryRoot "desktop\PrtsTerrarchive.Desktop.csproj") -r win-x64 --locked-mode
    Invoke-Checked dotnet publish (Join-Path $RepositoryRoot "desktop\PrtsTerrarchive.Desktop.csproj") `
        -c Release -r win-x64 --self-contained true --no-restore `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:DebugType=None -p:DebugSymbols=false -o $DesktopPublishDirectory

    $desktopExecutable = Join-Path $DesktopPublishDirectory "PRTS Terrarchive.exe"
    if (-not (Test-Path $desktopExecutable)) { throw "Desktop executable was not produced." }
    return $desktopExecutable
}

Set-Location $RepositoryRoot
New-Item -ItemType Directory -Force $BuildRoot, $DistRoot | Out-Null
Assert-Command "git"

$desktopExecutable = Publish-Desktop
if ($DesktopOnly) {
    $targetExecutable = Join-Path $OutputDirectory "PRTS Terrarchive.exe"
    if (-not (Test-Path (Join-Path $OutputDirectory "release-manifest.json"))) {
        throw "DesktopOnly requires an existing assembled directory: $OutputDirectory"
    }
    Copy-Item -LiteralPath $desktopExecutable -Destination $targetExecutable -Force
    Write-Host "Desktop executable updated: $targetExecutable" -ForegroundColor Green
    exit 0
}

$nodeDirectory = Get-PortableNode
$nodeExecutable = Join-Path $nodeDirectory "node.exe"
$corepack = Join-Path $nodeDirectory "corepack.cmd"
Invoke-Checked $corepack prepare "pnpm@$($Versions.pnpm)" --activate
$dshSource = Join-Path $BuildRoot "dsh"
$dshDeploy = Join-Path $BuildRoot "dsh-deploy"
$dshSource = Get-PinnedRepository `
    -Repository "deepseek-ai/deepseek-harness" `
    -Ref ([string]$Versions.dsh.commit) `
    -Destination $dshSource

if ($PluginPath) {
    $resolvedPlugin = (Resolve-Path $PluginPath).Path
} else {
    $siblingPlugin = Join-Path (Split-Path -Parent $RepositoryRoot) "prts-terrarchive"
    if (Test-Path (Join-Path $siblingPlugin "package.json")) {
        $resolvedPlugin = $siblingPlugin
    } else {
        $resolvedPlugin = Get-PinnedRepository `
            -Repository ([string]$Versions.plugin.repository) `
            -Ref ([string]$Versions.plugin.ref) `
            -Destination (Join-Path $BuildRoot "plugin")
    }
}

Write-Host "Installing and building pinned DSH..." -ForegroundColor Cyan
Push-Location $dshSource
try {
    Invoke-Checked $corepack pnpm install --frozen-lockfile
    Invoke-Checked $corepack pnpm run build:official
} finally {
    Pop-Location
}

Invoke-Checked $nodeExecutable (Join-Path $RepositoryRoot "scripts\prepare-dsh-workspace.mjs") $dshSource
if (Test-Path $dshDeploy) { Remove-Item -LiteralPath $dshDeploy -Recurse -Force }
Push-Location $dshSource
try {
    Invoke-Checked $corepack pnpm --config.node-linker=hoisted `
        --config.inject-workspace-packages=true --filter dsh-python-runtime-closure `
        --prod deploy --frozen-lockfile $dshDeploy
} finally {
    Pop-Location
}
Invoke-Checked $nodeExecutable (Join-Path $RepositoryRoot "scripts\complete-dsh-workspace-closure.mjs") $dshSource $dshDeploy

Write-Host "Assembling portable desktop directory..." -ForegroundColor Cyan
Invoke-Checked $nodeExecutable (Join-Path $RepositoryRoot "scripts\assemble.mjs") `
    --dsh-deploy $dshDeploy `
    --dsh-source $dshSource `
    --plugin $resolvedPlugin `
    --node-dir $nodeDirectory `
    --desktop-exe $desktopExecutable `
    --out $OutputDirectory

Invoke-Checked $nodeExecutable (Join-Path $RepositoryRoot "scripts\audit-windows-artifact.mjs") $OutputDirectory
Invoke-Checked $nodeExecutable (Join-Path $RepositoryRoot "scripts\smoke-artifact.mjs") $OutputDirectory

Write-Host ""
Write-Host "Windows development package is ready:" -ForegroundColor Green
Write-Host "  $OutputDirectory"
Write-Host "Run: $OutputDirectory\PRTS Terrarchive.exe"
Write-Host "After changing only desktop/*.cs, rebuild quickly with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\build-windows-local.ps1 -DesktopOnly"
