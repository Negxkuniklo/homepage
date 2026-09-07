@echo off
title JXL Converter
cd /d "%~dp0"

echo ======================================================
echo   Starting JXL Converter Server...
echo ======================================================

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    node server.js
    goto end
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Starting with Python HTTP Server...
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto end
)

echo [ERROR] Neither Node.js nor Python was found.
echo Please install Node.js (https://nodejs.org) to run this application.

:end
pause
