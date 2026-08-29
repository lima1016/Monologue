# Start everything Monologue needs, then the app itself.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "Starting VOICEVOX..." -ForegroundColor Cyan
docker compose --project-directory $root up -d | Out-Null

Write-Host "Waiting for VOICEVOX..." -NoNewline
for ($i = 0; $i -lt 40; $i++) {
    try {
        Invoke-RestMethod "http://127.0.0.1:50021/version" -TimeoutSec 2 | Out-Null
        Write-Host " ready" -ForegroundColor Green
        break
    } catch { Write-Host "." -NoNewline; Start-Sleep -Seconds 2 }
}

try {
    Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null
    Write-Host "Ollama is running" -ForegroundColor Green
} catch {
    Write-Host "Ollama is NOT running. Open another window and run: ollama serve" -ForegroundColor Yellow
}

Write-Host "Open http://127.0.0.1:8000 in Chrome" -ForegroundColor Cyan
& "$root\venv\Scripts\python.exe" -m uvicorn app.main:app --port 8000 --app-dir $root
