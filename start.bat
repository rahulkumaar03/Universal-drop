@echo off
title UniversalDrop Windows Agent
:: Ensure working directory is always this script's directory
cd /d "%~dp0"

echo ========================================================
echo   Starting UniversalDrop Agent...
echo ========================================================
node index.js
pause
