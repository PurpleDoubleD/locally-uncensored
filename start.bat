@echo off

:: Start Ollama silently if not running
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
if %errorlevel% neq 0 (
    start "" /b ollama serve >nul 2>nul
)

:: Check for .env and start ComfyUI silently if configured
set COMFYUI_PATH=
if exist "%~dp0.env" (
    for /f "tokens=1,* delims==" %%a in (%~dp0.env) do (
        if "%%a"=="COMFYUI_PATH" set COMFYUI_PATH=%%b
    )
)
if defined COMFYUI_PATH (
    if exist "%COMFYUI_PATH%\main.py" (
        start "" /min cmd /c "cd /d %COMFYUI_PATH% && python main.py --listen 127.0.0.1 --port 8188 >nul 2>nul"
    )
)

:: Start dev server in background
start "" /b cmd /c "cd /d "%~dp0" && npm run dev >nul 2>nul"

:: Wait for server to be ready, then open browser
timeout /t 3 /nobreak >nul
start "" http://localhost:5173

:: Close this terminal
exit
