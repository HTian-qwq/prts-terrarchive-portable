param(
    [string]$ToolsRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'),
    [string]$PluginPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'prts-terrarchive'),
    [switch]$SkipDshBuild,
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-electron-current.ps1') -ToolsRoot $ToolsRoot -PluginPath $PluginPath -SkipDshBuild:$SkipDshBuild -SkipSmoke:$SkipSmoke
