@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js 22 or newer first. & pause & exit /b 1)
where pnpm >nul 2>nul || (echo Install pnpm: npm install -g pnpm & pause & exit /b 1)
call pnpm install --frozen-lockfile
if errorlevel 1 (pause & exit /b 1)
call pnpm web:build
if errorlevel 1 (pause & exit /b 1)
where ffmpeg >nul 2>nul || echo FFmpeg is missing. Browsing works, but downloads need FFmpeg on PATH.
echo Setup complete. Run start-web.cmd and open http://localhost:17651
pause
