param(
    [string]$ToolsRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'),
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'prts-terrarchive'),
    [string]$LocalDshSource = '',
    [switch]$SkipDshBuild,
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = $PSScriptRoot
$BuildRoot = Join-Path $RepositoryRoot '.build'
$DshSource = Join-Path $BuildRoot 'dsh-electron-current'
$CorpusReleases = Join-Path $BuildRoot 'corpus\releases'
$PluginPackages = Join-Path $BuildRoot 'electron-plugin-current'
$LauncherDirectory = Join-Path $BuildRoot 'electron-launcher'
$NodeDirectory = Join-Path $ToolsRoot 'node'
$Node = Join-Path $NodeDirectory 'node.exe'
$Corepack = Join-Path $NodeDirectory 'corepack.cmd'
$Versions = Get-Content (Join-Path $RepositoryRoot 'versions.electron.current.json') -Raw | ConvertFrom-Json
$Name = 'PRTS-Terrarchive-Electron-windows-x64'
$OutputDirectory = Join-Path (Join-Path $RepositoryRoot 'dist') $Name
$StagingRoot = Join-Path $BuildRoot ("electron-current-staging-$PID-" + [Guid]::NewGuid().ToString('N'))
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
    throw 'The Electron release must be built on Windows x64.'
}
Set-Location $RepositoryRoot
New-Item -ItemType Directory -Force $BuildRoot, $PluginPackages, (Split-Path -Parent $OutputDirectory) | Out-Null
Add-ToolPath (Join-Path $ToolsRoot 'git\cmd')
Add-ToolPath $NodeDirectory
Assert-File $Node 'Node.js build tool'
Assert-File $Corepack 'Corepack'
Assert-File (Join-Path $PluginPath 'package.json') 'PRTS plugin source'
Assert-File (Join-Path $PluginPath 'presets\definition.js') 'DSH 0.1.7 PRTS mode definition'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was not found.' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'Windows tar.exe was not found.' }
$BuildPlatform = & $Node -p process.platform
$BuildArchitecture = & $Node -p process.arch
if ($LASTEXITCODE -ne 0 -or $BuildPlatform -ne 'win32' -or $BuildArchitecture -ne 'x64') {
    throw 'Use Windows x64 Node.js to build this release.'
}
$BuildVersionText = & $Node --version
if ($LASTEXITCODE -ne 0) { throw 'The Node.js build tool could not start.' }
$BuildVersion = [version]$BuildVersionText.Trim().TrimStart('v')
if (-not ($BuildVersion.Major -ge 24 -or ($BuildVersion.Major -eq 22 -and $BuildVersion.Minor -ge 19))) {
    throw 'Building DSH requires Node.js 22.19+ or 24+.'
}

$Launcher = Join-Path $LauncherDirectory 'PRTS Terrarchive.exe'
$ReuseLauncher = $SkipDshBuild -and (Test-Path -LiteralPath $Launcher -PathType Leaf)
if ($ReuseLauncher) {
    Write-Host 'Reusing the cached portable launcher and checking it against this Node toolchain...' -ForegroundColor Cyan
} else {
    Write-Host 'Building the small portable launcher...' -ForegroundColor Cyan
    & (Join-Path $RepositoryRoot 'electron\build-launcher.ps1') -OutputDirectory $LauncherDirectory
}
Assert-File $Launcher 'native portable launcher'
# A reused binary must always pass the real Windows execution probe, even with -SkipSmoke.
if ($ReuseLauncher -or -not $SkipSmoke) {
    Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'electron\smoke-launcher.mjs'), '--launcher', $Launcher, '--node', $Node)
}

$SourceArguments = @((Join-Path $RepositoryRoot 'scripts\prepare-current-dsh-source.mjs'))
if ($LocalDshSource) { $SourceArguments += @('--local-source', $LocalDshSource) }
Invoke-Checked -Command $Node -ArgumentList $SourceArguments
$ActualCommit = & git -C $DshSource rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $ActualCommit.Trim() -ne [string]$Versions.dsh.commit) {
    throw 'The current Electron source cache does not match versions.electron.current.json. Use a fresh .build\dsh-electron-current directory.'
}
$DshPackage = Get-Content (Join-Path $DshSource 'package.json') -Raw | ConvertFrom-Json
if ([string]$DshPackage.version -ne [string]$Versions.dsh.version) { throw 'The cached DSH version does not match the pin.' }
# 清掉之前运行残留在缓存源码树里的 wrapper overlay 文件；
# 否则完整构建的 tsc 会把这些无类型声明的 .mjs 当源码检查（TS7016/TS7006）。
Remove-Item -LiteralPath `
    (Join-Path $DshSource 'apps\desktop\portable-main.mjs'), `
    (Join-Path $DshSource 'apps\desktop\prts-builder-config.mjs'), `
    (Join-Path $DshSource 'apps\desktop\scripts\prts-smoke-current.ts'), `
    (Join-Path $DshSource 'apps\desktop\scripts\prts-smoke-corpus.mjs') `
    -Force -ErrorAction SilentlyContinue
Invoke-Checked -Command $Corepack -ArgumentList @('prepare', "pnpm@$($Versions.pnpm)", '--activate')

Write-Host 'Resolving and verifying the complete current PRTS corpus...' -ForegroundColor Cyan
Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'scripts\fetch-current-corpus.mjs'),
    '--plugin', (Resolve-Path -LiteralPath $PluginPath).Path, '--out', $CorpusReleases)
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
        # The cached runtime does not guarantee that workspace CLI shims (tsx, electron-builder) still exist.
        Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'install', '--frozen-lockfile')
        if (-not $SkipDshBuild) {
            Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'electron\source-overlay-current.mjs'), '--dsh-source', $DshSource)
            Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'scripts\prepare-current-desktop-env.mjs'), $DshSource)
            Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'run', 'prepare:package')
        } else {
            Assert-File (Join-Path $TargetRoot 'dsh\desktop-runtime.json') 'prepared official Desktop runtime'
            Assert-File (Join-Path $TargetRoot 'runtime\versions.json') 'prepared Electron runtime'
            Assert-File (Join-Path $DesktopRoot 'lib\preload-app.cjs') 'compiled Desktop preload'
            $CompiledPreload = Get-Content (Join-Path $DesktopRoot 'lib\preload-app.cjs') -Raw
            if (-not $CompiledPreload.Contains('prts-desktop-chrome')) {
                throw 'Cached DSH build lacks the PRTS window controls. Run without -SkipDshBuild once.'
            }
        }
        Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'exec', 'tsx',
            (Join-Path $RepositoryRoot 'electron\inject-runtime.mjs'), '--dsh-source', $DshSource,
            '--tarball', $PluginTarball)
    } finally { Pop-Location }

    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\portable-main.mjs') -Destination $DesktopRoot -Force
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\builder-config-current.mjs') -Destination (Join-Path $DesktopRoot 'prts-builder-config.mjs') -Force
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\smoke-current.ts') -Destination (Join-Path $DesktopRoot 'scripts\prts-smoke-current.ts') -Force
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'electron\smoke-corpus.mjs') -Destination (Join-Path $DesktopRoot 'scripts\prts-smoke-corpus.mjs') -Force
    Push-Location $DesktopRoot
    try {
        Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'exec', 'electron-builder',
            '--config', 'prts-builder-config.mjs', '--win', '--x64', '--dir', '--publish', 'never')
    } finally { Pop-Location }

    New-Item -ItemType Directory -Force $StagingRoot | Out-Null
    Invoke-Checked -Command $Node -ArgumentList @((Join-Path $RepositoryRoot 'scripts\assemble-electron-current.mjs'),
        '--electron-dir', (Join-Path $ElectronOutput 'win-unpacked'), '--launcher', $Launcher,
        '--dsh-source', $DshSource, '--plugin', (Resolve-Path -LiteralPath $PluginPath).Path,
        '--plugin-tarball', $PluginTarball, '--corpus-releases', $CorpusReleases, '--out', $StagingDirectory)
    if (-not $SkipSmoke) {
        Push-Location $DesktopRoot
        try {
            Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'exec', 'tsx',
                'scripts/prts-smoke-current.ts', '--artifact', $StagingDirectory)
        } finally { Pop-Location }
    }
} finally {
    $env:DSH_DESKTOP_TARGET_PLATFORM = $PreviousPlatform
    $env:DSH_DESKTOP_TARGET_ARCH = $PreviousArch
    $env:PRTS_PORTABLE_BUILDER_ROOT = $PreviousBuilderRoot
    $env:PRTS_ELECTRON_OUTPUT = $PreviousBuilderOutput
}

Write-Host 'Creating the current Electron portable ZIP and checksum...' -ForegroundColor Cyan
Remove-Item -LiteralPath $NextArchive -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath $StagingDirectory -DestinationPath $NextArchive -CompressionLevel Optimal
Move-Item -LiteralPath $NextArchive -Destination $Archive -Force
$Hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
"$Hash  $Name.zip" | Set-Content -LiteralPath $Checksum -Encoding ascii
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
        catch { Write-Warning ("The old expanded distribution remains at: " + $PreviousDirectory) }
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
