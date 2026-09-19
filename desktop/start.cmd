@echo off
rem Dev launcher for the desktop shell. Works from shells without node on
rem PATH (fnm-managed installs) and clears ELECTRON_RUN_AS_NODE, which
rem IDE terminals set and which makes Electron run as plain Node.
setlocal
set ELECTRON_RUN_AS_NODE=
where npm >nul 2>nul
if errorlevel 1 (
  for /d %%D in ("%APPDATA%\fnm\node-versions\v*") do set "NODE_DIR=%%D\installation"
  if not defined NODE_DIR (
    echo Could not find node: install it or put npm on PATH.
    exit /b 1
  )
)
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0"
npx electron . %*
