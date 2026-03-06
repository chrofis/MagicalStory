@echo off
echo =======================================
echo MagicalStory Server Startup
echo =======================================
echo.

REM Check if node is installed
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed!
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo Download the LTS version and restart this script after installation.
    echo.
    pause
    exit /b 1
)

echo Node.js found:
node --version
echo npm version:
npm --version
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    echo This may take a few minutes on first run...
    echo.
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully!
    echo.
)

echo Starting server...
echo.
echo The server will start on http://localhost:3000
echo Press Ctrl+C to stop the server
echo.
echo =======================================
echo.

call npm start

pause
