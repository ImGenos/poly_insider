@echo off
REM Polymarket Monitoring System - Status Check Script (Windows)

echo ==========================================
echo Polymarket Monitoring System - Status
echo ==========================================
echo.

echo Docker Services:
echo ----------------------------------------
docker ps --filter "name=polynsider" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo.

echo PM2 Services:
echo ----------------------------------------
call npx pm2 status
echo.

echo Recent Logs (last 10 lines):
echo ----------------------------------------
echo.
echo [Ingestor Output]
type logs\ingestor-out.log 2>nul | findstr /N "^" | findstr /R "^[0-9]*:" | more +1 | findstr /R "[0-9]*:.*" | more +0 | tail -10 2>nul
if errorlevel 1 (
    powershell -Command "Get-Content logs\ingestor-out.log -Tail 10 -ErrorAction SilentlyContinue"
)
echo.
echo [Analyzer Output]
type logs\analyzer-out.log 2>nul | findstr /N "^" | findstr /R "^[0-9]*:" | more +1 | findstr /R "[0-9]*:.*" | more +0 | tail -10 2>nul
if errorlevel 1 (
    powershell -Command "Get-Content logs\analyzer-out.log -Tail 10 -ErrorAction SilentlyContinue"
)
echo.

echo ==========================================
echo.
pause
