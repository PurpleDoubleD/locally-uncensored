@echo off
title Locally Uncensored - Setup
echo.
echo.
echo     ##        #######   ######     ###    ##       ##       ##    ##
echo     ##       ##     ## ##    ##   ## ##   ##       ##        ##  ##
echo     ##       ##     ## ##        ##   ##  ##       ##         ####
echo     ##       ##     ## ##       ##     ## ##       ##          ##
echo     ##       ##     ## ##       ######### ##       ##          ##
echo     ##       ##     ## ##    ## ##     ## ##       ##          ##
echo     ########  #######   ######  ##     ## ######## ########   ##
echo.
echo     ##  ## ##  ##  ######  ######## ##  ##  ######  #######  ########  ######## ########
echo     ##  ## ### ## ##    ## ##       ### ## ##    ## ##     ## ##     ## ##       ##     ##
echo     ##  ## ####   ##       ##       ####   ##       ##     ## ##     ## ##       ##     ##
echo     ##  ## ## ##  ##       ######   ## ##   ######  ##     ## ########  ######   ##     ##
echo     ##  ## ##  ## ##       ##       ##  ##       ## ##     ## ##   ##   ##       ##     ##
echo     ##  ## ##  ## ##    ## ##       ##  ## ##    ## ##     ## ##    ##  ##       ##     ##
echo      ####  ##  ##  ######  ######## ##  ##  ######   #######  ##    ## ######## ########
echo.
echo     Private, local AI. No cloud. No censorship. No data collection.
echo     =================================================================
echo.
echo     Automatic Setup
echo.

:: --- Step 1: Check Node.js ---
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo     [1/5] Installing Node.js...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo     [!] Could not install Node.js. Get it from https://nodejs.org/
        pause
        exit /b 1
    )
    echo     [OK] Node.js installed. Restarting...
    start "" cmd /c "cd /d "%~dp0" && setup.bat"
    exit /b 0
) else (
    for /f "tokens=*" %%i in ('node --version') do echo     [+] Node.js %%i
)

:: --- Step 2: Check Git ---
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo     [2/5] Installing Git...
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo     [!] Could not install Git. Get it from https://git-scm.com/
        pause
        exit /b 1
    )
    echo     [OK] Git installed. Restarting...
    start "" cmd /c "cd /d "%~dp0" && setup.bat"
    exit /b 0
) else (
    echo     [+] Git
)

:: --- Step 3: Check Ollama ---
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo     [3/5] Installing Ollama...
    winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo     [!] Could not install Ollama. Get it from https://ollama.com/
        pause
        exit /b 1
    )
    echo     [+] Ollama installed
) else (
    echo     [+] Ollama
)

:: Start Ollama silently
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
if %errorlevel% neq 0 (
    start "" /b ollama serve >nul 2>nul
    timeout /t 3 /nobreak >nul
)

:: --- Step 4: Install dependencies ---
echo.
echo     [4/5] Installing dependencies...
cd /d "%~dp0"
call npm install --loglevel=error
if %errorlevel% neq 0 (
    echo     [!] npm install failed.
    pause
    exit /b 1
)
echo     [+] Dependencies installed

:: --- Step 5: Check AI models ---
echo.
ollama list 2>nul | findstr /v "NAME" | findstr "." >nul 2>nul
if %errorlevel% neq 0 (
    echo     [5/5] No AI model found.
    echo     Downloading Llama 3.1 8B Uncensored (~5.7 GB)...
    echo     This is a one-time download. Grab a coffee.
    echo.
    ollama pull mannix/llama3.1-8b-abliterated:q5_K_M
    echo.
    echo     [+] AI model installed
) else (
    echo     [+] AI models found
)

:: --- Create desktop shortcut ---
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Locally Uncensored.lnk')); $s.TargetPath = '%~dp0start.bat'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'Locally Uncensored - Private AI Chat'; $s.WindowStyle = 7; $s.Save()" >nul 2>nul

echo.
echo     =================================================================
echo     Setup complete! Opening in your browser...
echo     =================================================================
echo.

:: Start dev server in background, open browser, close terminal
start "" /b cmd /c "cd /d "%~dp0" && npm run dev >nul 2>nul"
timeout /t 4 /nobreak >nul
start "" http://localhost:5173
exit
