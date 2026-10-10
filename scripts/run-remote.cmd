@echo off
setlocal
cd /d "%~dp0.."
if not exist ".organizer" mkdir ".organizer"

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=%LOCALAPPDATA%\pi-node\current\node.exe"
if not exist "%NODE_EXE%" if "%NODE_EXE%" NEQ "node" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_EXE%" if "%NODE_EXE%" NEQ "node" (
  echo Node.js was not found. Install Node.js or update scripts\run-remote.cmd.
  exit /b 1
)

"%NODE_EXE%" "src\remote-server.mjs" >> ".organizer\remote-server.log" 2>&1
