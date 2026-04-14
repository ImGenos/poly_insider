@echo off
REM Polymarket Monitoring System - Stop Script (Windows)
REM This script stops all services gracefully

echo ==========================================
echo Stopping Polymarket Monitoring System
echo ==========================================
echo.

REM Stop PM2 services
echo 1. Stopping PM2 services...
call npx pm2 stop all
echo √ PM2 services stopped
echo.

REM Stop Docker services
echo 2. Stopping Docker services...
docker-compose down
echo √ Docker services stopped
echo.

echo ==========================================
echo √ All services stopped
echo ==========================================
echo.
echo To start again, run: start.bat
echo.
pause
