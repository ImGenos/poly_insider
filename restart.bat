@echo off
REM Polymarket Monitoring System - Quick Restart Script (Windows)
REM This script rebuilds and restarts services without reinstalling dependencies

echo ==========================================
echo Polymarket Monitoring - Quick Restart
echo ==========================================
echo.

REM Build TypeScript
echo 1. Building TypeScript...
call npm run build
echo √ Build complete
echo.

REM Restart services with PM2
echo 2. Restarting services...
call npx pm2 restart all
echo √ Services restarted
echo.

REM Show status
echo ==========================================
echo System Status:
echo ==========================================
call npx pm2 status
echo.

echo √ Restart complete!
echo.
echo View logs with: npm run logs
echo.
pause
