@echo off
REM Polymarket Monitoring System - Prerequisites Check
REM This script verifies all required software is installed

echo ==========================================
echo Prerequisites Check
echo ==========================================
echo.

set "ALL_OK=1"

REM Check Node.js
echo Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo X Node.js is NOT installed
    echo   Download from: https://nodejs.org/
    set "ALL_OK=0"
) else (
    for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
    echo √ Node.js is installed: %NODE_VERSION%
)
echo.

REM Check npm
echo Checking npm...
npm --version >nul 2>&1
if errorlevel 1 (
    echo X npm is NOT installed
    set "ALL_OK=0"
) else (
    for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
    echo √ npm is installed: %NPM_VERSION%
)
echo.

REM Check Docker
echo Checking Docker...
docker --version >nul 2>&1
if errorlevel 1 (
    echo X Docker is NOT installed
    echo   Download from: https://www.docker.com/products/docker-desktop
    set "ALL_OK=0"
) else (
    for /f "tokens=*" %%i in ('docker --version') do set DOCKER_VERSION=%%i
    echo √ Docker is installed: %DOCKER_VERSION%
)
echo.

REM Check if Docker is running
echo Checking if Docker is running...
docker info >nul 2>&1
if errorlevel 1 (
    echo X Docker is installed but NOT running
    echo   Please start Docker Desktop
    set "ALL_OK=0"
) else (
    echo √ Docker is running
)
echo.

REM Check docker-compose
echo Checking docker-compose...
docker-compose --version >nul 2>&1
if errorlevel 1 (
    echo X docker-compose is NOT installed
    set "ALL_OK=0"
) else (
    for /f "tokens=*" %%i in ('docker-compose --version') do set COMPOSE_VERSION=%%i
    echo √ docker-compose is installed: %COMPOSE_VERSION%
)
echo.

REM Check .env file
echo Checking .env file...
if exist ".env" (
    echo √ .env file exists
    echo.
    echo Checking required environment variables...
    
    findstr /C:"TELEGRAM_BOT_TOKEN" .env >nul 2>&1
    if errorlevel 1 (
        echo   X TELEGRAM_BOT_TOKEN not found in .env
        set "ALL_OK=0"
    ) else (
        echo   √ TELEGRAM_BOT_TOKEN found
    )
    
    findstr /C:"TELEGRAM_CHAT_ID" .env >nul 2>&1
    if errorlevel 1 (
        echo   X TELEGRAM_CHAT_ID not found in .env
        set "ALL_OK=0"
    ) else (
        echo   √ TELEGRAM_CHAT_ID found
    )
    
    findstr /C:"ALCHEMY_API_KEY" .env >nul 2>&1
    if errorlevel 1 (
        echo   ! ALCHEMY_API_KEY not found (optional but recommended)
    ) else (
        echo   √ ALCHEMY_API_KEY found
    )
    
    findstr /C:"MORALIS_API_KEY" .env >nul 2>&1
    if errorlevel 1 (
        echo   ! MORALIS_API_KEY not found (optional but recommended)
    ) else (
        echo   √ MORALIS_API_KEY found
    )
) else (
    echo X .env file NOT found
    echo   Copy .env.example to .env and fill in your values
    set "ALL_OK=0"
)
echo.

REM Check ports
echo Checking if required ports are available...
netstat -an | findstr ":6379" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo ! Port 6379 (Redis) is already in use
    echo   This might be okay if Redis is already running
)

netstat -an | findstr ":5433" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo ! Port 5433 (TimescaleDB) is already in use
    echo   This might be okay if TimescaleDB is already running
)
echo.

REM Final result
echo ==========================================
if "%ALL_OK%"=="1" (
    echo √ All prerequisites are met!
    echo ==========================================
    echo.
    echo You can now run: start.bat
) else (
    echo X Some prerequisites are missing
    echo ==========================================
    echo.
    echo Please install the missing software and try again.
)
echo.
pause
