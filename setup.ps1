# Locally Uncensored - Setup (PowerShell Wrapper)
# This launches setup.bat in cmd.exe where it works correctly.

$Host.UI.RawUI.WindowTitle = "Locally Uncensored - Setup"

Write-Host ""
Write-Host ""
Write-Host "    ##        #######   ######     ###    ##       ##       ##    ##" -ForegroundColor Magenta
Write-Host "    ##       ##     ## ##    ##   ## ##   ##       ##        ##  ##" -ForegroundColor Magenta
Write-Host "    ##       ##     ## ##        ##   ##  ##       ##         ####" -ForegroundColor Magenta
Write-Host "    ##       ##     ## ##       ##     ## ##       ##          ##" -ForegroundColor DarkMagenta
Write-Host "    ##       ##     ## ##       ######### ##       ##          ##" -ForegroundColor DarkMagenta
Write-Host "    ##       ##     ## ##    ## ##     ## ##       ##          ##" -ForegroundColor DarkMagenta
Write-Host "    ########  #######   ######  ##     ## ######## ########   ##" -ForegroundColor Magenta
Write-Host ""
Write-Host "    ##     ## ##    ##  ######  ######## ##    ##  ######   #######  ########  ######## ########" -ForegroundColor Magenta
Write-Host "    ##     ## ###   ## ##    ## ##       ###   ## ##    ## ##     ## ##     ## ##       ##     ##" -ForegroundColor Magenta
Write-Host "    ##     ## ####  ## ##       ##       ####  ## ##       ##     ## ##     ## ##       ##     ##" -ForegroundColor Magenta
Write-Host "    ##     ## ## ## ## ##       ######   ## ## ##  ######  ##     ## ########  ######   ##     ##" -ForegroundColor DarkMagenta
Write-Host "    ##     ## ##  #### ##       ##       ##  ####       ## ##     ## ##   ##   ##       ##     ##" -ForegroundColor DarkMagenta
Write-Host "    ##     ## ##   ### ##    ## ##       ##   ### ##    ## ##     ## ##    ##  ##       ##     ##" -ForegroundColor DarkMagenta
Write-Host "     #######  ##    ##  ######  ######## ##    ##  ######   #######  ##     ## ######## ########" -ForegroundColor Magenta
Write-Host ""
Write-Host "    Private, local AI. No cloud. No censorship. No data collection." -ForegroundColor DarkGray
Write-Host "    =================================================================" -ForegroundColor Magenta
Write-Host ""

# Check Node.js
if (Get-Command node -ErrorAction SilentlyContinue) {
    $v = node --version
    Write-Host " [+] Node.js $v" -ForegroundColor Green
} else {
    Write-Host " [::] Installing Node.js..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    Write-Host " [+] Node.js installed. Please restart PowerShell and run .\setup.ps1 again." -ForegroundColor Green
    Read-Host "Press Enter to exit"
    exit
}

# Check Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host " [+] Git" -ForegroundColor Green
} else {
    Write-Host " [::] Installing Git..." -ForegroundColor Yellow
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    Write-Host " [+] Git installed. Please restart PowerShell and run .\setup.ps1 again." -ForegroundColor Green
    Read-Host "Press Enter to exit"
    exit
}

# Check Ollama
if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host " [+] Ollama" -ForegroundColor Green
} else {
    Write-Host " [::] Installing Ollama..." -ForegroundColor Yellow
    winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements
    Write-Host " [+] Ollama installed" -ForegroundColor Green
}

# Start Ollama if not running
$ollamaRunning = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
if (-not $ollamaRunning) {
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

# Install dependencies
Write-Host ""
Write-Host " [::] Installing dependencies..." -ForegroundColor Yellow
Set-Location $PSScriptRoot
npm install --loglevel=error 2>&1 | Out-Null
Write-Host " [+] Dependencies installed" -ForegroundColor Green

# Check AI models
Write-Host ""
$models = ollama list 2>$null
if ($models -match "abliterated|llama|qwen|mistral|deepseek|gemma|phi") {
    Write-Host " [+] AI models found" -ForegroundColor Green
} else {
    Write-Host " [::] No AI model found." -ForegroundColor Yellow
    Write-Host " [::] Downloading Llama 3.1 8B Uncensored (~5.7 GB)..." -ForegroundColor Yellow
    Write-Host "      This is a one-time download. Grab a coffee." -ForegroundColor DarkGray
    Write-Host ""
    ollama pull mannix/llama3.1-8b-abliterated:q5_K_M
    Write-Host ""
    Write-Host " [+] AI model installed" -ForegroundColor Green
}

# Create desktop shortcut
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut([System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Locally Uncensored.lnk'))
$shortcut.TargetPath = Join-Path $PSScriptRoot "start.bat"
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = "Locally Uncensored - Private AI Chat"
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Host ""
Write-Host " ________________________________________________" -ForegroundColor Green
Write-Host ""
Write-Host " Setup complete! Opening in your browser..." -ForegroundColor White
Write-Host ""

# Start dev server in background, open browser
Start-Process -FilePath "cmd" -ArgumentList "/c cd /d `"$PSScriptRoot`" && npm run dev" -WindowStyle Hidden
Start-Sleep -Seconds 3
Start-Process "http://localhost:5173"
