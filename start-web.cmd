@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js 22 or newer first. & pause & exit /b 1)
if not exist dist-web\index.html (echo Run npm install and npm run web:build first. & pause & exit /b 1)
if not defined HGHUB_HOST set HGHUB_HOST=0.0.0.0
node server\index.mjs
pause
