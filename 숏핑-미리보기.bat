@echo off
chcp 65001 >nul
setlocal
title Shortping Preview (3033)
cd /d "%~dp0"

set "PORT=3033"
set "HOST=127.0.0.1"
set "APP_ORIGIN=http://localhost:3033"
set "URL=http://localhost:3033"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Installing packages...
  call npm install
  if errorlevel 1 ( echo [ERROR] npm install failed & pause & exit /b 1 )
)

if not exist "data" mkdir "data"

netstat -ano | findstr /R /C:":3033 .*LISTENING" >nul
if not errorlevel 1 (
  echo [INFO] Port 3033 is already running. Opening browser...
  start "" "%URL%"
  timeout /t 2 >nul
  exit /b 0
)

echo [INFO] Starting Shortping on %URL% ...
start "Shortping Server 3033" cmd /k "node --env-file-if-exists=.env server/index.mjs"

set /a TRIES=0
:waitloop
timeout /t 1 >nul
set /a TRIES+=1
netstat -ano | findstr /R /C:":3033 .*LISTENING" >nul
if not errorlevel 1 goto ready
if %TRIES% GEQ 60 (
  echo [WARN] Server did not respond within 60s. Check the "Shortping Server 3033" window.
  pause
  exit /b 1
)
goto waitloop

:ready
echo [OK] Server ready. Opening %URL%
start "" "%URL%"
timeout /t 2 >nul
exit /b 0
