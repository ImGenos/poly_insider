@echo off
REM Polymarket Monitoring System - Full Start Script (Windows)
REM This script performs a complete setup and start of all services

echo ==========================================
echo Polymarket Monitoring System - Full Start
echo ==========================================
echo.

REM Check if Docker is running
echo 1. Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
    echo X Error: Docker is not running. Please start Docker Desktop first.
    pause
    exit /b 1
)
echo √ Docker is running
echo.

REM Start Docker services (Redis ^& TimescaleDB)
echo 2. Starting Docker services (Redis ^& TimescaleDB^)...
docker-compose up -d
echo √ Docker services started
echo.

REM Wait for services to be ready
echo 3. Waiting for services to be ready...
timeout /t 5 /nobreak >nul
echo √ Services ready
echo.

REM Install dependencies (only if node_modules doesn't exist)
if not exist "node_modules\" (
    echo 4. Installing dependencies...
    call npm install
    echo √ Dependencies installed
) else (
    echo 4. Dependencies already up to date (skipping npm install^)
)
echo.

REM Build TypeScript
echo 5. Building TypeScript...
call npm run build
echo √ Build complete
echo.

REM Start services with PM2
echo 6. Starting services with PM2...
call npx pm2 start ecosystem.config.js
echo √ Services started
echo.

REM Show status
echo ==========================================
echo System Status:
echo ==========================================
call npx pm2 status
echo.

echo ==========================================
echo √ All services are running!
echo ==========================================
echo.
echo Useful commands:
echo   - View logs:        npm run logs
echo   - Stop services:    stop.bat
echo   - Restart services: restart.bat
echo   - Check status:     npx pm2 status
echo.
pause
