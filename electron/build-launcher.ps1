param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$VsWhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $VsWhere)) { throw 'The small Electron launcher requires Visual Studio Build Tools with Desktop development with C++.' }
$Installation = & $VsWhere -latest -version '[17.1,)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $Installation) { throw 'Visual Studio 2022 17.1+ with MSVC x64/x86 and a Windows SDK is required to build the portable launcher.' }
$DevShell = Join-Path $Installation.Trim() 'Common7\Tools\Launch-VsDevShell.ps1'
if (-not (Test-Path -LiteralPath $DevShell)) { throw "Visual Studio developer shell is missing: $DevShell" }

# Import the toolchain into this process without interpolating user paths into cmd.exe.
& $DevShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue) -or -not (Get-Command rc.exe -ErrorAction SilentlyContinue)) {
    throw 'The x64 C compiler or Windows resource compiler is unavailable.'
}
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launcher\launcher.rc') -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launcher\launcher.manifest') -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\desktop\assets\prts-agent-p.ico') -Destination $OutputDirectory -Force
Push-Location $OutputDirectory
try {
    & rc.exe /nologo /fo launcher.res launcher.rc
    if ($LASTEXITCODE -ne 0) { throw "Launcher resource compilation failed: $LASTEXITCODE" }
    & cl.exe /nologo /W4 /WX /O1 /MT /utf-8 /DUNICODE /D_UNICODE /Folauncher.obj '/FePRTS Terrarchive.exe' `
        (Join-Path $PSScriptRoot 'launcher\main.c') launcher.res /link /SUBSYSTEM:WINDOWS /MACHINE:X64 /MANIFEST:NO /DYNAMICBASE /NXCOMPAT user32.lib
    if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed: $LASTEXITCODE" }
} finally { Pop-Location }
