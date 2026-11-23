$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    Get-Content -LiteralPath $Path | ForEach-Object {
        if ($_ -match "^([^#=]+)=(.*)$") {
            $map[$matches[1]] = $matches[2]
        }
    }
    return $map
}

function Prom-Value {
    param([string]$Query)
    $url = "http://127.0.0.1:9090/api/v1/query?query=" + [uri]::EscapeDataString($Query)
    $response = Invoke-RestMethod -Uri $url -TimeoutSec 10
    if ($response.data.result.Count -eq 0) {
        return $null
    }
    return [double]$response.data.result[0].value[1]
}

function Metric-Sum {
    param([string]$Text, [string]$Name)
    $pattern = "(?m)^" + [regex]::Escape($Name) + "(?:\{[^\r\n]*\})?\s+([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?\d+)?)\s*$"
    $matches = [regex]::Matches($Text, $pattern)
    if ($matches.Count -eq 0) { return 0 }
    return [double](($matches | ForEach-Object { [double]$_.Groups[1].Value } | Measure-Object -Sum).Sum)
}

$envMap = Read-DotEnv (Join-Path $root ".env")
$gatewayPort = $envMap["GATEWAY_PORT"]
$agentPort = $envMap["AGENT_PORT"]
$prometheusPort = $envMap["PROMETHEUS_PORT"]
$grafanaPort = $envMap["GRAFANA_PORT"]
$masterKey = $envMap["LITELLM_MASTER_KEY"]
$grafanaUser = $envMap["GRAFANA_ADMIN_USER"]
$grafanaPassword = $envMap["GRAFANA_ADMIN_PASSWORD"]

if (-not $masterKey -or -not $grafanaPassword) {
    throw "Required secrets are missing from .env"
}

$summary = [ordered]@{
    started_at = (Get-Date).ToString("o")
    services = @()
    probes = @()
    targets = @()
    gateway = $null
    sync_run = $null
    async_run = $null
    metrics = [ordered]@{}
    grafana = $null
    agent_harness = $null
    screenshot = $null
}

$statusLines = docker compose ps --format "{{.Service}} {{.Health}}"
$summary.services = @($statusLines | ForEach-Object {
    $parts = $_ -split " ", 2
    [ordered]@{ service = $parts[0]; health = $parts[1] }
})
$expectedServices = @("gateway", "agent", "prometheus", "grafana")
foreach ($service in $expectedServices) {
    $item = $summary.services | Where-Object { $_.service -eq $service }
    if (-not $item -or $item.health -ne "healthy") {
        throw "Service $service is not healthy"
    }
}

$probeUrls = @(
    "http://127.0.0.1:$gatewayPort/health/liveliness",
    "http://127.0.0.1:$agentPort/health",
    "http://127.0.0.1:$prometheusPort/-/healthy",
    "http://127.0.0.1:$grafanaPort/api/health"
)
foreach ($url in $probeUrls) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10
    $summary.probes += [ordered]@{ url = $url; status = [int]$response.StatusCode }
    if ($response.StatusCode -ne 200) {
        throw "Probe failed: $url"
    }
}

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$prometheusPort/api/v1/targets" -TimeoutSec 10
foreach ($target in $targets.data.activeTargets) {
    $summary.targets += [ordered]@{
        job = $target.labels.job
        health = $target.health
        scrape_url = $target.scrapeUrl
    }
}
$targetJobs = @($summary.targets | Where-Object { $_.health -eq "up" } | ForEach-Object { $_.job })
foreach ($job in @("gateway", "agent", "prometheus")) {
    if ($targetJobs -notcontains $job) {
        throw "Prometheus target $job is not UP"
    }
}

$capabilities = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$agentPort/v1/capabilities" `
    -TimeoutSec 10
if (
    @($capabilities.tools).Count -lt 6 -or
    @($capabilities.skills).Count -lt 10 -or
    [int]$capabilities.limits.maxLoopTurns -lt 1 -or
    [int]$capabilities.limits.maxToolCalls -lt 1 -or
    -not $capabilities.features.streaming -or
    $capabilities.features.attachmentKinds -notcontains "pdf" -or
    $capabilities.features.attachmentKinds -notcontains "docx"
) {
    throw "Agent capabilities are incomplete"
}
$summary.agent_harness = [ordered]@{
    tools = @($capabilities.tools | ForEach-Object { $_.name })
    skills = @($capabilities.skills | ForEach-Object { $_.name })
    max_loop_turns = [int]$capabilities.limits.maxLoopTurns
    max_tool_calls = [int]$capabilities.limits.maxToolCalls
    streaming = [bool]$capabilities.features.streaming
    attachment_kinds = @($capabilities.features.attachmentKinds)
}

$gatewayHeaders = @{
    Authorization = "Bearer $masterKey"
    "Content-Type" = "application/json"
}
$gatewayBody = @{
    model = "deepseek-flash"
    messages = @(@{ role = "user"; content = "用一句话说明什么是幂等" })
    max_tokens = 256
} | ConvertTo-Json -Depth 5
$gatewayResponse = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$gatewayPort/v1/chat/completions" `
    -Method Post `
    -Headers $gatewayHeaders `
    -Body $gatewayBody `
    -TimeoutSec 120
$gatewayContent = [string]$gatewayResponse.choices[0].message.content
if (-not $gatewayContent.Trim()) {
    throw "Gateway returned an empty response"
}
$summary.gateway = [ordered]@{
    status = "completed"
    finish_reason = $gatewayResponse.choices[0].finish_reason
    content_length = $gatewayContent.Length
}

$gatewayMetricsText = (& curl.exe -fsSL `
    -H "Authorization: Bearer $masterKey" `
    "http://127.0.0.1:$gatewayPort/metrics") -join "`n"
if ($LASTEXITCODE -ne 0 -or -not $gatewayMetricsText) {
    throw "Gateway metrics endpoint did not return data"
}
foreach ($metric in @(
    "litellm_proxy_total_requests_metric_total",
    "litellm_total_tokens_metric_total",
    "litellm_spend_metric_total"
)) {
    if ($gatewayMetricsText -notmatch [regex]::Escape($metric)) {
        throw "Gateway metrics endpoint is missing $metric"
    }
}
$summary.gateway.metrics_bytes = $gatewayMetricsText.Length

$agentMetricsText = (Invoke-WebRequest `
    -UseBasicParsing `
    -Uri "http://127.0.0.1:$agentPort/metrics" `
    -TimeoutSec 10).Content
if ($agentMetricsText -notmatch "agent_runs_total" -or $agentMetricsText -notmatch "agent_run_duration_ms") {
    throw "Agent metrics endpoint is missing required metrics"
}

$baselineGateway = Metric-Sum $gatewayMetricsText "litellm_proxy_total_requests_metric_total"
$baselineAgent = Metric-Sum $agentMetricsText "agent_runs_total"
$summary.metrics.baseline = [ordered]@{
    source = "direct metrics"
    gateway_requests = $baselineGateway
    agent_runs = $baselineAgent
}

$syncBody = @{
    input = "用一句话说明什么是幂等"
    tenant = "demo"
} | ConvertTo-Json
$sync = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$agentPort/v1/runs" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{ "X-Request-ID" = "req-acceptance-sync-001" } `
    -Body $syncBody `
    -TimeoutSec 120
if ($sync.status -ne "completed" -or -not ([string]$sync.output).Trim()) {
    throw "Synchronous Agent run did not complete"
}
$summary.sync_run = [ordered]@{
    run_id = $sync.run_id
    status = $sync.status
    output_length = ([string]$sync.output).Length
    total_tokens = $sync.total_tokens
}

$gatewayAfter = $baselineGateway
$agentAfter = $baselineAgent
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 1
    $agentMetricsText = (Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "http://127.0.0.1:$agentPort/metrics" `
        -TimeoutSec 10).Content
    $gatewayMetricsText = (& curl.exe -fsSL `
        -H "Authorization: Bearer $masterKey" `
        "http://127.0.0.1:$gatewayPort/metrics") -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Gateway metrics endpoint failed during growth check" }
    $gatewayAfter = Metric-Sum $gatewayMetricsText "litellm_proxy_total_requests_metric_total"
    $agentAfter = Metric-Sum $agentMetricsText "agent_runs_total"
    if ($gatewayAfter -gt $baselineGateway -and $agentAfter -gt $baselineAgent) {
        break
    }
}
if ($gatewayAfter -le $baselineGateway -or $agentAfter -le $baselineAgent) {
    throw "Agent or Gateway metrics did not increase within 60 seconds"
}

$gatewayPrometheus = 0
$agentPrometheus = 0
for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
    Start-Sleep -Seconds 2
    $gatewayValue = Prom-Value 'sum(litellm_proxy_total_requests_metric_total)'
    $agentValue = Prom-Value 'sum(agent_runs_total)'
    $gatewayPrometheus = if ($null -eq $gatewayValue) { 0 } else { $gatewayValue }
    $agentPrometheus = if ($null -eq $agentValue) { 0 } else { $agentValue }
    if ($gatewayPrometheus -ge $gatewayAfter -and $agentPrometheus -ge $agentAfter) {
        break
    }
}
if ($gatewayPrometheus -lt $gatewayAfter -or $agentPrometheus -lt $agentAfter) {
    throw "Prometheus did not observe the new Agent and Gateway counters within 30 seconds"
}
$summary.metrics.after_sync = [ordered]@{
    source = "direct metrics + Prometheus"
    gateway_requests = $gatewayAfter
    agent_runs = $agentAfter
    gateway_prometheus = $gatewayPrometheus
    agent_prometheus = $agentPrometheus
}

$asyncBody = @{
    input = "解释一次幂等操作"
    tenant = "demo"
    async = $true
} | ConvertTo-Json
$accepted = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$agentPort/v1/runs" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{ "X-Request-ID" = "req-acceptance-async-001" } `
    -Body $asyncBody `
    -TimeoutSec 30
$asyncFinal = $null
for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    $asyncFinal = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$agentPort/v1/runs/$($accepted.run_id)" `
        -TimeoutSec 10
    if ($asyncFinal.status -in @("completed", "failed")) {
        break
    }
}
if ($asyncFinal.status -ne "completed" -or -not ([string]$asyncFinal.output).Trim()) {
    throw "Asynchronous Agent run did not complete"
}
$summary.async_run = [ordered]@{
    run_id = $asyncFinal.run_id
    status = $asyncFinal.status
    output_length = ([string]$asyncFinal.output).Length
    total_tokens = $asyncFinal.total_tokens
}

$uiPage = Invoke-WebRequest `
    -UseBasicParsing `
    -Uri "http://127.0.0.1:$agentPort/ui/" `
    -TimeoutSec 10
if ($uiPage.StatusCode -ne 200 -or $uiPage.Content -notmatch "AgentCompose Workbench") {
    throw "Agent Workbench is not available"
}
$summary.agent_ui = [ordered]@{
    url = "http://127.0.0.1:$agentPort/ui/"
    status = [int]$uiPage.StatusCode
}

$basic = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes("${grafanaUser}:${grafanaPassword}")
)
$grafanaHeaders = @{ Authorization = "Basic $basic" }
$datasource = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$grafanaPort/api/datasources/uid/agent-prometheus" `
    -Headers $grafanaHeaders `
    -TimeoutSec 10
$dashboards = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$grafanaPort/api/search?query=AgentCompose%20Overview" `
    -Headers $grafanaHeaders `
    -TimeoutSec 10
if (-not ($dashboards | Where-Object { $_.uid -eq "agentcompose-overview" })) {
    throw "Grafana dashboard was not provisioned"
}
$anonymousRoot = Invoke-WebRequest `
    -UseBasicParsing `
    -Uri "http://127.0.0.1:$grafanaPort/" `
    -MaximumRedirection 5 `
    -TimeoutSec 10
$anonymousSearch = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$grafanaPort/api/search?query=AgentCompose%20Overview" `
    -TimeoutSec 10
if (
    $anonymousRoot.StatusCode -ne 200 -or
    -not ($anonymousSearch | Where-Object { $_.uid -eq "agentcompose-overview" })
) {
    throw "Grafana anonymous dashboard view is not available"
}
$summary.grafana = [ordered]@{
    datasource_uid = $datasource.uid
    dashboard_uid = "agentcompose-overview"
    dashboard_url = "http://127.0.0.1:$grafanaPort/d/agentcompose-overview/agentcompose-overview"
    anonymous_root_status = [int]$anonymousRoot.StatusCode
    anonymous_view = $true
}

$env:GRAFANA_ADMIN_USER = $grafanaUser
$env:GRAFANA_ADMIN_PASSWORD = $grafanaPassword
$env:GRAFANA_SCREENSHOT = "check/evidence/grafana-dashboard.png"
node scripts/capture-grafana.mjs | Out-Null
$summary.screenshot = (Resolve-Path "check/evidence/grafana-dashboard.png").Path

$summary.finished_at = (Get-Date).ToString("o")
$summary.status = "passed"
$outPath = Join-Path $root "check/evidence/acceptance-summary.json"
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outPath -Encoding utf8
$summary | ConvertTo-Json -Depth 8
