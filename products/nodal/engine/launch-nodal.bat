@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where uv >nul 2>nul
if errorlevel 1 (
  echo uv 를 찾을 수 없습니다: https://docs.astral.sh/uv/
  pause
  exit /b 1
)

uv run --no-project python tools\launch.py %*
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
