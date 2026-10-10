@echo off
setlocal
where tailscale >nul 2>nul
if errorlevel 1 (
  echo Tailscale is not installed or is not on PATH.
  echo Install it from https://tailscale.com/download/windows
  exit /b 1
)

tailscale serve --bg http://127.0.0.1:8787
if errorlevel 1 exit /b %errorlevel%
tailscale serve status
