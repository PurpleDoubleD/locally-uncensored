@echo off
title Locally Uncensored - Setup

:: Enable ANSI/VT100 in CMD
for /f %%a in ('echo prompt $E^| cmd') do set "ESC=%%a"

echo.
echo.
echo %ESC%[95m    ##        #######   ######     ###    ##       ##       ##    ##%ESC%[0m
echo %ESC%[95m    ##       ##     ## ##    ##   ## ##   ##       ##        ##  ##%ESC%[0m
echo %ESC%[35m    ##       ##     ## ##        ##   ##  ##       ##         ####%ESC%[0m
echo %ESC%[35m    ##       ##     ## ##       ##     ## ##       ##          ##%ESC%[0m
echo %ESC%[35m    ##       ##     ## ##       ######### ##       ##          ##%ESC%[0m
echo %ESC%[95m    ##       ##     ## ##    ## ##     ## ##       ##          ##%ESC%[0m
echo %ESC%[95m    ########  #######   ######  ##     ## ######## ########   ##%ESC%[0m
echo.
echo %ESC%[95m    ##     ## ##    ##  ######  ######## ##    ##  ######   #######  ########  ######## ########%ESC%[0m
echo %ESC%[95m    ##     ## ###   ## ##    ## ##       ###   ## ##    ## ##     ## ##     ## ##       ##     ##%ESC%[0m
echo %ESC%[35m    ##     ## ####  ## ##       ##       ####  ## ##       ##     ## ##     ## ##       ##     ##%ESC%[0m
echo %ESC%[35m    ##     ## ## ## ## ##       ######   ## ## ##  ######  ##     ## ########  ######   ##     ##%ESC%[0m
echo %ESC%[35m    ##     ## ##  #### ##       ##       ##  ####       ## ##     ## ##   ##   ##       ##     ##%ESC%[0m
echo %ESC%[95m    ##     ## ##   ### ##    ## ##       ##   ### ##    ## ##     ## ##    ##  ##       ##     ##%ESC%[0m
echo %ESC%[95m     #######  ##    ##  ######  ######## ##    ##  ######   #######  ##     ## ######## ########%ESC%[0m
echo.
echo %ESC%[90m    Private, local AI. No cloud. No censorship. No data collection.%ESC%[0m
echo %ESC%[95m    =================================================================%ESC%[0m
echo.
echo %ESC%[97m    Automatic Setup%ESC%[0m
echo.

:: --- Step 1: Check Node.js ---
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo    %ESC%[93m[1/5]%ESC%[0m Installing Node.js...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements >nul 2>nul
    if %errorlevel% neq 0 (
        echo    %ESC%[91m[!]%ESC%[0m Could not install Node.js. Get it from https://nodejs.org/
        timeout /t 10
        exit /b 1
    )
    echo    %ESC%[92m[+]%ESC%[0m Node.js installed. Restarting...
    start "" cmd /c "cd /d "%~dp0" && setup.bat"
    exit /b 0
) else (
    for /f "tokens=*" %%i in ('node --version') do echo    %ESC%[92m[+]%ESC%[0m Node.js %%i
)

:: --- Step 2: Check Git ---
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo    %ESC%[93m[2/5]%ESC%[0m Installing Git...
    winget install Git.Git --accept-package-agreements --accept-source-agreements >nul 2>nul
    if %errorlevel% neq 0 (
        echo    %ESC%[91m[!]%ESC%[0m Could not install Git. Get it from https://git-scm.com/
        timeout /t 10
        exit /b 1
    )
    echo    %ESC%[92m[+]%ESC%[0m Git installed. Restarting...
    start "" cmd /c "cd /d "%~dp0" && setup.bat"
    exit /b 0
) else (
    echo    %ESC%[92m[+]%ESC%[0m Git
)

:: --- Step 3: Check Ollama ---
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo    %ESC%[93m[3/5]%ESC%[0m Installing Ollama...
    winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements >nul 2>nul
    if %errorlevel% neq 0 (
        echo    %ESC%[91m[!]%ESC%[0m Could not install Ollama. Get it from https://ollama.com/
        timeout /t 10
        exit /b 1
    )
    echo    %ESC%[92m[+]%ESC%[0m Ollama
) else (
    echo    %ESC%[92m[+]%ESC%[0m Ollama
)

:: Start Ollama silently
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
if %errorlevel% neq 0 (
    start "" /b ollama serve >nul 2>nul
    timeout /t 3 /nobreak >nul
)

:: --- Step 4: Install dependencies ---
echo.
echo    %ESC%[93m[4/5]%ESC%[0m Installing dependencies...
cd /d "%~dp0"
call npm install --loglevel=error >nul 2>nul
if %errorlevel% neq 0 (
    echo    %ESC%[91m[!]%ESC%[0m npm install failed.
    timeout /t 10
    exit /b 1
)
echo    %ESC%[92m[+]%ESC%[0m Dependencies installed

:: --- Step 5: Check AI models ---
echo.
ollama list 2>nul | findstr /v "NAME" | findstr "." >nul 2>nul
if %errorlevel% neq 0 (
    echo    %ESC%[93m[5/5]%ESC%[0m No AI model found.
    echo    %ESC%[93m      Downloading Llama 3.1 8B Uncensored (~5.7 GB)...%ESC%[0m
    echo    %ESC%[90m      This is a one-time download. Grab a coffee.%ESC%[0m
    echo.
    ollama pull mannix/llama3.1-8b-abliterated:q5_K_M
    echo.
    echo    %ESC%[92m[+]%ESC%[0m AI model installed
) else (
    echo    %ESC%[92m[+]%ESC%[0m AI models found
)

:: --- Create desktop shortcut ---
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Locally Uncensored.lnk')); $s.TargetPath = '%~dp0start.bat'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'Locally Uncensored - Private AI Chat'; $s.WindowStyle = 7; $s.Save()" >nul 2>nul

echo.
echo %ESC%[92m    =================================================================%ESC%[0m
echo.
echo %ESC%[97m    Setup complete!%ESC%[0m %ESC%[90mOpening in your browser...%ESC%[0m
echo.

:: Start dev server in background, open browser, close terminal
start "" /b cmd /c "cd /d "%~dp0" && npm run dev >nul 2>nul"
timeout /t 3 /nobreak >nul
start "" http://localhost:5173
exit
