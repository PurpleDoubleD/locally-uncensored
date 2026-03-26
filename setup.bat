@echo off
title Locally Uncensored - Setup
echo.
echo.
powershell -NoProfile -Command ^
  "Write-Host '    ##        #######   ######     ###    ##       ##       ##    ##' -F Magenta;Write-Host '    ##       ##     ## ##    ##   ## ##   ##       ##        ##  ##' -F Magenta;Write-Host '    ##       ##     ## ##        ##   ##  ##       ##         ####' -F DarkMagenta;Write-Host '    ##       ##     ## ##       ##     ## ##       ##          ##' -F DarkMagenta;Write-Host '    ##       ##     ## ##       ######### ##       ##          ##' -F DarkMagenta;Write-Host '    ##       ##     ## ##    ## ##     ## ##       ##          ##' -F Magenta;Write-Host '    ########  #######   ######  ##     ## ######## ########   ##' -F Magenta;Write-Host '';Write-Host '    ##  ## ##  ##  ######  ######## ##  ##  ######   #######  ########  ######## ########' -F Magenta;Write-Host '    ##  ## ### ## ##    ## ##       ### ## ##    ## ##     ## ##     ## ##       ##     ##' -F Magenta;Write-Host '    ##  ## ####   ##       ##       ####   ##       ##     ## ##     ## ##       ##     ##' -F DarkMagenta;Write-Host '    ##  ## ## ##  ##       ######   ## ##   ######  ##     ## ########  ######   ##     ##' -F DarkMagenta;Write-Host '    ##  ## ##  ## ##       ##       ##  ##       ## ##     ## ##   ##   ##       ##     ##' -F DarkMagenta;Write-Host '    ##  ## ##  ## ##    ## ##       ##  ## ##    ## ##     ## ##    ##  ##       ##     ##' -F Magenta;Write-Host '     ####  ##  ##  ######  ######## ##  ##  ######   #######  ##    ## ######## ########' -F Magenta;Write-Host '';Write-Host '    Private, local AI. No cloud. No censorship.' -F DarkGray;Write-Host '    =================================================' -F Magenta"
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Write-Host '    [1/5] Installing Node.js...' -F Yellow"
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    powershell -NoProfile -Command "Write-Host '    [+] Node.js installed. Please close and run setup.bat again.' -F Green"
    pause
    exit /b 0
)
powershell -NoProfile -Command "Write-Host '    [+] Node.js' -F Green"

where git >nul 2>nul
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Write-Host '    [2/5] Installing Git...' -F Yellow"
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    powershell -NoProfile -Command "Write-Host '    [+] Git installed. Please close and run setup.bat again.' -F Green"
    pause
    exit /b 0
)
powershell -NoProfile -Command "Write-Host '    [+] Git' -F Green"

where ollama >nul 2>nul
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Write-Host '    [3/5] Installing Ollama...' -F Yellow"
    winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements
    powershell -NoProfile -Command "Write-Host '    [+] Ollama installed' -F Green"
) else (
    powershell -NoProfile -Command "Write-Host '    [+] Ollama' -F Green"
)

echo.
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
if %errorlevel% neq 0 (
    start "" ollama serve
    timeout /t 3 /nobreak >nul
)

powershell -NoProfile -Command "Write-Host '    [4/5] Installing dependencies...' -F Yellow"
cd /d "%~dp0"
call npm install --loglevel=error
powershell -NoProfile -Command "Write-Host '    [+] Dependencies installed' -F Green"

echo.
ollama list 2>nul | findstr /v "NAME" | findstr "." >nul 2>nul
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Write-Host '    [5/5] No AI model found.' -F Yellow"
    powershell -NoProfile -Command "Write-Host '    Downloading Llama 3.1 8B Uncensored (~5.7 GB)...' -F Yellow"
    powershell -NoProfile -Command "Write-Host '    This is a one-time download. Grab a coffee.' -F DarkGray"
    echo.
    ollama pull mannix/llama3.1-8b-abliterated:q5_K_M
    echo.
    powershell -NoProfile -Command "Write-Host '    [+] AI model installed' -F Green"
) else (
    powershell -NoProfile -Command "Write-Host '    [+] AI models found' -F Green"
)

echo.
powershell -NoProfile -Command "Write-Host '    =================================================' -F Green;Write-Host '    Setup complete! Starting app...' -F White;Write-Host '    =================================================' -F Green"
echo.

start http://localhost:5173
npm run dev
