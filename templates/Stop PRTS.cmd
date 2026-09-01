@echo off
cd /d "%~dp0"
"%~dp0runtime\node\node.exe" "%~dp0app\launcher.mjs" --stop
if errorlevel 1 pause
