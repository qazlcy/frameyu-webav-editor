@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-ai-windows.ps1" -Mock %*
if errorlevel 1 pause
