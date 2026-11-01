@echo off
chcp 65001 >nul
title NEON CITIES
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js ist nicht installiert.
  echo   Bitte die LTS-Version von https://nodejs.org installieren
  echo   und danach diese Datei nochmal doppelklicken.
  echo.
  start "" "https://nodejs.org/de/download"
  pause
  exit /b 1
)
node server.js --open
echo.
pause
