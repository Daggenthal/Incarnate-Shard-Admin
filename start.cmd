@echo off
rem Starts Incarnate Shard Admin on Windows: installs Electron the first time, then opens the window.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules\electron (echo Shard Admin: first run, installing Electron & call npm install --no-audit --no-fund)
call npm start --silent
