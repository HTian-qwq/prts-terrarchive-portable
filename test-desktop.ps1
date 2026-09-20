param(
    [string]$ToolsRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'),
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'prts-terrarchive'),
    [switch]$Watch,
    [switch]$BuildOnly,
    [switch]$RunOnly
)
$ErrorActionPreference = 'Stop'
$Node = Join-Path $ToolsRoot 'node\node.exe'
if (-not (Test-Path -LiteralPath $Node)) { throw "Build Node.js is missing: $Node" }
$TestArguments = @((Join-Path $PSScriptRoot 'scripts\test-desktop.mjs'), '--plugin', $PluginPath, '--tools', $ToolsRoot)
if ($Watch) { $TestArguments += '--watch' }
if ($BuildOnly) { $TestArguments += '--build-only' }
if ($RunOnly) { $TestArguments += '--run-only' }
& $Node @TestArguments
if ($LASTEXITCODE -ne 0) { throw "Test desktop failed with exit code $LASTEXITCODE" }
