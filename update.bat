@echo off
title Locally Uncensored - Update
color 0D
echo.
echo       [95m╔═══════════════════════════════════════╗[0m
echo       [95m║   LOCALLY UNCENSORED - Update Check   ║[0m
echo       [95m╚═══════════════════════════════════════╝[0m
echo.

cd /d "%~dp0"

:: Check for git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Git not found. Cannot update.
    pause
    exit /b 1
)

:: Show current version
echo [*] Current version:
git log --oneline -1
echo.

:: Pull latest changes
echo [*] Checking for updates...
git pull origin master
if %errorlevel% neq 0 (
    echo.
    echo [!] Update failed. You may have local changes.
    echo     Run: git stash ^&^& git pull origin master
    pause
    exit /b 1
)

:: Reinstall dependencies if package.json changed
echo.
echo [*] Updating dependencies...
call npm install
echo.

echo [OK] Update complete!
echo.
echo     Run start.bat or setup.bat to launch the app.
echo.
pause
