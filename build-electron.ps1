param(
    [string]$ToolsRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'),
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'prts-terrarchive'),
    [switch]$SkipDshBuild,
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = $PSScriptRoot
$BuildRoot = Join-Path $RepositoryRoot '.build'
$DshSource = Join-Path $BuildRoot 'dsh-electron'
$CorpusReleases = Join-Path $BuildRoot 'corpus\releases'
$PluginPackages = Join-Path $BuildRoot 'electron-plugin'
$NodeDirectory = Join-Path $ToolsRoot 'node'
$Node = Join-Path $NodeDirectory 'node.exe'
$Corepack = Join-Path $NodeDirectory 'corepack.cmd'
$Versions = Get-Content (Join-Path $RepositoryRoot 'versions.electron.json') -Raw | ConvertFrom-Json
$Name = 'PRTS-Terrarchive-Electron-windows-x64'
$OutputDirectory = Join-Path (Join-Path $RepositoryRoot 'dist') $Name
$StagingRoot = Join-Path $BuildRoot ("electron-staging-$PID-" + [Guid]::NewGuid().ToString('N'))
$StagingDirectory = Join-Path $StagingRoot $Name
$Archive = "$OutputDirectory.zip"
$NextArchive = "$OutputDirectory.next.zip"
$Checksum = "$Archive.sha256"

function Invoke-Checked {
    param([Parameter(Mandatory = $true)][string]$Command, [string[]]$ArgumentList = @())
    & $Command @ArgumentList
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing ${Description}: $Path" }
}

function Add-ToolPath([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Container) { $env:PATH = "$Path;$env:PATH" }
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'The Electron release must be built with Windows x64 Node.js on Windows x64.'
}
Set-Location $RepositoryRoot
New-Item -ItemType Directory -Force $BuildRoot, $PluginPackages, (Split-Path -Parent $OutputDirectory) | Out-Null
Add-ToolPath (Join-Path $ToolsRoot 'git\cmd')
Add-ToolPath $NodeDirectory
Assert-File $Node 'Node.js build tool'
Assert-File $Corepack 'Corepack'
Assert-File (Join-Path $PluginPath 'package.json') 'PRTS plugin source'
Assert-File (Join-Path $PluginPath 'presets\register.js') 'Electron-compatible PRTS preset registration'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was not found.' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe was not found.' }
$BuildPlatform = & $Node -p process.platform
if ($LASTEXITCODE -ne 0 -or $BuildPlatform -ne 'win32') { throw 'The build Node.js must run on Windows.' }
$BuildArchitecture = & $Node -p process.arch
if ($LASTEXITCODE -ne 0 -or $BuildArchitecture -ne 'x64') { throw 'Use the x64 Node.js build tool.' }
$BuildVersionText = & $Node --version
if ($LASTEXITCODE -ne 0) { throw 'The Node.js build tool could not start.' }
$BuildVersion = [version]$BuildVersionText.Trim().TrimStart('v')
if (-not ($BuildVersion.Major -ge 24 -or ($BuildVersion.Major -eq 22 -and $BuildVersion.Minor -ge 19))) {
    throw 'Building DSH requires Node.js 22.19+ or 24+.'
}

if (-not $SkipDshBuild) {
    $VsWhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    Assert-File $VsWhere 'Visual Studio Build Tools (Desktop development with C++)'
    $Installation = & $VsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $Installation) { throw 'MSVC x64/x86 and a Windows SDK are required to build DSH native dependencies.' }
}

if (-not (Test-Path -LiteralPath (Join-Path $DshSource '.git'))) {
    Write-Host 'Fetching the pinned official Electron source...' -ForegroundColor Cyan
    Invoke-Checked -Command git -ArgumentList @('clone', '--branch', ([string]$Versions.dsh.tag), '--depth', '1',
        'https://github.com/deepseek-ai/deepseek-harness.git', $DshSource)
}
$ActualCommit = & git -C $DshSource rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $ActualCommit.Trim() -ne [string]$Versions.dsh.commit) {
    throw 'The Electron source cache does not match versions.electron.json. Use a fresh .build\dsh-electron directory.'
}
$DshPackage = Get-Content (Join-Path $DshSource 'package.json') -Raw | ConvertFrom-Json
if ([string]$DshPackage.version -ne [string]$Versions.dsh.version) { throw 'The cached DSH package version does not match the pinned release.' }

Invoke-Checked -Command $Corepack -ArgumentList @('prepare', "pnpm@$($Versions.pnpm)", '--activate')
Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'electron\source-overlay.mjs'), '--dsh-source', $DshSource)

Write-Host 'Resolving and verifying the complete current PRTS corpus...' -ForegroundColor Cyan
Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'scripts\fetch-current-corpus.mjs'),
    '--plugin', (Resolve-Path -LiteralPath $PluginPath).Path, '--out', $CorpusReleases)

# This local npm package contains the plugin; corpus assets are assembled separately.
Get-ChildItem -LiteralPath $PluginPackages -Filter '*.tgz' | Remove-Item -Force
Push-Location $PluginPath
try {
    Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'pack', '--pack-destination', $PluginPackages)
} finally { Pop-Location }
$Tarballs = @(Get-ChildItem -LiteralPath $PluginPackages -Filter '*.tgz')
if ($Tarballs.Count -ne 1) { throw 'Expected exactly one packed PRTS plugin.' }
$PluginTarball = $Tarballs[0].FullName
$DesktopRoot = Join-Path $DshSource 'apps\desktop'
$TargetRoot = Join-Path $DesktopRoot '.desktop-build\targets\win-x64'
$ElectronOutput = Join-Path $TargetRoot 'prts-artifacts'

$PreviousPlatform = $env:DSH_DESKTOP_TARGET_PLATFORM
$PreviousArch = $env:DSH_DESKTOP_TARGET_ARCH
$PreviousBuilderRoot = $env:PRTS_PORTABLE_BUILDER_ROOT
$PreviousBuilderOutput = $env:PRTS_ELECTRON_OUTPUT
try {
    $env:DSH_DESKTOP_TARGET_PLATFORM = 'win32'
    $env:DSH_DESKTOP_TARGET_ARCH = 'x64'
    $env:PRTS_PORTABLE_BUILDER_ROOT = $RepositoryRoot
    $env:PRTS_ELECTRON_OUTPUT = $ElectronOutput
    Push-Location $DshSource
    try {
        if (-not $SkipDshBuild) {
            Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'install', '--frozen-lockfile')
            # Preparation reuses upstream build/pack/runtime/seed verification and does not sign or publish.
            Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'run', 'prepare:package')
        } else {
            Assert-File (Join-Path $TargetRoot 'seed\integrity.json') 'prepared Electron seed; run once without -SkipDshBuild'
            Assert-File (Join-Path $TargetRoot 'runtime\node\LICENSE') 'bundled Node.js license; run once without -SkipDshBuild'
            # Always rebuild the small shell so a changed community overlay cannot reuse stale code.
            Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'run', 'build:desktop')
        }
        Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', '--dir', 'apps/desktop', 'exec', 'tsx',
            'scripts/prts-prepare-seed.ts', '--plugin-tarball', $PluginTarball)
    } finally { Pop-Location }

    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\portable-main.mjs') -Destination $DesktopRoot -Force
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\builder-config.mjs') -Destination (Join-Path $DesktopRoot 'prts-builder-config.mjs') -Force
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\smoke.ts') -Destination (Join-Path $DesktopRoot 'scripts\prts-smoke.ts') -Force
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\smoke-corpus.mjs') -Destination (Join-Path $DesktopRoot 'scripts\prts-smoke-corpus.mjs') -Force
    Push-Location $DesktopRoot
    try {
        Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'exec', 'electron-builder',
            '--config', 'prts-builder-config.mjs', '--win', '--x64', '--dir', '--publish', 'never')
    } finally { Pop-Location }

    New-Item -ItemType Directory -Force $StagingRoot | Out-Null
    Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'scripts\assemble-electron.mjs'),
        '--electron-dir', (Join-Path $ElectronOutput 'win-unpacked'), '--dsh-source', $DshSource,
        '--plugin', (Resolve-Path -LiteralPath $PluginPath).Path, '--corpus-releases', $CorpusReleases, '--out', $StagingDirectory)
    # assemble-electron audits the completed artifact before returning.
    if (-not $SkipSmoke) {
        Push-Location $DesktopRoot
        try {
            Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'exec', 'tsx', 'scripts/prts-smoke.ts', '--artifact', $StagingDirectory)
        } finally { Pop-Location }
    }
} finally {
    $env:DSH_DESKTOP_TARGET_PLATFORM = $PreviousPlatform
    $env:DSH_DESKTOP_TARGET_ARCH = $PreviousArch
    $env:PRTS_PORTABLE_BUILDER_ROOT = $PreviousBuilderRoot
    $env:PRTS_ELECTRON_OUTPUT = $PreviousBuilderOutput
}

Write-Host 'Creating the Electron portable ZIP and checksum...' -ForegroundColor Cyan
Remove-Item -LiteralPath $NextArchive -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath $StagingDirectory -DestinationPath $NextArchive -CompressionLevel Optimal
Move-Item -LiteralPath $NextArchive -Destination $Archive -Force
$Hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
"$Hash  $Name.zip" | Set-Content -LiteralPath $Checksum -Encoding ascii

# Keep the last expanded artifact if it is still open; the verified ZIP is already complete.
$PreviousDirectory = "$OutputDirectory.previous-$PID"
$PreviousMoved = $false
$Expanded = $StagingDirectory
try {
    if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'userdata')) {
        throw 'The previous expanded distribution contains user data; leave it intact and use the new ZIP.'
    }
    if (Test-Path -LiteralPath $OutputDirectory) {
        Move-Item -LiteralPath $OutputDirectory -Destination $PreviousDirectory
        $PreviousMoved = $true
    }
    Move-Item -LiteralPath $StagingDirectory -Destination $OutputDirectory
    $Expanded = $OutputDirectory
    Remove-Item -LiteralPath $StagingRoot -Force -ErrorAction SilentlyContinue
    if ($PreviousMoved) {
        try { Remove-Item -LiteralPath $PreviousDirectory -Recurse -Force }
        catch { Write-Warning "The old expanded distribution remains at: $PreviousDirectory" }
    }
} catch {
    if ($PreviousMoved -and -not (Test-Path -LiteralPath $OutputDirectory)) {
        Move-Item -LiteralPath $PreviousDirectory -Destination $OutputDirectory
    }
    Write-Warning ("The previous expanded distribution was kept: " + $_.Exception.Message)
}
Write-Host "Done: $Archive" -ForegroundColor Green
Write-Host "SHA-256: $Hash"
Write-Host "Expanded: $Expanded"
