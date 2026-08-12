@echo off
rem Double-click launcher for the offline StegoShard web app.
rem
rem index.html cannot be opened directly: browsers block ES modules and module
rem workers over file://. This serves the folder on 127.0.0.1 instead. See
rem README.txt.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo.
  echo Install it from https://nodejs.org/ ^(version 20 or newer^), then run this
  echo again. If you would rather not install anything and have Python, see
  echo README.txt for a one-line alternative.
  echo.
  pause
  exit /b 1
)

rem Auto-open the browser: this file exists to be double-clicked, so the terminal
rem the URL would otherwise be printed to may not even be visible.
node serve.mjs --open %*

rem Reached on Ctrl+C or a startup failure; hold the window so the message is read.
echo.
pause
