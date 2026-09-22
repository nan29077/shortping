@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Shortping Stop (3033)
cd /d "%~dp0"

set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":3033 .*LISTENING"') do (
  if not "%%P"=="0" (
    echo [INFO] Stopping server process PID %%P ...
    taskkill /PID %%P /T /F >nul 2>nul
    set "FOUND=1"
  )
)

rem Close the "Shortping Server 3033" console window if still open
taskkill /FI "WINDOWTITLE eq Shortping Server 3033*" /T /F >nul 2>nul

rem Also stop a server started by scripts\start-local.ps1 (PID file)
if exist "data\server.pid" (
  set /p OLDPID=<"data\server.pid"
  if defined OLDPID (
    taskkill /PID !OLDPID! /T /F >nul 2>nul && set "FOUND=1"
  )
  del /q "data\server.pid" >nul 2>nul
)

timeout /t 1 >nul
netstat -ano | findstr /R /C:":3033 .*LISTENING" >nul
if not errorlevel 1 (
  echo [WARN] Port 3033 is still in use. Try running this file as Administrator.
  pause
  exit /b 1
)

if "%FOUND%"=="1" (
  echo [OK] Shortping server on port 3033 stopped.
) else (
  echo [INFO] No server was running on port 3033.
)
timeout /t 3 >nul
exit /b 0
