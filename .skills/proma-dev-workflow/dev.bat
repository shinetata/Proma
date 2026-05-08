@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  Proma Dev Mode Launcher
::  Double-click to build & run the Electron app.
:: ============================================================

set "BUN=%USERPROFILE%\.bun\bin\bun.exe"

if not exist "%BUN%" (
    echo [ERROR] Bun not found: %BUN%
    echo Install from https://bun.sh
    pause
    exit /b 1
)

cd /d "%~dp0..\..\apps\electron"
if %errorlevel% neq 0 (
    echo [ERROR] Cannot find apps\electron
    pause
    exit /b 1
)

echo ============================================================
echo   Proma Dev Mode
echo   Project: %cd%
echo ============================================================
echo.

echo [1/5] Building main process...
call "%BUN%" run build:main
if %errorlevel% neq 0 goto :build_failed

echo [2/5] Building preload...
call "%BUN%" run build:preload
if %errorlevel% neq 0 goto :build_failed

echo [3/5] Building preview preload...
call "%BUN%" run build:preview-preload
if %errorlevel% neq 0 goto :build_failed

echo [4/5] Copying resources...
call "%BUN%" run build:resources
if %errorlevel% neq 0 goto :build_failed

echo [5/5] Build complete.
echo.

echo Tip: For mobile pairing, start Gateway in another terminal:
echo   cd services\gateway ^&^& bun run dev
echo.

echo ============================================================
echo   Starting dev servers...
echo   Vite      - renderer HMR (hot reload)
echo   Electron  - auto-restart on dist changes
echo ============================================================
echo.

start "Proma Vite" "%BUN%" run dev:vite

timeout /t 3 /nobreak >nul

start "Proma Electron" "%BUN%" x electronmon .

echo.
echo Dev servers started in separate windows.
echo.
echo After code changes:
echo   renderer (src\renderer\) - Vite HMR, instant
echo   main     (src\main\)     - re-run this script or: bun run build:main
echo   preload  (src\preload\)  - re-run this script or: bun run build:preload
echo.
echo Close this window anytime, servers keep running.
echo ============================================================
pause
goto :eof

:build_failed
echo.
echo ============================================================
echo   BUILD FAILED - Check errors above.
echo ============================================================
pause
exit /b 1