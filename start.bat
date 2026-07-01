@echo off
:: Change directory to the folder where this batch file is located
cd /d "%~dp0"

title StreamVault Launcher
echo =========================================
echo       StreamVault Torrent Streamer       
echo =========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/ first.
    pause
    exit /b 1
)

:: Check if node_modules exists, if not install dependencies
if not exist "node_modules\" (
    echo [INFO] Installing dependencies, please wait...
    call npm install
)

:: Start the server
echo [INFO] Starting StreamVault server...
start /b node server.js

:: Wait for the server to start
timeout /t 2 /nobreak >nul

:: Open browser
echo [INFO] Launching app in browser...
start http://localhost:9091

echo.
echo =========================================
echo StreamVault is now running!
echo Keep this window open to continue streaming.
echo Press Ctrl+C in this window to stop the server.
echo =========================================
echo.

:: Hold window open
pause
