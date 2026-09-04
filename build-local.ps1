param(
    [string]$ToolsRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'),
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'prts-terrarchive'),
    [switch]$SkipDshBuild,
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = $PSScriptRoot
$BuildRoot = Join-Path $RepositoryRoot '.build'
$DshSource = Join-Path $BuildRoot 'dsh'
$DshDeploy = Join-Path $BuildRoot 'dsh-deploy'
$DesktopPublish = Join-Path $BuildRoot 'desktop'
$CorpusReleases = Join-Path (Join-Path $BuildRoot 'corpus') 'releases'
$NodeDirectory = Join-Path $ToolsRoot 'node'
$Node = Join-Path $NodeDirectory 'node.exe'
$Corepack = Join-Path $NodeDirectory 'corepack.cmd'
$Versions = Get-Content (Join-Path $RepositoryRoot 'versions.json') -Raw | ConvertFrom-Json
$Name = 'PRTS-Terrarchive-Portable-windows-x64'
$OutputDirectory = Join-Path (Join-Path $RepositoryRoot 'dist') $Name
$StagingRoot = Join-Path $BuildRoot "release-staging-$PID"
$StagingDirectory = Join-Path $StagingRoot $Name
$Archive = "$OutputDirectory.zip"
$NextArchive = "$OutputDirectory.next.zip"
$Checksum = "$Archive.sha256"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$ArgumentList = @()
    )
    & $Command @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing ${Description}: $Path"
    }
}

function Add-ToolPath([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $env:PATH = "$Path;$env:PATH"
    }
}

Set-Location $RepositoryRoot
New-Item -ItemType Directory -Force $BuildRoot, (Split-Path -Parent $OutputDirectory) | Out-Null
Add-ToolPath (Join-Path $ToolsRoot 'git\cmd')
Add-ToolPath (Join-Path $ToolsRoot 'dotnet')
Add-ToolPath $NodeDirectory
Assert-File $Node 'Windows x64 Node.js'
Assert-File $Corepack 'Corepack'
Assert-File (Join-Path $PluginPath 'package.json') 'prts-terrarchive plugin source'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was not found.' }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET SDK was not found.' }

if (-not (Test-Path (Join-Path $DshSource '.git'))) {
    Write-Host 'Fetching DeepSeek Harness...' -ForegroundColor Cyan
    Invoke-Checked -Command git -ArgumentList @(
        'clone', '--branch', ([string]$Versions.dsh.tag), '--depth', '1',
        'https://github.com/deepseek-ai/deepseek-harness.git', $DshSource)
}

Invoke-Checked -Command $Corepack -ArgumentList @('prepare', "pnpm@$($Versions.pnpm)", '--activate')
Write-Host 'Resolving, downloading, and verifying the latest corpus from ModelScope...' -ForegroundColor Cyan
Invoke-Checked -Command $Node -ArgumentList @(
    (Join-Path $RepositoryRoot 'scripts\fetch-modelscope-corpus.mjs'),
    '--plugin', (Resolve-Path $PluginPath).Path,
    '--out', $CorpusReleases)
if (-not $SkipDshBuild) {
    Write-Host 'Installing and building official DSH...' -ForegroundColor Cyan
    Push-Location $DshSource
    try {
        Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'install', '--frozen-lockfile')
        Invoke-Checked -Command $Corepack -ArgumentList @('pnpm', 'run', 'build:official')
    } finally { Pop-Location }
}

Write-Host 'Creating the production runtime closure...' -ForegroundColor Cyan
if (Test-Path -LiteralPath $DshDeploy) {
    Remove-Item -LiteralPath $DshDeploy -Recurse -Force
}
$DshWorkspace = Join-Path $DshSource 'pnpm-workspace.yaml'
$DshWorkspaceOriginal = [System.IO.File]::ReadAllBytes($DshWorkspace)
try {
    Invoke-Checked -Command $Node -ArgumentList @(
        (Join-Path $RepositoryRoot 'scripts\prepare-dsh-workspace.mjs'), $DshSource)
    Push-Location $DshSource
    try {
        Invoke-Checked -Command $Corepack -ArgumentList @(
            'pnpm', '--config.node-linker=hoisted', '--config.inject-workspace-packages=true',
            '--filter', 'dsh-python-runtime-closure', '--prod', 'deploy', '--frozen-lockfile', $DshDeploy)
    } finally { Pop-Location }
} finally {
    [System.IO.File]::WriteAllBytes($DshWorkspace, $DshWorkspaceOriginal)
}
Invoke-Checked -Command $Node -ArgumentList @(
    (Join-Path $RepositoryRoot 'scripts\complete-dsh-workspace-closure.mjs'), $DshSource, $DshDeploy)

Write-Host 'Publishing the single-file desktop application...' -ForegroundColor Cyan
if (Test-Path -LiteralPath $DesktopPublish) {
    Remove-Item -LiteralPath $DesktopPublish -Recurse -Force
}
$DesktopProject = Join-Path $RepositoryRoot 'desktop\PrtsTerrarchive.Desktop.csproj'
Invoke-Checked -Command dotnet -ArgumentList @(
    'restore', $DesktopProject, '-r', 'win-x64', '--locked-mode')
Invoke-Checked -Command dotnet -ArgumentList @(
    'publish', $DesktopProject, '-c', 'Release', '-r', 'win-x64',
    '--self-contained', 'true', '--no-restore',
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:DebugType=None', '-p:DebugSymbols=false', '--output', $DesktopPublish)
$DesktopExe = Join-Path $DesktopPublish 'PRTS Terrarchive.exe'
Assert-File $DesktopExe 'desktop executable'

Write-Host 'Assembling the portable distribution...' -ForegroundColor Cyan
if (Test-Path -LiteralPath $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Force $StagingRoot | Out-Null
Invoke-Checked -Command $Node -ArgumentList @(
    (Join-Path $RepositoryRoot 'scripts\assemble.mjs'),
    '--dsh-deploy', $DshDeploy,
    '--dsh-source', $DshSource,
    '--plugin', (Resolve-Path $PluginPath).Path,
    '--corpus-releases', $CorpusReleases,
    '--node-dir', $NodeDirectory,
    '--desktop-exe', $DesktopExe,
    '--out', $StagingDirectory)

Invoke-Checked -Command $Node -ArgumentList @(
    (Join-Path $RepositoryRoot 'scripts\audit-windows-artifact.mjs'), $StagingDirectory)
if (-not $SkipSmoke) {
    Invoke-Checked -Command $Node -ArgumentList @(
        (Join-Path $RepositoryRoot 'scripts\smoke-artifact.mjs'), $StagingDirectory)
}

Write-Host 'Creating ZIP and checksum...' -ForegroundColor Cyan
Remove-Item -LiteralPath $NextArchive -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $StagingDirectory -DestinationPath $NextArchive -CompressionLevel Optimal
Move-Item -LiteralPath $NextArchive -Destination $Archive -Force
$Hash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
"$Hash  $Name.zip" | Set-Content $Checksum -Encoding ascii

$ExplodedDirectory = $OutputDirectory
$PreviousDirectory = "$OutputDirectory.previous-$PID"
$PreviousMoved = $false
try {
    if (Test-Path -LiteralPath $ExplodedDirectory) {
        Move-Item -LiteralPath $ExplodedDirectory -Destination $PreviousDirectory
        $PreviousMoved = $true
    }
    Move-Item -LiteralPath $StagingDirectory -Destination $ExplodedDirectory
    Remove-Item -LiteralPath $StagingRoot -Force -ErrorAction SilentlyContinue
    if ($PreviousMoved) {
        try {
            Remove-Item -LiteralPath $PreviousDirectory -Recurse -Force
        } catch {
            Write-Warning "The old expanded distribution remains at: $PreviousDirectory"
        }
    }
} catch {
    if ($PreviousMoved -and -not (Test-Path -LiteralPath $ExplodedDirectory)) {
        Move-Item -LiteralPath $PreviousDirectory -Destination $ExplodedDirectory
    }
    $ExplodedDirectory = $StagingDirectory
    Write-Warning 'The previous expanded distribution is in use and could not be replaced.'
    Write-Warning 'Exit PRTS Terrarchive from the tray before replacing that directory.'
}

Write-Host "Done: $Archive" -ForegroundColor Green
Write-Host "SHA-256: $Hash"
Write-Host "Expanded: $ExplodedDirectory"
