@echo off
setlocal
cd /d "%~dp0"
if exist "..\node\node.exe" (
  "..\node\node.exe" server.mjs %*
) else (
  node server.mjs %*
)
if errorlevel 1 pause
