$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

docker compose up -d agent | Out-Null
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:8080/health" -TimeoutSec 3
        if ($health.status -eq "ok") { break }
    } catch {
        Start-Sleep -Seconds 1
    }
}
if ($health.status -ne "ok") {
    throw "Agent did not become healthy"
}

$deleted = 0
while ($true) {
    $response = Invoke-RestMethod "http://127.0.0.1:8080/v1/runs?limit=100" -TimeoutSec 10
    $sessions = @($response.items | ForEach-Object { $_.session_id } | Sort-Object -Unique)
    if ($sessions.Count -eq 0) { break }
    foreach ($sessionId in $sessions) {
        $result = Invoke-RestMethod `
            -Uri "http://127.0.0.1:8080/v1/sessions/$([uri]::EscapeDataString($sessionId))" `
            -Method Delete `
            -TimeoutSec 10
        $deleted += [int]$result.deleted_runs
    }
}

[pscustomobject]@{
    status = "cleared"
    deleted_runs = $deleted
} | ConvertTo-Json -Compress
