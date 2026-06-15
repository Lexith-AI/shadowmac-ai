import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

const cancellationSmokeScript = String.raw`
$ErrorActionPreference = 'Stop'
$scriptDir = (Get-Location).Path
$source = Get-Content -LiteralPath .\run.ps1 -Raw
$rootAst = [scriptblock]::Create($source).Ast
$assign = $rootAst.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$serverScript' }, $true)
if (-not $assign) { throw 'serverScript assignment not found.' }
$serverAst = [scriptblock]::Create($assign.Right.Extent.Text).Ast
$functionNames = @(
  'Normalize-ShadowRunCommandId',
  'Get-ShadowRunCancelDir',
  'Get-ShadowRunCancelPath',
  'Get-ShadowRunProcessPath',
  'Set-ShadowRunProcessMarker',
  'Get-ShadowRunProcessMarker',
  'Clear-ShadowRunCancellation',
  'Request-ShadowRunCancellation',
  'Stop-ShadowProcessTree',
  'Stop-ShadowRunProcessForCancellation',
  'Wait-ShadowProcessExit',
  'Invoke-ShadowCommandWithTimeout'
)
$defs = foreach ($name in $functionNames) {
  $fn = $serverAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $fn) { throw "Function not found: $name" }
  $fn.Extent.Text
}
$defsText = $defs -join ([Environment]::NewLine + [Environment]::NewLine)
Invoke-Expression $defsText
$results = @()
for ($i = 0; $i -lt 3; $i++) {
  $cmdId = "soak_cancel_" + $i + "_" + (([guid]::NewGuid().ToString('N')).Substring(0, 12))
  $cancelDir = Join-Path $scriptDir 'runtime\run-cancel'
  $pidPath = Join-Path $cancelDir "$cmdId.pid"
  $cancelPath = Join-Path $cancelDir "$cmdId.cancel"
  $job = $null
  try {
    $job = Start-Job -ScriptBlock {
      param($defsText, $scriptDir, $cmdId)
      $ErrorActionPreference = 'Stop'
      Invoke-Expression $defsText
      $result = Invoke-ShadowCommandWithTimeout -Command 'Start-Sleep -Seconds 30' -TimeoutMilliseconds 60000 -CommandId $cmdId
      $result | ConvertTo-Json -Compress
    } -ArgumentList $defsText, $scriptDir, $cmdId

    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path -LiteralPath $pidPath -PathType Leaf) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { throw "PID marker was not created for $cmdId." }

    $null = Request-ShadowRunCancellation -CommandId $cmdId
    $killed = Stop-ShadowRunProcessForCancellation -CommandId $cmdId
    $done = Wait-Job -Job $job -Timeout 10
    if (-not $done) { throw "Cancellation job did not finish for $cmdId." }
    $raw = Receive-Job -Job $job -ErrorAction Stop
    $result = ($raw | Select-Object -Last 1) | ConvertFrom-Json
    $markersRemaining = (Test-Path -LiteralPath $pidPath -PathType Leaf) -or (Test-Path -LiteralPath $cancelPath -PathType Leaf)
    if (-not $killed) { throw "Process marker did not kill an active process for $cmdId." }
    if ($result.status -ne 'cancelled' -or -not $result.cancelled) { throw "Expected cancelled result for $cmdId, got: $raw" }
    if ($markersRemaining) { throw "Cancellation markers were not cleaned up for $cmdId." }
    $results += [PSCustomObject]@{ command_id = $cmdId; status = $result.status; cancelled = [bool]$result.cancelled; process_killed = [bool]$killed }
  } finally {
    if ($job) {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
    Clear-ShadowRunCancellation $cmdId
  }
}
$results | ConvertTo-Json -Compress
`;

const httpCancellationSmokeScript = String.raw`
$ErrorActionPreference = 'Stop'
$scriptDir = (Get-Location).Path
$source = Get-Content -LiteralPath .\run.ps1 -Raw
$rootAst = [scriptblock]::Create($source).Ast
$assign = $rootAst.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$serverScript' }, $true)
if (-not $assign) { throw 'serverScript assignment not found.' }
$serverScript = $assign.Right.Extent.Text
if ($serverScript.TrimStart().StartsWith('{') -and $serverScript.TrimEnd().EndsWith('}')) {
  $serverScript = $serverScript.Trim()
  $serverScript = $serverScript.Substring(1, $serverScript.Length - 2)
}

$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
$browserControllerPort = 0
$serverStartedAt = [DateTimeOffset]::UtcNow.ToString('o')
$powershellThreads = @()
$runJob = $null
$cmdId = "http_cancel_" + (([guid]::NewGuid().ToString('N')).Substring(0, 12))
$cancelDir = Join-Path $scriptDir 'runtime\run-cancel'
$pidPath = Join-Path $cancelDir "$cmdId.pid"
$cancelPath = Join-Path $cancelDir "$cmdId.cancel"

try {
  for ($i = 0; $i -lt 3; $i++) {
    $threadSessionState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("listener", $listener, "The listener object")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("scriptDir", $scriptDir, "Path to script root")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("browserControllerPort", $browserControllerPort, "Browser controller port")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("port", $port, "Shadow web server port")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("serverStartedAt", $serverStartedAt, "Shadow server start time")))
    $thread = [PowerShell]::Create($threadSessionState)
    $null = $thread.AddScript($serverScript)
    $powershellThreads += $thread
    $null = $thread.BeginInvoke()
  }

  $baseUrl = "http://127.0.0.1:$port"
  $health = $null
  $deadline = (Get-Date).AddSeconds(10)
  while (-not $health -and (Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  if (-not $health -or $health.status -ne 'healthy') { throw 'HTTP smoke server did not become healthy.' }

  $runJob = Start-Job -ScriptBlock {
    param($baseUrl, $cmdId)
    $ErrorActionPreference = 'Stop'
    $body = @{ command = 'Start-Sleep -Seconds 30'; timeout_ms = 60000; command_id = $cmdId } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$baseUrl/api/run" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 70 | ConvertTo-Json -Compress
  } -ArgumentList $baseUrl, $cmdId

  $deadline = (Get-Date).AddSeconds(10)
  while (-not (Test-Path -LiteralPath $pidPath -PathType Leaf) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { throw "PID marker was not created for $cmdId." }

  $cancelBody = @{ command_id = $cmdId } | ConvertTo-Json -Compress
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $cancelResult = Invoke-RestMethod -Uri "$baseUrl/api/run/cancel" -Method Post -ContentType 'application/json' -Body $cancelBody -TimeoutSec 10
  $sw.Stop()
  if ($cancelResult.status -ne 'success') { throw "Cancel endpoint returned unexpected status: $($cancelResult | ConvertTo-Json -Compress)" }
  if (-not $cancelResult.process_killed) { throw "Cancel endpoint did not kill the active process for $cmdId." }
  if ($sw.ElapsedMilliseconds -gt 5000) { throw "Cancel endpoint took too long: $($sw.ElapsedMilliseconds)ms." }

  $done = Wait-Job -Job $runJob -Timeout 15
  if (-not $done) { throw "HTTP /api/run request did not finish after cancellation for $cmdId." }
  $raw = Receive-Job -Job $runJob -ErrorAction Stop
  $runResult = ($raw | Select-Object -Last 1) | ConvertFrom-Json
  $markersRemaining = (Test-Path -LiteralPath $pidPath -PathType Leaf) -or (Test-Path -LiteralPath $cancelPath -PathType Leaf)
  if ($runResult.status -ne 'cancelled' -or -not $runResult.cancelled) { throw "Expected cancelled HTTP run result for $cmdId, got: $raw" }
  if ($markersRemaining) { throw "HTTP cancellation markers were not cleaned up for $cmdId." }

  [PSCustomObject]@{
    status = 'success'
    command_id = $cmdId
    cancel_elapsed_ms = $sw.ElapsedMilliseconds
    process_killed = [bool]$cancelResult.process_killed
    run_status = $runResult.status
    run_cancelled = [bool]$runResult.cancelled
    markers_cleaned = (-not $markersRemaining)
  } | ConvertTo-Json -Compress
} finally {
  if ($runJob) {
    Stop-Job -Job $runJob -ErrorAction SilentlyContinue
    Remove-Job -Job $runJob -Force -ErrorAction SilentlyContinue
  }
  if ($listener) {
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
  }
  foreach ($thread in $powershellThreads) {
    try { $thread.Stop() } catch {}
    try { $thread.Dispose() } catch {}
  }
  $cancelDirForCleanup = Join-Path $scriptDir 'runtime\run-cancel'
  foreach ($path in @((Join-Path $cancelDirForCleanup "$cmdId.pid"), (Join-Path $cancelDirForCleanup "$cmdId.cancel"))) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
}
`;

describe('backend runtime smoke checks', () => {
  it('repeatedly cancels live backend command processes and cleans markers', () => {
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cancellationSmokeScript], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 1024 * 1024
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const smokeResults = JSON.parse(result.stdout.trim());
    expect(smokeResults).toHaveLength(3);
    for (const entry of smokeResults) {
      expect(entry.command_id).toMatch(/^soak_cancel_/);
      expect(entry.status).toBe('cancelled');
      expect(entry.cancelled).toBe(true);
      expect(entry.process_killed).toBe(true);
    }
  });

  it('keeps /api/run/cancel reachable while another HTTP worker is executing /api/run', () => {
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', httpCancellationSmokeScript], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const smokeResult = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    expect(smokeResult.command_id).toMatch(/^http_cancel_/);
    expect(smokeResult.status).toBe('success');
    expect(smokeResult.process_killed).toBe(true);
    expect(smokeResult.run_status).toBe('cancelled');
    expect(smokeResult.run_cancelled).toBe(true);
    expect(smokeResult.markers_cleaned).toBe(true);
    expect(smokeResult.cancel_elapsed_ms).toBeLessThan(5000);
  });
});
