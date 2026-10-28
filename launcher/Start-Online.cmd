@echo off
setlocal
cd /d "%~dp0"
if exist "..\node\node.exe" (
  "..\node\node.exe" online.mjs %*
) else (
  node online.mjs %*
)
if errorlevel 1 pause
