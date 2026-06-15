# PowerShell Launcher for Shadow AI (inspired by "Her")
# Hosts the static files locally to allow microphone API access and runs Chrome in borderless app mode.

$serverProcess = $null
$browserProc = $null
$schedulerProc = $null
$appProcess = $null
$port = 8000
$hostAddress = "127.0.0.1"
$env:GIT_TERMINAL_PROMPT = "0"

# Check if script is running from script root
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = $PSScriptRoot
}
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = Get-Location
}

# Prefer runtimes bundled by the installer (runtime/node, runtime/python) so the installed
# app needs nothing on the system PATH. Falls back to PATH `node` / a dev venv otherwise.
$bundledNodeExe = Join-Path $scriptDir "runtime\node\node.exe"
$nodeCmd = if (Test-Path $bundledNodeExe) { $bundledNodeExe } else { "node" }
$bundledPythonExe = Join-Path $scriptDir "runtime\python\python.exe"

# Resolve port conflicts by finding the next open port
while ($true) {
    $portActive = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if (-not $portActive) { break }
    $port++
}

Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "Initializing Shadow AI Companion Core" -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "Local Directory: $scriptDir" -ForegroundColor DarkGray
Write-Host "Target Port: $port" -ForegroundColor DarkGray

# 1. Detect and Start Local Server (Always use native PowerShell HTTP listener to allow system execution)
$serverType = "powershell"
Write-Host "[Server] Starting native PowerShell HTTP Listener..." -ForegroundColor Green
$serverStartedAt = [DateTimeOffset]::UtcNow.ToString("o")

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://$($hostAddress):$($port)/")
try {
    $listener.Start()
} catch {
    Write-Host "[Error] Failed to start native HTTP Listener. Port $port may be in use." -ForegroundColor Red
    Write-Host "[Hint] Start Shadow with run.bat so this window stays open and shows startup errors." -ForegroundColor Yellow
    Read-Host "Press ENTER to close"
    Exit 1
}

$staleCancelDirs = @(
    (Join-Path $scriptDir "runtime\run-cancel"),
    (Join-Path $scriptDir "runtime\request-cancel")
)
$staleCancelCutoff = [DateTime]::UtcNow.AddHours(-12)
foreach ($staleCancelDir in $staleCancelDirs) {
    if (Test-Path -LiteralPath $staleCancelDir -PathType Container) {
        Get-ChildItem -LiteralPath $staleCancelDir -File -ErrorAction SilentlyContinue |
            Where-Object { ($_.Name -like "*.cancel" -or $_.Name -like "*.pid") -and $_.LastWriteTimeUtc -lt $staleCancelCutoff } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

# Browser automation is intentionally disabled. Research must use the configured
# SearXNG search proxy, and URLs should be opened in the user's default browser
# with Start-Process only when the user explicitly asks to open a page.
$browserControllerPort = 9222
Write-Host "[Browser] Managed browser controller disabled." -ForegroundColor DarkYellow

# Auto-start the scheduler/cron microservice (persistent, non-blocking)
$schedulerPath = Join-Path $scriptDir "scheduler.js"
if (Test-Path $schedulerPath) {
    $schedulerAlreadyRunning = $false
    try {
        $existingSchedulerStatus = Invoke-RestMethod -Uri "http://127.0.0.1:9333/api/health" -Method GET -TimeoutSec 2
        if ($existingSchedulerStatus.status -eq "healthy") { $schedulerAlreadyRunning = $true }
    } catch {}

    if ($schedulerAlreadyRunning) {
        Write-Host "[Scheduler] Existing scheduler service on port 9333 detected; reusing it." -ForegroundColor DarkYellow
    } else {
        $staleScheduler = Get-NetTCPConnection -LocalPort 9333 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($staleScheduler) {
            Write-Host "[Scheduler] Port 9333 is occupied by an unresponsive process (PID: $($staleScheduler.OwningProcess)). Killing..." -ForegroundColor DarkYellow
            Stop-Process -Id $staleScheduler.OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
        Write-Host "[Scheduler] Starting persistent scheduler service on port 9333..." -ForegroundColor Magenta
        $schedulerProc = Start-Process -FilePath $nodeCmd -ArgumentList $schedulerPath -NoNewWindow -PassThru
        Write-Host "[Scheduler] Service PID: $($schedulerProc.Id)" -ForegroundColor DarkGray
    }
} else {
    Write-Host "[Scheduler] scheduler.js not found, skipping." -ForegroundColor DarkYellow
}

# Auto-start the bundled, built-in SearXNG web-search backend (no Docker needed).
# This payload is produced by tools/prepare-searxng.ps1 and shipped in the packaged
# installer at <scriptDir>/searxng (an embedded venv + the SearXNG source). When the
# payload is absent (e.g. a plain source checkout), this block is inert and web search
# falls back to a user-configured SearXNG, so nothing changes for developers.
$searxngHome = Join-Path $scriptDir "searxng"
# Prefer the installer's bundled relocatable Python; fall back to a dev venv from
# tools/prepare-searxng.ps1 (searxng/venv).
$searxngPy = if (Test-Path $bundledPythonExe) { $bundledPythonExe } else { Join-Path $searxngHome "venv\Scripts\python.exe" }
$searxngApp = Join-Path $searxngHome "app"
$searxngSettings = Join-Path $searxngHome "settings.yml"
$searxngPort = 8888
if ((Test-Path $searxngPy) -and (Test-Path (Join-Path $searxngApp "searx\webapp.py"))) {
    $searxngListening = Get-NetTCPConnection -LocalPort $searxngPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($searxngListening) {
        Write-Host "[Search] A service is already listening on port $searxngPort; reusing it for web search." -ForegroundColor DarkYellow
    } else {
        try {
            # Generate settings.yml with a random secret_key on first run. JSON format is
            # enabled (the API /api/search relies on it) and the rate limiter is off (local single user).
            if (-not (Test-Path $searxngSettings)) {
                $searxngSecret = ([guid]::NewGuid().ToString('N')) + ([guid]::NewGuid().ToString('N'))
                @"
use_default_settings:
  engines:
    remove:
      - ahmia
      - torch
general:
  debug: false
server:
  secret_key: "$searxngSecret"
  bind_address: "127.0.0.1"
  port: $searxngPort
  limiter: false
search:
  formats:
    - html
    - json
"@ | Set-Content -Encoding utf8 $searxngSettings
            }
            Write-Host "[Search] Starting built-in SearXNG on http://127.0.0.1:$searxngPort ..." -ForegroundColor Magenta
            $env:SEARXNG_SETTINGS_PATH = $searxngSettings
            # Redirect SearXNG's output to log files so its engine warnings/tracebacks
            # (e.g. an engine being rate-limited) don't clutter Shadow's console. Search
            # still works; the detail is in searxng/searxng*.log for debugging.
            $searxngOutLog = Join-Path $searxngHome "searxng.log"
            $searxngErrLog = Join-Path $searxngHome "searxng-err.log"
            $searxngProc = Start-Process -FilePath $searxngPy -ArgumentList '-m', 'searx.webapp' -WorkingDirectory $searxngApp -NoNewWindow -PassThru -RedirectStandardOutput $searxngOutLog -RedirectStandardError $searxngErrLog
            Write-Host "[Search] Built-in SearXNG PID: $($searxngProc.Id)" -ForegroundColor DarkGray
        } catch {
            Write-Host "[Search] Failed to start built-in SearXNG: $($_.Exception.Message). Web search will fall back to a configured SearXNG if available." -ForegroundColor DarkYellow
        }
    }
} else {
    Write-Host "[Search] No bundled search backend present; using a configured SearXNG (e.g. local Docker) if available." -ForegroundColor DarkGray
}

# Define the HTTP Listener loop script block
$serverScript = {
    function Test-ShadowWriteCommand {
        param([string]$Command)
        if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
        return $Command -match '(?i)\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|set-itemproperty|del|erase|rm|rmdir|mkdir|ni|sc)\b|>>|(^|\s)>'
    }

    function Test-ShadowProtectedWriteCommand {
        param([string]$Command)
        if (-not (Test-ShadowWriteCommand $Command)) { return $false }

        $lower = $Command.ToLowerInvariant()
        # Shadow may maintain its own source when the user explicitly asks.
        # Keep hard guards only for repository metadata and memory storage that
        # has a dedicated API/encoding path.
        if ($lower -match '\.git\b|[\\/]shadow-ai[\\/]\.git\b') { return $true }
        # Block writes to memories.json via PowerShell — it must only be written through /api/memories to ensure UTF-8 encoding
        if ($lower -match 'memories\.json') { return $true }
        return $false
    }

    function Sanitize-ShadowSshCommand {
        param([string]$Command)
        if ([string]::IsNullOrWhiteSpace($Command)) { return $Command }
        if ($Command -match '(?i)(?<![\w-])ssh(?![\w-])' -and $Command -notmatch 'BatchMode') {
            $Command = [regex]::Replace($Command, '(?i)(?<![\w-])ssh(?![\w-])', 'ssh -n -o BatchMode=yes -o ConnectTimeout=15')
        }
        return $Command
    }

    function Resolve-ShadowStartProcessShortcutCommand {
        param([string]$Command)
        if ([string]::IsNullOrWhiteSpace($Command)) { return $Command }

        $match = [regex]::Match($Command, "(?i)\bStart-Process\s+(?:-FilePath\s+)?(?:""([^""]+\.lnk)""|'([^']+\.lnk)')")
        if (-not $match.Success) { return $Command }

        $requestedPath = $match.Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($requestedPath)) {
            $requestedPath = $match.Groups[2].Value
        }
        if ([string]::IsNullOrWhiteSpace($requestedPath) -or (Test-Path -LiteralPath $requestedPath -PathType Leaf)) {
            return $Command
        }

        $shortcutName = Split-Path -Path $requestedPath -Leaf
        if ([string]::IsNullOrWhiteSpace($shortcutName)) { return $Command }

        $roots = @(
            (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
            "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
        )
        $candidates = @()
        foreach ($root in $roots) {
            if (Test-Path -LiteralPath $root -PathType Container) {
                $candidates += Get-ChildItem -LiteralPath $root -Recurse -Filter $shortcutName -File -ErrorAction SilentlyContinue
            }
        }

        $candidate = @($candidates | Sort-Object FullName | Select-Object -First 1)[0]
        if ($null -eq $candidate) { return $Command }

        Write-Host "[Run] Resolved missing shortcut '$requestedPath' to '$($candidate.FullName)'." -ForegroundColor DarkGray
        return $Command.Replace($requestedPath, $candidate.FullName)
    }

    function Get-ShadowRunTimeoutMilliseconds {
        param($JsonBody)
        $defaultTimeoutMs = 120000
        if ($null -eq $JsonBody -or -not ($JsonBody.PSObject.Properties.Name -contains "timeout_ms")) {
            return $defaultTimeoutMs
        }
        try {
            $requested = [int]$JsonBody.timeout_ms
            if ($requested -lt 1000) { return 1000 }
            if ($requested -gt 3600000) { return 3600000 }
            return $requested
        } catch {
            return $defaultTimeoutMs
        }
    }

    function Get-ShadowSearchTimeoutMilliseconds {
        param($JsonBody)
        $defaultTimeoutMs = 20000
        if ($null -eq $JsonBody -or -not ($JsonBody.PSObject.Properties.Name -contains "timeout_ms")) {
            return $defaultTimeoutMs
        }
        try {
            $requested = [int]$JsonBody.timeout_ms
            if ($requested -lt 3000) { return 3000 }
            if ($requested -gt 30000) { return 30000 }
            return $requested
        } catch {
            return $defaultTimeoutMs
        }
    }

    function Get-ShadowSearchAttemptTimeoutMilliseconds {
        param(
            [DateTime]$StartedAt,
            [int]$TimeoutMilliseconds
        )
        $elapsedMs = [int]([DateTime]::UtcNow - $StartedAt).TotalMilliseconds
        $remainingMs = $TimeoutMilliseconds - $elapsedMs - 250
        if ($remainingMs -le 0) { return 0 }
        if ($remainingMs -lt 1000) { return 1000 }
        if ($remainingMs -gt 8000) { return 8000 }
        return $remainingMs
    }

    function Get-ShadowProxyTimeoutMilliseconds {
        param(
            $JsonBody,
            [int]$DefaultTimeoutMilliseconds = 120000
        )
        if ($null -eq $JsonBody -or -not ($JsonBody.PSObject.Properties.Name -contains "timeout_ms")) {
            return $DefaultTimeoutMilliseconds
        }
        try {
            $requested = [int]$JsonBody.timeout_ms
            if ($requested -lt 5000) { return 5000 }
            if ($requested -gt 300000) { return 300000 }
            return $requested
        } catch {
            return $DefaultTimeoutMilliseconds
        }
    }

    function Get-ShadowGoogleUploadTimeoutMilliseconds {
        param($JsonBody)
        $defaultTimeoutMs = 30 * 60 * 1000
        if ($null -eq $JsonBody -or -not ($JsonBody.PSObject.Properties.Name -contains "timeout_ms")) {
            return $defaultTimeoutMs
        }
        try {
            $requested = [int]$JsonBody.timeout_ms
            if ($requested -lt 5000) { return 5000 }
            if ($requested -gt (6 * 60 * 60 * 1000)) { return 6 * 60 * 60 * 1000 }
            return $requested
        } catch {
            return $defaultTimeoutMs
        }
    }

    function Normalize-ShadowRunCommandId {
        param([string]$CommandId)
        $clean = ([string]$CommandId).Trim()
        if ([string]::IsNullOrWhiteSpace($clean)) { return "" }
        $clean = [regex]::Replace($clean, '[^A-Za-z0-9_.-]', '_')
        if ($clean.Length -gt 120) { $clean = $clean.Substring(0, 120) }
        return $clean
    }

    function Get-ShadowRunCancelDir {
        $cancelDir = Join-Path $scriptDir "runtime\run-cancel"
        if (-not (Test-Path -LiteralPath $cancelDir -PathType Container)) {
            New-Item -ItemType Directory -Path $cancelDir -Force | Out-Null
        }
        return $cancelDir
    }

    function Get-ShadowRunCancelPath {
        param([string]$CommandId)
        $cleanId = Normalize-ShadowRunCommandId $CommandId
        if ([string]::IsNullOrWhiteSpace($cleanId)) { return $null }
        return (Join-Path (Get-ShadowRunCancelDir) "$cleanId.cancel")
    }

    function Get-ShadowRunProcessPath {
        param([string]$CommandId)
        $cleanId = Normalize-ShadowRunCommandId $CommandId
        if ([string]::IsNullOrWhiteSpace($cleanId)) { return $null }
        return (Join-Path (Get-ShadowRunCancelDir) "$cleanId.pid")
    }

    function Set-ShadowRunProcessMarker {
        param(
            [string]$CommandId,
            [System.Diagnostics.Process]$Process
        )
        $processPath = Get-ShadowRunProcessPath $CommandId
        if ([string]::IsNullOrWhiteSpace($processPath) -or -not $Process) { return }
        $startedAtUtc = [DateTime]::UtcNow.ToString("o")
        try { $startedAtUtc = $Process.StartTime.ToUniversalTime().ToString("o") } catch {}
        $marker = [PSCustomObject]@{
            pid = $Process.Id
            startedAtUtc = $startedAtUtc
        }
        [System.IO.File]::WriteAllText($processPath, ($marker | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
    }

    function Get-ShadowRunProcessMarker {
        param([string]$CommandId)
        $processPath = Get-ShadowRunProcessPath $CommandId
        if ([string]::IsNullOrWhiteSpace($processPath) -or -not (Test-Path -LiteralPath $processPath -PathType Leaf)) { return $null }
        try {
            return (Get-Content -LiteralPath $processPath -Raw -ErrorAction Stop | ConvertFrom-Json)
        } catch {
            return $null
        }
    }

    function Clear-ShadowRunCancellation {
        param([string]$CommandId)
        $cancelPath = Get-ShadowRunCancelPath $CommandId
        $processPath = Get-ShadowRunProcessPath $CommandId
        foreach ($path in @($cancelPath, $processPath)) {
            if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path -PathType Leaf)) {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
    }

    function Request-ShadowRunCancellation {
        param([string]$CommandId)
        $cancelPath = Get-ShadowRunCancelPath $CommandId
        if ([string]::IsNullOrWhiteSpace($cancelPath)) {
            throw "Missing command_id."
        }
        [System.IO.File]::WriteAllText($cancelPath, ([DateTimeOffset]::UtcNow.ToString("o")), [System.Text.Encoding]::UTF8)
        return (Normalize-ShadowRunCommandId $CommandId)
    }

    function Normalize-ShadowRequestId {
        param([string]$RequestId)
        $clean = ([string]$RequestId).Trim()
        if ([string]::IsNullOrWhiteSpace($clean)) { return "" }
        $clean = [regex]::Replace($clean, '[^A-Za-z0-9_.-]', '_')
        if ($clean.Length -gt 120) { $clean = $clean.Substring(0, 120) }
        return $clean
    }

    function Get-ShadowRequestCancelDir {
        $cancelDir = Join-Path $scriptDir "runtime\request-cancel"
        if (-not (Test-Path -LiteralPath $cancelDir -PathType Container)) {
            New-Item -ItemType Directory -Path $cancelDir -Force | Out-Null
        }
        return $cancelDir
    }

    function Get-ShadowRequestCancelPath {
        param([string]$RequestId)
        $cleanId = Normalize-ShadowRequestId $RequestId
        if ([string]::IsNullOrWhiteSpace($cleanId)) { return $null }
        return (Join-Path (Get-ShadowRequestCancelDir) "$cleanId.cancel")
    }

    function Request-ShadowRequestCancellation {
        param([string]$RequestId)
        $cancelPath = Get-ShadowRequestCancelPath $RequestId
        if ([string]::IsNullOrWhiteSpace($cancelPath)) {
            throw "Missing request_id."
        }
        [System.IO.File]::WriteAllText($cancelPath, ([DateTimeOffset]::UtcNow.ToString("o")), [System.Text.Encoding]::UTF8)
        return (Normalize-ShadowRequestId $RequestId)
    }

    function Test-ShadowRequestCancellation {
        param([string]$RequestId)
        $cancelPath = Get-ShadowRequestCancelPath $RequestId
        return (-not [string]::IsNullOrWhiteSpace($cancelPath)) -and (Test-Path -LiteralPath $cancelPath -PathType Leaf)
    }

    function Clear-ShadowRequestCancellation {
        param([string]$RequestId)
        $cancelPath = Get-ShadowRequestCancelPath $RequestId
        if (-not [string]::IsNullOrWhiteSpace($cancelPath) -and (Test-Path -LiteralPath $cancelPath -PathType Leaf)) {
            Remove-Item -LiteralPath $cancelPath -Force -ErrorAction SilentlyContinue
        }
    }

    function Stop-ShadowProcessTree {
        param([int]$ProcessId)
        if ($ProcessId -le 0) { return }
        try {
            $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
            foreach ($child in $children) {
                Stop-ShadowProcessTree -ProcessId ([int]$child.ProcessId)
            }
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        } catch {
            try { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
    }

    function Stop-ShadowRunProcessForCancellation {
        param(
            [string]$CommandId,
            [int]$FallbackProcessId = 0
        )

        $marker = Get-ShadowRunProcessMarker $CommandId
        $processId = 0
        if ($marker -and $marker.pid) {
            try { $processId = [int]$marker.pid } catch { $processId = 0 }
        }

        if ($processId -gt 0) {
            $markerMatchesProcess = $true
            if (-not [string]::IsNullOrWhiteSpace([string]$marker.startedAtUtc)) {
                try {
                    $runningProcess = Get-Process -Id $processId -ErrorAction Stop
                    $expectedStart = ([DateTime]::Parse([string]$marker.startedAtUtc)).ToUniversalTime()
                    $actualStart = $runningProcess.StartTime.ToUniversalTime()
                    $markerMatchesProcess = ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -lt 2)
                } catch {
                    $markerMatchesProcess = $false
                }
            }

            if ($markerMatchesProcess) {
                Stop-ShadowProcessTree -ProcessId $processId
                return $true
            }
        }

        if ($FallbackProcessId -gt 0) {
            Stop-ShadowProcessTree -ProcessId $FallbackProcessId
            return $true
        }

        return $false
    }

    function Wait-ShadowProcessExit {
        param(
            [System.Diagnostics.Process]$Process,
            [int]$TimeoutMilliseconds = 5000
        )
        try {
            if ($Process -and -not $Process.HasExited) {
                [void]$Process.WaitForExit($TimeoutMilliseconds)
            }
        } catch {}
    }

    function Invoke-ShadowCommandWithTimeout {
        param(
            [string]$Command,
            [int]$TimeoutMilliseconds = 120000,
            [string]$CommandId = ""
        )
        if ([string]::IsNullOrWhiteSpace($Command)) {
            return [PSCustomObject]@{
                status = "error"
                output = "Missing command."
                exitCode = $null
                timedOut = $false
                cancelled = $false
            }
        }

        $stdoutPath = [System.IO.Path]::GetTempFileName()
        $stderrPath = [System.IO.Path]::GetTempFileName()
        $cancelPath = Get-ShadowRunCancelPath $CommandId
        $startedAt = [DateTime]::UtcNow
        $proc = $null
        try {
            # Default the command's working directory to the user's Desktop — NOT Shadow's install
            # folder — so relative-path file writes land where the user expects and never pollute
            # Shadow AI's own directory. Resolve Desktop via the OS (handles OneDrive-redirected
            # Desktops); fall back to the user profile, then to the app dir only as a last resort.
            $defaultCwd = $scriptDir
            try {
                $userDesktop = [Environment]::GetFolderPath('Desktop')
                if ($userDesktop -and (Test-Path -LiteralPath $userDesktop)) {
                    $defaultCwd = $userDesktop
                } elseif ($env:USERPROFILE -and (Test-Path -LiteralPath $env:USERPROFILE)) {
                    $defaultCwd = $env:USERPROFILE
                }
            } catch {}
            $escapedCwd = $defaultCwd.Replace("'", "''")
            $escapedRoot = $scriptDir.Replace("'", "''")
            # Suppress the CLIXML "Preparing modules for first use" progress that PowerShell
            # writes to stderr on first cmdlet use — it is benign noise that otherwise looks
            # like an error in the captured output. Also expose $env:SHADOW_DIR so self-maintenance
            # tasks can reference Shadow AI's own install folder by absolute path (the working
            # directory is now the Desktop, not the app folder).
            $script = "`$ProgressPreference = 'SilentlyContinue'; `$env:SHADOW_DIR = '$escapedRoot'; Set-Location -LiteralPath '$escapedCwd'; " + $Command
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
            $proc = Start-Process -FilePath "powershell.exe" -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-EncodedCommand", $encoded
            ) -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
            Set-ShadowRunProcessMarker -CommandId $CommandId -Process $proc

            while (-not $proc.WaitForExit(250)) {
                if ($cancelPath -and (Test-Path -LiteralPath $cancelPath -PathType Leaf)) {
                    Stop-ShadowRunProcessForCancellation -CommandId $CommandId -FallbackProcessId $proc.Id | Out-Null
                    Wait-ShadowProcessExit -Process $proc
                    return [PSCustomObject]@{
                        status = "cancelled"
                        output = "Command cancelled by user."
                        exitCode = $null
                        timedOut = $false
                        cancelled = $true
                    }
                }
                if (([DateTime]::UtcNow - $startedAt).TotalMilliseconds -ge $TimeoutMilliseconds) {
                    Stop-ShadowRunProcessForCancellation -CommandId $CommandId -FallbackProcessId $proc.Id | Out-Null
                    Wait-ShadowProcessExit -Process $proc
                    return [PSCustomObject]@{
                        status = "error"
                        output = "Command timed out after $([Math]::Round($TimeoutMilliseconds / 1000))s."
                        exitCode = $null
                        timedOut = $true
                        cancelled = $false
                    }
                }
            }

            if ($cancelPath -and (Test-Path -LiteralPath $cancelPath -PathType Leaf)) {
                return [PSCustomObject]@{
                    status = "cancelled"
                    output = "Command cancelled by user."
                    exitCode = $null
                    timedOut = $false
                    cancelled = $true
                }
            }

            $stdout = ""
            $stderr = ""
            if (Test-Path -LiteralPath $stdoutPath) { $stdout = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $stderrPath) { $stderr = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue }
            $combined = (($stdout, $stderr) -join "`n").Trim()
            if ([string]::IsNullOrWhiteSpace($combined)) {
                $combined = "Command executed successfully with no output."
            }
            return [PSCustomObject]@{
                status = $(if (($null -eq $proc.ExitCode) -or ($proc.ExitCode -eq 0)) { "success" } else { "error" })
                output = $combined
                exitCode = $proc.ExitCode
                timedOut = $false
                cancelled = $false
            }
        } catch {
            return [PSCustomObject]@{
                status = "error"
                output = $_.Exception.Message
                exitCode = $null
                timedOut = $false
                cancelled = $false
            }
        } finally {
            Clear-ShadowRunCancellation $CommandId
            if (Test-Path -LiteralPath $stdoutPath) { Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue }
        }
    }

    function Get-ShadowHttpWebResponseWithCancellation {
        param(
            [System.Net.HttpWebRequest]$WebRequest,
            [int]$TimeoutMilliseconds,
            [string]$RequestId = ""
        )

        $startedAt = [DateTime]::UtcNow
        $async = $WebRequest.BeginGetResponse($null, $null)
        try {
            while (-not $async.AsyncWaitHandle.WaitOne(250)) {
                if (Test-ShadowRequestCancellation $RequestId) {
                    try { $WebRequest.Abort() } catch {}
                    throw "Request cancelled by user."
                }
                if (([DateTime]::UtcNow - $startedAt).TotalMilliseconds -ge $TimeoutMilliseconds) {
                    try { $WebRequest.Abort() } catch {}
                    throw "Upstream request timed out after $([Math]::Round($TimeoutMilliseconds / 1000))s."
                }
            }
            return $WebRequest.EndGetResponse($async)
        } finally {
            try { $async.AsyncWaitHandle.Close() } catch {}
        }
    }

    function Read-ShadowResponseBodyWithCancellation {
        param(
            [System.Net.HttpWebRequest]$WebRequest,
            [System.Net.WebResponse]$WebResponse,
            [int]$TimeoutMilliseconds,
            [string]$RequestId = ""
        )

        $stream = $null
        $memory = New-Object System.IO.MemoryStream
        $buffer = New-Object byte[] 8192
        $startedAt = [DateTime]::UtcNow
        try {
            $stream = $WebResponse.GetResponseStream()
            while ($true) {
                if (Test-ShadowRequestCancellation $RequestId) {
                    try { $WebRequest.Abort() } catch {}
                    throw "Request cancelled by user."
                }
                if (([DateTime]::UtcNow - $startedAt).TotalMilliseconds -ge $TimeoutMilliseconds) {
                    try { $WebRequest.Abort() } catch {}
                    throw "Upstream response read timed out after $([Math]::Round($TimeoutMilliseconds / 1000))s."
                }

                $readTask = $stream.ReadAsync($buffer, 0, $buffer.Length)
                while (-not $readTask.Wait(250)) {
                    if (Test-ShadowRequestCancellation $RequestId) {
                        try { $WebRequest.Abort() } catch {}
                        throw "Request cancelled by user."
                    }
                    if (([DateTime]::UtcNow - $startedAt).TotalMilliseconds -ge $TimeoutMilliseconds) {
                        try { $WebRequest.Abort() } catch {}
                        throw "Upstream response read timed out after $([Math]::Round($TimeoutMilliseconds / 1000))s."
                    }
                }

                $bytesRead = [int]$readTask.Result
                if ($bytesRead -le 0) { break }
                $memory.Write($buffer, 0, $bytesRead)
            }
            return [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
        } finally {
            if ($stream) { $stream.Close() }
            if ($memory) { $memory.Dispose() }
        }
    }

    function Invoke-ShadowSchedulerProxyRequest {
        param(
            [string]$Method,
            [string]$Url,
            [string]$Body = "",
            [int]$TimeoutMilliseconds = 10000
        )

        $webReq = [System.Net.HttpWebRequest]::Create($Url)
        $webReq.Method = $Method
        $webReq.Accept = "application/json"
        $webReq.ContentType = "application/json"
        $webReq.Timeout = $TimeoutMilliseconds
        $webReq.ReadWriteTimeout = $TimeoutMilliseconds
        $webReq.Proxy = $null

        if ($Method -eq "POST" -or ($Method -eq "DELETE" -and -not [string]::IsNullOrEmpty($Body))) {
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
            $webReq.ContentLength = $bodyBytes.Length
            $reqStream = $null
            try {
                $reqStream = $webReq.GetRequestStream()
                $reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
            } finally {
                if ($reqStream) { $reqStream.Close() }
            }
        }

        $webResp = $null
        try {
            $webResp = $webReq.GetResponse()
            $respStream = $webResp.GetResponseStream()
            $respReader = New-Object System.IO.StreamReader($respStream, [System.Text.Encoding]::UTF8)
            $respBody = $respReader.ReadToEnd()
            $respReader.Close()
            return [PSCustomObject]@{
                statusCode = [int]$webResp.StatusCode
                contentType = $webResp.ContentType
                body = $respBody
            }
        } catch {
            if ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
                $errResp = $_.Exception.Response
                $errStream = $errResp.GetResponseStream()
                $errReader = New-Object System.IO.StreamReader($errStream, [System.Text.Encoding]::UTF8)
                $errBody = $errReader.ReadToEnd()
                $errReader.Close()
                return [PSCustomObject]@{
                    statusCode = [int]$errResp.StatusCode
                    contentType = $errResp.ContentType
                    body = $errBody
                }
            }
            throw
        } finally {
            if ($webResp) { $webResp.Close() }
        }
    }

    function Write-ShadowJsonResponse {
        param($Response, $Object, [int]$StatusCode = 200)
        $json = $Object | ConvertTo-Json -Depth 20 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        Add-ShadowCorsOrigin $Response
        $Response.StatusCode = $StatusCode
        $Response.ContentType = "application/json; charset=utf-8"
        $Response.ContentLength64 = $bytes.Length
        $Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $Response.Close()
    }

    function Send-ShadowHtmlResponse {
        param($Response, $HtmlBody, [int]$StatusCode = 200)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($HtmlBody)
        Add-ShadowCorsOrigin $Response
        $Response.StatusCode = $StatusCode
        $Response.ContentType = "text/html; charset=utf-8"
        $Response.ContentLength64 = $bytes.Length
        $Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $Response.Close()
    }

    function Get-ShadowAllowedCorsOrigin {
        param($Request)
        if ($null -eq $Request) { return $null }
        $origin = [string]$Request.Headers["Origin"]
        if ([string]::IsNullOrWhiteSpace($origin)) { return $null }

        try {
            $uri = [System.Uri]$origin
            $hostOk = $uri.Host -eq "127.0.0.1" -or $uri.Host -eq "localhost" -or $uri.Host -eq "::1"
            $schemeOk = $uri.Scheme -eq "http"
            $portOk = $uri.Port -eq [int]$port
            if ($hostOk -and $schemeOk -and $portOk) { return $origin }
        } catch { }
        return $null
    }

    function Test-ShadowAllowedOrigin {
        param($Request)
        if ($null -eq $Request) { return $true }
        $origin = [string]$Request.Headers["Origin"]
        if ([string]::IsNullOrWhiteSpace($origin)) { return $true }
        return -not [string]::IsNullOrWhiteSpace((Get-ShadowAllowedCorsOrigin $Request))
    }

    function Add-ShadowCorsOrigin {
        param($Response)
        $origin = Get-ShadowAllowedCorsOrigin $script:ShadowCurrentRequest
        if ([string]::IsNullOrWhiteSpace($origin)) { return }
        $Response.Headers.Add("Access-Control-Allow-Origin", $origin)
        $Response.Headers.Add("Vary", "Origin")
    }

    function Reject-ShadowForbiddenOrigin {
        param($Response)
        $body = '{"status":"error","error":"Forbidden origin."}'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $Response.StatusCode = 403
        $Response.ContentType = "application/json; charset=utf-8"
        $Response.ContentLength64 = $bytes.Length
        $Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $Response.Close()
    }

    function Get-ShadowGoogleRedirectUri {
        return "http://127.0.0.1:$port/oauth2callback"
    }

    function Get-ShadowPrivateDir {
        $privateDir = Join-Path $scriptDir "secrets"
        if (-not (Test-Path $privateDir -PathType Container)) {
            New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
        }
        return $privateDir
    }

    function Get-ShadowPrivatePath {
        param([string]$FileName)
        $privatePath = Join-Path (Get-ShadowPrivateDir) $FileName
        $legacyPath = Join-Path $scriptDir $FileName

        if ((-not (Test-Path $privatePath -PathType Leaf)) -and (Test-Path $legacyPath -PathType Leaf)) {
            Move-Item -LiteralPath $legacyPath -Destination $privatePath -Force
        }

        return $privatePath
    }

    function Get-ShadowGoogleCredentials {
        $privateDir = Get-ShadowPrivateDir
        Get-ChildItem -Path $scriptDir -Filter "client_secret_*.json" -File -ErrorAction SilentlyContinue | ForEach-Object {
            $targetPath = Join-Path $privateDir $_.Name
            if (-not (Test-Path $targetPath -PathType Leaf)) {
                Move-Item -LiteralPath $_.FullName -Destination $targetPath -Force
            }
        }

        $candidatePaths = @(
            (Get-ShadowPrivatePath "google_credentials.json"),
            (Get-ShadowPrivatePath "credentials.json"),
            (Get-ShadowPrivatePath "client_secret.json")
        )
        $candidatePaths += @(Get-ChildItem -Path $privateDir -Filter "client_secret_*.json" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })

        foreach ($candidatePath in $candidatePaths) {
            if (-not (Test-Path $candidatePath -PathType Leaf)) { continue }

            try {
                $rawCreds = Get-Content $candidatePath -Raw | ConvertFrom-Json
                $clientType = "flat"
                $clientId = [string]$rawCreds.client_id
                $clientSecret = [string]$rawCreds.client_secret

                if ($rawCreds.web) {
                    $clientType = "web"
                    $clientId = [string]$rawCreds.web.client_id
                    $clientSecret = [string]$rawCreds.web.client_secret
                } elseif ($rawCreds.installed) {
                    $clientType = "installed"
                    $clientId = [string]$rawCreds.installed.client_id
                    $clientSecret = [string]$rawCreds.installed.client_secret
                }

                if ([string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret)) {
                    return [PSCustomObject]@{
                        configured = $false
                        error = "Google credentials file '$([System.IO.Path]::GetFileName($candidatePath))' is missing client_id or client_secret."
                        source = $candidatePath
                        client_id = ""
                        client_secret = ""
                        client_type = $clientType
                    }
                }

                if ($clientId -match "placeholder" -or $clientSecret -match "placeholder" -or $clientId -notmatch "\.apps\.googleusercontent\.com$") {
                    return [PSCustomObject]@{
                        configured = $false
                        error = "Google credentials file '$([System.IO.Path]::GetFileName($candidatePath))' does not contain a valid OAuth client id."
                        source = $candidatePath
                        client_id = ""
                        client_secret = ""
                        client_type = $clientType
                    }
                }

                return [PSCustomObject]@{
                    configured = $true
                    error = ""
                    source = $candidatePath
                    client_id = $clientId
                    client_secret = $clientSecret
                    client_type = $clientType
                }
            } catch {
                return [PSCustomObject]@{
                    configured = $false
                    error = "Could not read Google credentials file '$([System.IO.Path]::GetFileName($candidatePath))': $($_.Exception.Message)"
                    source = $candidatePath
                    client_id = ""
                    client_secret = ""
                    client_type = ""
                }
            }
        }

        return [PSCustomObject]@{
            configured = $false
            error = "Google OAuth credentials are missing. Import credentials in Shadow AI, or place credentials.json, client_secret.json, or google_credentials.json in the ignored secrets folder."
            source = ""
            client_id = ""
            client_secret = ""
            client_type = ""
        }
    }

    function Get-ShadowGoogleAccessToken {
        $tokensPath = Get-ShadowPrivatePath "google_tokens.json"
        if (-not (Test-Path $tokensPath -PathType Leaf)) {
            throw "Google integration is not connected."
        }

        $tokens = Get-Content $tokensPath -Raw | ConvertFrom-Json
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

        if (($tokens.expires_at - $now) -lt 300) {
            if ([string]::IsNullOrEmpty($tokens.refresh_token)) {
                throw "Access token expired and no refresh token is available. Please reconnect."
            }

            $googleCreds = Get-ShadowGoogleCredentials
            if (-not $googleCreds.configured) {
                throw "Credentials config is missing or invalid, cannot refresh token. $($googleCreds.error)"
            }

            $formBody = "client_id=" + [Uri]::EscapeDataString($googleCreds.client_id) +
                        "&client_secret=" + [Uri]::EscapeDataString($googleCreds.client_secret) +
                        "&refresh_token=" + [Uri]::EscapeDataString($tokens.refresh_token) +
                        "&grant_type=refresh_token"
            $formBytes = [System.Text.Encoding]::UTF8.GetBytes($formBody)

            $tokenReq = [System.Net.HttpWebRequest]::Create("https://oauth2.googleapis.com/token")
            $tokenReq.Method = "POST"
            $tokenReq.ContentType = "application/x-www-form-urlencoded"
            $tokenReq.Timeout = 15000
            $tokenReq.ReadWriteTimeout = 15000
            $tokenReq.ContentLength = $formBytes.Length

            $reqStream = $tokenReq.GetRequestStream()
            $reqStream.Write($formBytes, 0, $formBytes.Length)
            $reqStream.Close()

            $tokenResp = $tokenReq.GetResponse()
            $respStream = $tokenResp.GetResponseStream()
            $respReader = New-Object System.IO.StreamReader($respStream)
            $respBody = $respReader.ReadToEnd()
            $respReader.Close()
            $tokenResp.Close()

            $refreshed = $respBody | ConvertFrom-Json
            $expiresIn = 3600
            if ($refreshed.expires_in) { $expiresIn = [int]$refreshed.expires_in }
            $tokens.access_token = $refreshed.access_token
            $tokens.expires_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $expiresIn
            if (-not [string]::IsNullOrEmpty($refreshed.refresh_token)) {
                $tokens.refresh_token = $refreshed.refresh_token
            }
            [System.IO.File]::WriteAllText($tokensPath, ($tokens | ConvertTo-Json -Compress))
        }

        if ([string]::IsNullOrEmpty($tokens.access_token)) {
            throw "Google access token is missing. Please reconnect."
        }
        return [string]$tokens.access_token
    }

    function Get-ShadowCodexAuthPath {
        if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
            return (Join-Path $env:CODEX_HOME "auth.json")
        }
        return (Join-Path $env:USERPROFILE ".codex\auth.json")
    }

    function Get-ShadowCodexClientId {
        return "app_EMoamEEZ73f0CkXaXp7hrann"
    }

    function Ensure-ShadowCodexLoginScript {
        $scriptPath = Get-ShadowPrivatePath "codex_oauth_login.ps1"
        $scriptContent = @'
param(
    [Parameter(Mandatory = $true)]
    [string]$AuthPath
)

$ErrorActionPreference = "Stop"
$clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
$issuer = "https://auth.openai.com"
$preferredPorts = @(1455, 1457)

function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function ConvertFrom-Base64UrlJson {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $padded = $Value.Replace("-", "+").Replace("_", "/")
    switch ($padded.Length % 4) {
        2 { $padded += "==" }
        3 { $padded += "=" }
    }
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($padded))
    return $json | ConvertFrom-Json
}

function New-RandomBase64Url {
    param([int]$ByteCount = 32)
    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return ConvertTo-Base64Url $bytes
    } finally {
        $rng.Dispose()
    }
}

function New-CodeChallenge {
    param([string]$Verifier)
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($Verifier)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes)
        return ConvertTo-Base64Url $hash
    } finally {
        $sha.Dispose()
    }
}

function Send-HtmlResponse {
    param($Context, [string]$Html, [int]$StatusCode = 200)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Html)
    $Context.Response.StatusCode = $StatusCode
    $Context.Response.ContentType = "text/html; charset=utf-8"
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.Close()
}

function Send-TextResponse {
    param($Context, [string]$Text, [int]$StatusCode = 200)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $Context.Response.StatusCode = $StatusCode
    $Context.Response.ContentType = "text/plain; charset=utf-8"
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.Close()
}

function Exchange-CodeForTokens {
    param([string]$Code, [string]$RedirectUri, [string]$Verifier)
    $tokenBody = "grant_type=authorization_code" +
        "&code=" + [Uri]::EscapeDataString($Code) +
        "&redirect_uri=" + [Uri]::EscapeDataString($RedirectUri) +
        "&client_id=" + [Uri]::EscapeDataString($clientId) +
        "&code_verifier=" + [Uri]::EscapeDataString($Verifier)
    $formBytes = [System.Text.Encoding]::UTF8.GetBytes($tokenBody)

    $tokenReq = [System.Net.HttpWebRequest]::Create("$issuer/oauth/token")
    $tokenReq.Method = "POST"
    $tokenReq.ContentType = "application/x-www-form-urlencoded"
    $tokenReq.Timeout = 30000
    $tokenReq.ReadWriteTimeout = 30000
    $tokenReq.ContentLength = $formBytes.Length

    $reqStream = $tokenReq.GetRequestStream()
    $reqStream.Write($formBytes, 0, $formBytes.Length)
    $reqStream.Close()

    try {
        $tokenResp = $tokenReq.GetResponse()
        $respStream = $tokenResp.GetResponseStream()
        $respReader = New-Object System.IO.StreamReader($respStream)
        $respBody = $respReader.ReadToEnd()
        $respReader.Close()
        $tokenResp.Close()
        return $respBody | ConvertFrom-Json
    } catch {
        $detail = $_.Exception.Message
        if ($_.Exception.Response) {
            try {
                $errStream = $_.Exception.Response.GetResponseStream()
                $errReader = New-Object System.IO.StreamReader($errStream)
                $errBody = $errReader.ReadToEnd()
                $errReader.Close()
                if (-not [string]::IsNullOrWhiteSpace($errBody)) { $detail = $errBody }
            } catch {}
        }
        throw "Token exchange failed: $detail"
    }
}

function Save-CodexTokens {
    param($Tokens)
    if ([string]::IsNullOrWhiteSpace([string]$Tokens.access_token)) { throw "Token response did not include an access token." }
    if ([string]::IsNullOrWhiteSpace([string]$Tokens.id_token)) { throw "Token response did not include an id token." }

    $authDir = Split-Path -Parent $AuthPath
    if (-not (Test-Path $authDir -PathType Container)) {
        New-Item -ItemType Directory -Path $authDir -Force | Out-Null
    }

    $existingRefreshToken = ""
    if (Test-Path $AuthPath -PathType Leaf) {
        try {
            $existing = Get-Content $AuthPath -Raw | ConvertFrom-Json
            if ($existing.tokens -and $existing.tokens.refresh_token) {
                $existingRefreshToken = [string]$existing.tokens.refresh_token
            }
        } catch {}
    }

    $refreshToken = [string]$Tokens.refresh_token
    if ([string]::IsNullOrWhiteSpace($refreshToken)) { $refreshToken = $existingRefreshToken }

    $accountId = ""
    try {
        $claims = ConvertFrom-Base64UrlJson (($Tokens.id_token -split "\.")[1])
        if ($claims.chatgpt_account_id) { $accountId = [string]$claims.chatgpt_account_id }
        elseif ($claims.account_id) { $accountId = [string]$claims.account_id }
    } catch {}

    $expiresIn = 3600
    if ($Tokens.expires_in) { $expiresIn = [int]$Tokens.expires_in }
    $expiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $expiresIn

    $auth = [ordered]@{
        auth_mode = "chatgpt"
        OPENAI_API_KEY = $null
        tokens = [ordered]@{
            id_token = [string]$Tokens.id_token
            access_token = [string]$Tokens.access_token
            refresh_token = $refreshToken
            account_id = $accountId
            expires_at = $expiresAt
            scope = [string]$Tokens.scope
        }
        last_refresh = [DateTimeOffset]::UtcNow.ToString("o")
    }
    [System.IO.File]::WriteAllText($AuthPath, ($auth | ConvertTo-Json -Depth 20), [System.Text.Encoding]::UTF8)
}

$listener = $null
$actualPort = 0
foreach ($candidatePort in $preferredPorts) {
    try {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$candidatePort/")
        $listener.Start()
        $actualPort = $candidatePort
        break
    } catch {
        if ($listener) {
            try { $listener.Close() } catch {}
            $listener = $null
        }
    }
}
if (-not $listener) { throw "Could not start Codex OAuth callback listener on localhost:1455 or localhost:1457." }

$state = New-RandomBase64Url 32
$verifier = New-RandomBase64Url 64
$challenge = New-CodeChallenge $verifier
$redirectUri = "http://localhost:$actualPort/auth/callback"
$scope = "openid profile email offline_access api.connectors.read api.connectors.invoke"
$query = @(
    "response_type=code",
    "client_id=$([Uri]::EscapeDataString($clientId))",
    "redirect_uri=$([Uri]::EscapeDataString($redirectUri))",
    "scope=$([Uri]::EscapeDataString($scope))",
    "code_challenge=$([Uri]::EscapeDataString($challenge))",
    "code_challenge_method=S256",
    "id_token_add_organizations=true",
    "codex_cli_simplified_flow=true",
    "state=$([Uri]::EscapeDataString($state))",
    "originator=codex_cli"
) -join "&"
$authUrl = "$issuer/oauth/authorize?$query"

try {
    Start-Process $authUrl | Out-Null
    $deadline = (Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline) {
        $async = $listener.BeginGetContext($null, $null)
        while (-not $async.AsyncWaitHandle.WaitOne(500)) {
            if ((Get-Date) -ge $deadline) { throw "Codex OAuth login timed out." }
        }

        $context = $listener.EndGetContext($async)
        $path = $context.Request.Url.AbsolutePath
        if ($path -eq "/cancel") {
            Send-TextResponse $context "Login cancelled."
            break
        }
        if ($path -ne "/auth/callback") {
            Send-TextResponse $context "Not Found" 404
            continue
        }

        $callbackError = [string]$context.Request.QueryString["error"]
        if (-not [string]::IsNullOrWhiteSpace($callbackError)) {
            $callbackDescription = [string]$context.Request.QueryString["error_description"]
            if ([string]::IsNullOrWhiteSpace($callbackDescription)) { $callbackDescription = $callbackError }
            throw "Codex authorization failed: $callbackDescription"
        }

        $returnedState = [string]$context.Request.QueryString["state"]
        if ($returnedState -ne $state) { throw "Codex authorization state mismatch." }

        $code = [string]$context.Request.QueryString["code"]
        if ([string]::IsNullOrWhiteSpace($code)) { throw "Codex authorization code was missing." }

        $tokens = Exchange-CodeForTokens -Code $code -RedirectUri $redirectUri -Verifier $verifier
        Save-CodexTokens -Tokens $tokens
        Send-HtmlResponse $context "<!doctype html><html><head><title>Codex login complete</title></head><body style='font-family:system-ui;background:#111;color:#eee;padding:32px;'><h1>Codex login complete</h1><p>You can close this tab and return to Shadow.</p></body></html>"
        break
    }
} catch {
    try {
        if ($context -and $context.Response -and $context.Response.OutputStream.CanWrite) {
            $safe = [System.Net.WebUtility]::HtmlEncode($_.Exception.Message)
            Send-HtmlResponse $context "<!doctype html><html><head><title>Codex login failed</title></head><body style='font-family:system-ui;background:#111;color:#eee;padding:32px;'><h1>Codex login failed</h1><p>$safe</p></body></html>" 500
        }
    } catch {}
    $logPath = Join-Path (Split-Path -Parent $AuthPath) "codex_oauth_login_error.txt"
    [System.IO.File]::WriteAllText($logPath, $_.Exception.Message, [System.Text.Encoding]::UTF8)
} finally {
    if ($listener) {
        try { $listener.Stop() } catch {}
        try { $listener.Close() } catch {}
    }
}
'@
        [System.IO.File]::WriteAllText($scriptPath, $scriptContent, [System.Text.Encoding]::UTF8)
        return $scriptPath
    }

    function Get-ShadowCodexAuthStatus {
        $authPath = Get-ShadowCodexAuthPath
        $result = [ordered]@{
            connected = $false
            status = "success"
            authMode = ""
            credentialSource = "none"
            hasAuthFile = $false
            accountId = ""
            detail = "Codex is not logged in. Click Login with Codex to start OAuth."
        }

        if (-not (Test-Path $authPath -PathType Leaf)) {
            return [PSCustomObject]$result
        }

        $result.hasAuthFile = $true
        $result.credentialSource = "auth.json"
        try {
            $auth = Get-Content $authPath -Raw | ConvertFrom-Json
            if ($auth.auth_mode) { $result.authMode = [string]$auth.auth_mode }

            $apiKey = ""
            if ($auth.PSObject.Properties.Name -contains "OPENAI_API_KEY") {
                $apiKey = [string]$auth.OPENAI_API_KEY
            }

            $accessToken = ""
            $refreshToken = ""
            if ($auth.tokens) {
                if ($auth.tokens.access_token) { $accessToken = [string]$auth.tokens.access_token }
                if ($auth.tokens.refresh_token) { $refreshToken = [string]$auth.tokens.refresh_token }
                if ($auth.tokens.account_id) { $result.accountId = [string]$auth.tokens.account_id }
            }

            if (-not [string]::IsNullOrWhiteSpace($apiKey) -or -not [string]::IsNullOrWhiteSpace($accessToken)) {
                $result.connected = $true
                $result.detail = "Codex credentials found in $authPath."
                if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
                    $result.authMode = "api"
                } elseif ([string]::IsNullOrWhiteSpace($result.authMode)) {
                    $result.authMode = "chatgpt"
                }
            } elseif (-not [string]::IsNullOrWhiteSpace($refreshToken)) {
                $result.connected = $true
                $result.detail = "Codex OAuth refresh token found. Start Codex once if an access token refresh is needed."
                if ([string]::IsNullOrWhiteSpace($result.authMode)) { $result.authMode = "chatgpt" }
            } else {
                $result.detail = "Codex auth cache exists, but no usable token was found."
            }
        } catch {
            $result.status = "error"
            $result.detail = "Could not read Codex auth cache: $($_.Exception.Message)"
        }

        return [PSCustomObject]$result
    }

    function Get-ShadowCodexBearerToken {
        $authPath = Get-ShadowCodexAuthPath
        if (-not (Test-Path $authPath -PathType Leaf)) {
            throw "Codex is not logged in. Use the OpenAI Codex login button first."
        }

        $auth = Get-Content $authPath -Raw | ConvertFrom-Json
        if (($auth.PSObject.Properties.Name -contains "OPENAI_API_KEY") -and -not [string]::IsNullOrWhiteSpace([string]$auth.OPENAI_API_KEY)) {
            return [string]$auth.OPENAI_API_KEY
        }
        if ($auth.tokens -and $auth.tokens.expires_at -and $auth.tokens.refresh_token) {
            $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            if (([double]$auth.tokens.expires_at - $now) -lt 300) {
                $refreshBody = "grant_type=refresh_token" +
                               "&refresh_token=" + [Uri]::EscapeDataString([string]$auth.tokens.refresh_token) +
                               "&client_id=" + [Uri]::EscapeDataString((Get-ShadowCodexClientId))
                $refreshBytes = [System.Text.Encoding]::UTF8.GetBytes($refreshBody)
                $refreshReq = [System.Net.HttpWebRequest]::Create("https://auth.openai.com/oauth/token")
                $refreshReq.Method = "POST"
                $refreshReq.ContentType = "application/x-www-form-urlencoded"
                $refreshReq.Timeout = 30000
                $refreshReq.ReadWriteTimeout = 30000
                $refreshReq.ContentLength = $refreshBytes.Length
                $refreshStream = $refreshReq.GetRequestStream()
                $refreshStream.Write($refreshBytes, 0, $refreshBytes.Length)
                $refreshStream.Close()

                try {
                    $refreshResp = $refreshReq.GetResponse()
                    $respStream = $refreshResp.GetResponseStream()
                    $respReader = New-Object System.IO.StreamReader($respStream)
                    $respBody = $respReader.ReadToEnd()
                    $respReader.Close()
                    $refreshResp.Close()
                    $refreshed = $respBody | ConvertFrom-Json

                    if ($refreshed.access_token) { $auth.tokens.access_token = [string]$refreshed.access_token }
                    if ($refreshed.id_token) { $auth.tokens.id_token = [string]$refreshed.id_token }
                    if ($refreshed.refresh_token) { $auth.tokens.refresh_token = [string]$refreshed.refresh_token }
                    $expiresIn = 3600
                    if ($refreshed.expires_in) { $expiresIn = [int]$refreshed.expires_in }
                    $auth.tokens.expires_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $expiresIn
                    $auth.last_refresh = [DateTimeOffset]::UtcNow.ToString("o")
                    [System.IO.File]::WriteAllText($authPath, ($auth | ConvertTo-Json -Depth 20), [System.Text.Encoding]::UTF8)
                } catch {
                    throw "Codex OAuth token refresh failed. Please log in again. $($_.Exception.Message)"
                }
            }
        }
        if ($auth.tokens -and -not [string]::IsNullOrWhiteSpace([string]$auth.tokens.access_token)) {
            return [string]$auth.tokens.access_token
        }
        throw "Codex auth cache does not contain an API key or access token. Run Codex login again."
    }

    function Invoke-ShadowCodexCommand {
        param([string]$Arguments, [int]$TimeoutMilliseconds = 15000)
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = "/c codex $Arguments"
        $psi.WorkingDirectory = $scriptDir
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        [void]$proc.Start()
        $finished = $proc.WaitForExit($TimeoutMilliseconds)
        if (-not $finished) {
            try { $proc.Kill() } catch {}
            throw "codex $Arguments timed out."
        }
        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        return [PSCustomObject]@{
            exitCode = $proc.ExitCode
            output = ($stdout + $stderr).Trim()
        }
    }

    function Get-ShadowMimeType {
        param([string]$Path, [string]$RequestedMimeType)
        if (-not [string]::IsNullOrWhiteSpace($RequestedMimeType)) { return $RequestedMimeType }
        $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
        switch ($ext) {
            ".mp4" { return "video/mp4" }
            ".mov" { return "video/quicktime" }
            ".mkv" { return "video/x-matroska" }
            ".webm" { return "video/webm" }
            ".avi" { return "video/x-msvideo" }
            ".txt" { return "text/plain" }
            ".json" { return "application/json" }
            ".pdf" { return "application/pdf" }
            ".jpg" { return "image/jpeg" }
            ".jpeg" { return "image/jpeg" }
            ".png" { return "image/png" }
            default { return "application/octet-stream" }
        }
    }

    function ConvertTo-ShadowReusableToken {
        param([string]$Token)
        $lower = ([string]$Token).ToLowerInvariant()
        # Strip a trailing version/index number off a real word so "calculator2"/"calculator3" all match
        # "calculator". Filenames like calculator2.html otherwise fork the deliverable into a brand-new
        # token, so a second calculator never recognizes the first and saves a DUPLICATE skill. Guarded to
        # a >=5-char alphabetic stem so model/format tokens that legitimately end in digits keep them
        # (mp3, mp4, h264, gpt5, qwen3, etc.).
        if ($lower -match '^([a-z]{5,})[0-9]+$') { $lower = $Matches[1] }
        switch -Regex ($lower) {
            '^(compress|compressed|compressing|compression|compressor)$' { return "compress" }
            '^(download|downloads|downloaded|downloading|downloader)$' { return "download" }
            '^(upload|uploads|uploaded|uploading|uploader)$' { return "upload" }
            '^(create|creates|created|creating|creator|build|builds|built|make|makes|made|making)$' { return "create" }
            # NOTE: 'html' is deliberately NOT collapsed here. HTML is a FORMAT, not a deliverable.
            # Collapsing it into "website" made an HTML calculator look like an HTML landing page and
            # merge into it. site/portfolio/webpage ARE the "website" deliverable, so they still collapse.
            '^(website|websites|webpage|webpages|site|sites|portfolio|portfolios)$' { return "website" }
            '^(video|videos|media|mp4|mov|mkv|webm)$' { return "video" }
            '^(file|files|folder|folders|directory|directories|path|paths)$' { return "file" }
            default { return $lower }
        }
    }

    # Generic "scaffolding" tokens (already normalized forms): they appear across many UNRELATED
    # automations like "create a file", "open it", "run powershell", html/css/page formatting. Two
    # skills that share ONLY these are not the same skill. A real duplicate also shares a SALIENT token:
    # the actual subject/deliverable (calculator, website, youtube, vps, gmail, video, memories...).
    # Salient tokens like 'website'/'video'/'download'/'upload'/'compress' are intentionally NOT here.
    $script:ShadowGenericReusableTokens = @(
        'create','file','html','css','page','web','app','application','open','desktop','document',
        'confirm','verify','verification','check','ensure','render','display','show','run','execute',
        'save','generate','write','code','script','browser','window','content','command','powershell',
        'output','start','process','resolve','childitem','line','item','value','add','set','get','use',
        'put','place','style','styling','inline','simple','working','functional','complete','proper','view'
    )

    # Count how many SALIENT (non-scaffolding) tokens two token sets share. Used to gate skill merges:
    # a merge requires >= 1 shared salient token so distinct deliverables (calculator vs landing page)
    # never merge just because both "create an html file on the desktop and open it".
    function Get-ShadowSalientSharedCount {
        param([string[]]$TokensA, [string[]]$TokensB)
        $generic = $script:ShadowGenericReusableTokens
        $a = @($TokensA | Sort-Object -Unique)
        $b = @($TokensB | Sort-Object -Unique)
        $shared = @($a | Where-Object { ($b -contains $_) -and ($generic -notcontains $_) })
        return $shared.Count
    }

    function Get-ShadowReusableTokens {
        param([string[]]$Texts)
        $stopWords = @(
            'a','an','the','and','or','but','in','on','at','to','for','of','with','by','from','is','it','my',
            'this','that','these','those','user','users','dylan','workflow','skill','skills',
            'task','tasks','named','located','single','basic','stuff','thing','things','new','old','existing','local'
        )
        $tokens = @()
        foreach ($text in $Texts) {
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            foreach ($match in [regex]::Matches([string]$text, '[A-Za-z0-9]+')) {
                $token = ConvertTo-ShadowReusableToken $match.Value
                if ($token.Length -gt 2 -and $stopWords -notcontains $token) {
                    $tokens += $token
                }
            }
        }
        return @($tokens | Sort-Object -Unique)
    }

    function Get-ShadowReusableSimilarity {
        param([string[]]$TokensA, [string[]]$TokensB)
        $a = @($TokensA | Sort-Object -Unique)
        $b = @($TokensB | Sort-Object -Unique)
        if ($a.Count -eq 0 -or $b.Count -eq 0) {
            return [PSCustomObject]@{ score = 0.0; matches = 0 }
        }
        $matches = 0
        foreach ($token in $a) {
            if ($b -contains $token) { $matches++ }
        }
        if ($matches -eq 0) {
            return [PSCustomObject]@{ score = 0.0; matches = 0 }
        }
        $minCount = [Math]::Max([Math]::Min($a.Count, $b.Count), 1)
        $unionCount = [Math]::Max(($a + $b | Sort-Object -Unique).Count, 1)
        $containment = $matches / $minCount
        $jaccard = $matches / $unionCount
        return [PSCustomObject]@{ score = [Math]::Max($containment, $jaccard); matches = $matches }
    }

    function Find-ShadowReusableArtifact {
        param(
            [string]$RootDir,
            [string]$Kind,
            [string]$RequestName,
            [string]$RequestText,
            [string]$ExcludeName
        )
        if (-not (Test-Path $RootDir -PathType Container)) { return $null }

        $requestNameTokens = @(Get-ShadowReusableTokens @($RequestName))
        $requestAllTokens = @(Get-ShadowReusableTokens @($RequestName, $RequestText))
        $best = $null
        $bestScore = 0.0
        # Track the closest candidate REGARDLESS of threshold, so a near-miss can be logged (why a merge
        # didn't fire) instead of silently saving a duplicate.
        $closestName = ''
        $closestNameSim = 0.0
        $closestContentSim = 0.0
        $closestCombined = 0.0

        Get-ChildItem -Path $RootDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if ($ExcludeName -and $_.Name -eq $ExcludeName) { return }

            $candidateText = ""
            $instructionsPath = Join-Path $_.FullName "instructions.txt"
            if (Test-Path $instructionsPath -PathType Leaf) {
                try { $candidateText = Get-Content $instructionsPath -Raw -ErrorAction SilentlyContinue } catch {}
            }

            $candidateNameTokens = @(Get-ShadowReusableTokens @($_.Name))
            $candidateAllTokens = @(Get-ShadowReusableTokens @($_.Name, $candidateText))
            $nameSimilarity = Get-ShadowReusableSimilarity $requestNameTokens $candidateNameTokens
            $contentSimilarity = Get-ShadowReusableSimilarity $requestAllTokens $candidateAllTokens

            $combined = [Math]::Max($nameSimilarity.score, $contentSimilarity.score)
            if ($combined -gt $closestCombined) {
                $closestCombined = $combined
                $closestName = $_.Name
                $closestNameSim = $nameSimilarity.score
                $closestContentSim = $contentSimilarity.score
            }

            # Hard gate, evaluated PER PATH: never merge unless the two skills share at least one SALIENT
            # (non-scaffolding) token in the dimension that triggers the merge. This stops
            # "create_single_html_calculator" from merging into "create_basic_html_css_landing_page":
            # their NAMES share only generic scaffolding (create, html), so the name path is blocked even
            # though their instructions coincidentally share a scaffolding word like "renders". The real
            # subjects (calculator vs landing) never overlap. A name-path merge needs a salient NAME token;
            # a content-path merge needs a salient CONTENT token.
            $nameSalientShared = Get-ShadowSalientSharedCount $requestNameTokens $candidateNameTokens
            $contentSalientShared = Get-ShadowSalientSharedCount $requestAllTokens $candidateAllTokens
            $score = 0.0
            # Name-path merge: share a SALIENT name token (the deliverable: calculator, portfolio, vps...)
            # AND share >= 2 name tokens total (or be near-identical). The 0.6 score floor was REMOVED: the
            # salient gate already prevents wrong merges (calculator never shares a salient token with
            # landing/static-site), so the floor only caused FALSE NEGATIVES — two genuine calculator skills
            # whose auto-names diverged (e.g. "create_folder_named_calculator" vs
            # "create_basic_calculator_standalone_html") scored ~0.5 and wrongly stayed separate as
            # duplicates. Requiring 2 shared name tokens still stops a lone shared subject from merging two
            # DIFFERENT operations on it (connect_to_vps vs take_vps_domain_offline share only "vps").
            if ($nameSalientShared -ge 1 -and ($nameSimilarity.matches -ge 2 -or $nameSimilarity.score -ge 0.85)) {
                $score = $nameSimilarity.score
            } elseif ($nameSalientShared -ge 1 -and $contentSalientShared -ge 1 -and $contentSimilarity.score -ge 0.55 -and $contentSimilarity.matches -ge 5) {
                # CONTENT-path merge now ALSO requires a shared salient NAME token. Without this, a bloated
                # skill (e.g. a calculator skill that absorbed calc1/2/3) shares so much scaffolding +
                # structural words (self-contained, single, inline css, desktop, html...) with ANY html-file
                # task that an unrelated "portfolio website" matched it on content alone. Requiring the names
                # to share the actual subject (calculator vs portfolio differ) blocks that, while two genuine
                # same-deliverable skills still share the subject word in their (deliverable-led) names.
                # Content path catches near-duplicates whose auto-generated NAMES diverged (e.g. several
                # "create a portfolio website on the desktop" skills). Set at 0.6 because a merge only
                # APPENDS the new steps to the existing skill (never overwrites) — so a borderline merge
                # just puts two related workflows in one file, not lost content. The matches>=5 floor
                # keeps incidental overlap (e.g. distinct VPS skills sharing infra vocabulary) from
                # triggering a false merge. The save-skill log prints the closest score so this can be
                # tuned from real data.
                $score = $contentSimilarity.score
            }

            if ($score -gt $bestScore) {
                $bestScore = $score
                $best = [PSCustomObject]@{
                    Name = $_.Name
                    Path = $_.FullName
                    Kind = $Kind
                    Score = $score
                }
            }
        }

        return [PSCustomObject]@{
            Match = $best
            ClosestName = $closestName
            ClosestNameSim = [Math]::Round([double]$closestNameSim, 2)
            ClosestContentSim = [Math]::Round([double]$closestContentSim, 2)
        }
    }

    while ($listener.IsListening) {
        try {
            $context = $listener.GetContext()
            $request = $context.Request
            $response = $context.Response
            
            $urlPath = $request.Url.LocalPath
            $script:ShadowCurrentRequest = $request
            if ($urlPath -like "/api/*" -and -not (Test-ShadowAllowedOrigin $request)) {
                Reject-ShadowForbiddenOrigin $response
                continue
            }
            if ($urlPath -eq "/") { $urlPath = "/index.html" }

            if ($urlPath -eq "/api/health") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "GET") {
                    Write-ShadowJsonResponse $response ([PSCustomObject]@{
                        status = "healthy"
                        service = "shadow-main"
                        port = $port
                        startedAt = $serverStartedAt
                        scriptDir = $scriptDir
                    })
                    continue
                }
            }

            if ($urlPath -eq "/api/open-url") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200; $response.Close(); continue
                }
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $payload = $reader.ReadToEnd() | ConvertFrom-Json
                        $openUrl = [string]$payload.url
                        # Only http(s) so this can never be used to launch arbitrary programs.
                        if ($openUrl -notmatch '^(?i)https?://') { throw "Only http(s) URLs can be opened." }
                        Start-Process $openUrl   # ShellExecute -> the user's DEFAULT browser
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success" }) 200
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 200
                    }
                    continue
                }
                Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = "Method not allowed" }) 405
                continue
            }

            # Push-to-talk: arm/disarm the global key poll. The UI POSTs the enabled flag and the
            # bound Windows virtual-key code; the poll runspace then watches that key globally.
            if ($urlPath -eq "/api/ptt/config") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200; $response.Close(); continue
                }
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $payload = $reader.ReadToEnd() | ConvertFrom-Json
                        $pttState.enabled = [bool]$payload.enabled
                        $vkVal = 0; [void][int]::TryParse([string]$payload.vk, [ref]$vkVal)
                        $pttState.vk = $vkVal
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success"; supported = [bool]$pttState.supported }) 200
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 200
                    }
                    continue
                }
                Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = "Method not allowed" }) 405
                continue
            }

            # Push-to-talk: snapshot of current key state (used once on connect to seed the long-poll).
            if ($urlPath -eq "/api/ptt/state") {
                Write-ShadowJsonResponse $response ([PSCustomObject]@{
                    status = "success"; supported = [bool]$pttState.supported; enabled = [bool]$pttState.enabled
                    vk = [int]$pttState.vk; held = [bool]$pttState.held; seq = [int]$pttState.seq
                }) 200
                continue
            }

            # Push-to-talk: long-poll that returns the instant the bound key's pressed/released state
            # changes past the caller's 'since' sequence (or after a ~25s heartbeat). Near-zero latency
            # without the UI hammering the server with rapid polls.
            if ($urlPath -eq "/api/ptt/wait") {
                $sinceVal = -1
                try { if ($request.QueryString["since"]) { [void][int]::TryParse([string]$request.QueryString["since"], [ref]$sinceVal) } } catch {}
                $deadline = (Get-Date).AddSeconds(25)
                while (([int]$pttState.seq -le $sinceVal) -and ((Get-Date) -lt $deadline) -and $listener.IsListening) {
                    Start-Sleep -Milliseconds 10
                }
                Write-ShadowJsonResponse $response ([PSCustomObject]@{
                    status = "success"; held = [bool]$pttState.held; seq = [int]$pttState.seq; supported = [bool]$pttState.supported
                }) 200
                continue
            }

            if ($urlPath -eq "/api/request/cancel") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $body = $reader.ReadToEnd()
                        $reader.Close()
                        $json = if ([string]::IsNullOrWhiteSpace($body)) { [PSCustomObject]@{} } else { $body | ConvertFrom-Json }
                        $rawRequestId = [string]$json.request_id
                        if ([string]::IsNullOrWhiteSpace($rawRequestId)) {
                            Write-ShadowJsonResponse $response ([PSCustomObject]@{
                                status = "ignored"
                                reason = "missing_request_id"
                            })
                            continue
                        }
                        $requestId = Request-ShadowRequestCancellation -RequestId $rawRequestId
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "success"
                            request_id = $requestId
                        })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "ignored"
                            reason = $_.Exception.Message
                        })
                    }
                    continue
                }
            }

            # Intercept command execution API endpoint
            if ($urlPath -eq "/api/run/cancel") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $body = $reader.ReadToEnd()
                        $reader.Close()
                        $json = if ([string]::IsNullOrWhiteSpace($body)) { [PSCustomObject]@{} } else { $body | ConvertFrom-Json }
                        $commandId = Request-ShadowRunCancellation -CommandId ([string]$json.command_id)
                        $processKilled = Stop-ShadowRunProcessForCancellation -CommandId $commandId
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "success"
                            command_id = $commandId
                            process_killed = [bool]$processKilled
                            message = "Cancellation requested."
                        })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 400
                    }
                    continue
                }
            }

            if ($urlPath -eq "/api/run") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    $reader = New-Object System.IO.StreamReader($request.InputStream)
                    $body = $reader.ReadToEnd()
                    $json = $body | ConvertFrom-Json
                    $command = $json.command
                    $command = Sanitize-ShadowSshCommand -Command $command
                    $command = Resolve-ShadowStartProcessShortcutCommand -Command $command
                    $timeoutMs = Get-ShadowRunTimeoutMilliseconds -JsonBody $json
                    $commandId = Normalize-ShadowRunCommandId ([string]$json.command_id)
                    $exitCode = $null
                    $timedOut = $false
                    $cancelled = $false
                    
                    try {
                        if (Test-ShadowProtectedWriteCommand $command) {
                            $output = "BLOCKED: This command targets protected Shadow metadata or memory storage. Use the dedicated memory APIs for memories.json and do not modify .git metadata through Shadow."
                            $status = "error"
                        } else {
                            $runResult = Invoke-ShadowCommandWithTimeout -Command $command -TimeoutMilliseconds $timeoutMs -CommandId $commandId
                            $output = $runResult.output
                            $status = $runResult.status
                            $exitCode = $runResult.exitCode
                            $timedOut = [bool]$runResult.timedOut
                            $cancelled = [bool]$runResult.cancelled
                        }
                    } catch {
                        $output = $_.Exception.Message
                        $status = "error"
                    }
                    
                    $resObj = [PSCustomObject]@{
                        status = $status
                        output = $output
                        exitCode = $exitCode
                        timedOut = $timedOut
                        cancelled = $cancelled
                        command_id = $commandId
                    }
                    $resJson = $resObj | ConvertTo-Json -Compress
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
            }

            # Intercept config read/write API endpoints
            if ($urlPath -eq "/api/config") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                
                $configPath = Get-ShadowPrivatePath "config.json"
                
                if ($request.HttpMethod -eq "GET") {
                    $configJson = "{}"
                    if (Test-Path $configPath) {
                        $rawConfigJson = Get-Content $configPath -Raw
                        if (-not [string]::IsNullOrWhiteSpace($rawConfigJson)) {
                            $configJson = $rawConfigJson
                        }
                    }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($configJson)
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
                
                if ($request.HttpMethod -eq "POST") {
                    $reader = New-Object System.IO.StreamReader($request.InputStream)
                    $body = $reader.ReadToEnd()
                    if ([string]::IsNullOrWhiteSpace($body)) { $body = "{}" }
                    $writeConfig = $true
                    try {
                        $incomingConfig = $body | ConvertFrom-Json
                        $incomingSavedAt = 0
                        if ($incomingConfig.PSObject.Properties.Name -contains "shadow_config_saved_at") {
                            $incomingSavedAt = [double]$incomingConfig.shadow_config_saved_at
                        }
                        if ($incomingSavedAt -gt 0 -and (Test-Path $configPath)) {
                            $existingRaw = Get-Content $configPath -Raw -ErrorAction SilentlyContinue
                            if (-not [string]::IsNullOrWhiteSpace($existingRaw)) {
                                $existingConfig = $existingRaw | ConvertFrom-Json
                                if ($existingConfig.PSObject.Properties.Name -contains "shadow_config_saved_at") {
                                    $existingSavedAt = [double]$existingConfig.shadow_config_saved_at
                                    if ($existingSavedAt -gt $incomingSavedAt) {
                                        $writeConfig = $false
                                    }
                                }
                            }
                        }
                    } catch { }
                    if ($writeConfig) {
                        [System.IO.File]::WriteAllText($configPath, $body)
                    }
                    
                    $resObj = [PSCustomObject]@{ status = "success"; stale_ignored = (-not $writeConfig) }
                    $resJson = $resObj | ConvertTo-Json -Compress
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
            }

            # Intercept memories backup API endpoint
            if ($urlPath -eq "/api/memories/backup") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                
                if ($request.HttpMethod -eq "POST") {
                    $memPath = Join-Path $scriptDir "memories.json"
                    $resObj = $null
                    if (Test-Path $memPath) {
                        $ts = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
                        $backupDir = Join-Path $scriptDir "backups"
                        if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
                        $backupPath = Join-Path $backupDir "memories_backup_$ts.json"
                        Copy-Item $memPath $backupPath -Force
                        $resObj = [PSCustomObject]@{ status = "success"; backupFile = "backups/memories_backup_$ts.json" }
                    } else {
                        $resObj = [PSCustomObject]@{ status = "no_memories_file" }
                    }
                    $resJson = $resObj | ConvertTo-Json -Compress
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
            }

            # Browser automation is disabled. Keep this endpoint as a hard block
            # for stale app windows or cached model/tool calls.
            if ($urlPath -eq "/api/browser") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                
                if ($request.HttpMethod -eq "POST") {
                    $resJson = "{`"success`":false,`"status`":`"disabled`",`"error`":`"Browser automation is disabled. Use search_web/web_search through SearXNG for research, or run_powershell_command with Start-Process only when the user explicitly asks to open a URL in their normal browser.`"}"
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
            }

            # Intercept scheduler/cron API endpoints â€” proxy to scheduler service on port 9333
            if ($urlPath -match "^/api/scheduler(/.*)?$") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                
                try {
                    $schedulerPath = $urlPath -replace '^/api/scheduler', '/api'
                    $fullUrl = "http://127.0.0.1:9333$schedulerPath"
                    if ($request.Url.Query) { $fullUrl += $request.Url.Query }
                    $bodyString = ""

                    if ($request.HttpMethod -eq "POST") {
                        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                        $bodyString = $reader.ReadToEnd()
                        $reader.Close()
                    } elseif ($request.HttpMethod -ne "GET" -and $request.HttpMethod -ne "DELETE") {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = "Unsupported scheduler proxy method: $($request.HttpMethod)" }) 405
                        continue
                    }

                    $schedulerResult = Invoke-ShadowSchedulerProxyRequest -Method $request.HttpMethod -Url $fullUrl -Body $bodyString -TimeoutMilliseconds 10000
                    $resJson = if ([string]::IsNullOrWhiteSpace($schedulerResult.body)) { "{}" } else { $schedulerResult.body }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    Add-ShadowCorsOrigin $response
                    $response.StatusCode = [int]$schedulerResult.statusCode
                    $response.ContentType = if ([string]::IsNullOrWhiteSpace($schedulerResult.contentType)) { "application/json; charset=utf-8" } else { $schedulerResult.contentType }
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                } catch {
                    $resObj = [PSCustomObject]@{
                        status = "error"
                        error = "Scheduler proxy failed: $($_.Exception.Message)"
                        hint = "Make sure the scheduler service is running on http://127.0.0.1:9333. The proxy times out after 10s so Shadow's main server stays responsive."
                    }
                    $resJson = $resObj | ConvertTo-Json -Compress
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    Add-ShadowCorsOrigin $response
                    $response.StatusCode = 502
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                }
                continue
            }

            # Intercept local SearXNG search API endpoint.
            # /api/search is the shared Gemini/subagent route; /api/searx is a compatibility alias.
            if ($urlPath -eq "/api/search" -or $urlPath -eq "/api/searx") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                        $bodyString = $reader.ReadToEnd()
                        $reader.Close()
                        $searchReq = $bodyString | ConvertFrom-Json

                        $query = [string]$searchReq.query
                        if ([string]::IsNullOrWhiteSpace($query)) {
                            throw "Missing required search query."
                        }

                        $count = 5
                        if ($searchReq.count) { $count = [int]$searchReq.count }
                        if ($count -lt 1) { $count = 1 }
                        if ($count -gt 8) { $count = 8 }

                        $searchTimeoutMs = Get-ShadowSearchTimeoutMilliseconds -JsonBody $searchReq
                        $searchStartedAt = [DateTime]::UtcNow

                        $privateConfig = $null
                        try {
                            $configPath = Get-ShadowPrivatePath "config.json"
                            if (Test-Path $configPath) {
                                $configRaw = Get-Content $configPath -Raw -ErrorAction SilentlyContinue
                                if (-not [string]::IsNullOrWhiteSpace($configRaw)) {
                                    $privateConfig = $configRaw | ConvertFrom-Json
                                }
                            }
                        } catch { $privateConfig = $null }

                        $configuredBaseUrl = $env:SHADOW_SEARXNG_URL
                        if ([string]::IsNullOrWhiteSpace($configuredBaseUrl) -and $privateConfig -and ($privateConfig.PSObject.Properties.Name -contains "shadow_searxng_url")) {
                            $configuredBaseUrl = [string]$privateConfig.shadow_searxng_url
                        }
                        $configuredPort = $env:SHADOW_SEARXNG_PORT
                        if ([string]::IsNullOrWhiteSpace($configuredPort) -and $privateConfig -and ($privateConfig.PSObject.Properties.Name -contains "shadow_searxng_port")) {
                            $configuredPort = [string]$privateConfig.shadow_searxng_port
                        }

                        if ([string]::IsNullOrWhiteSpace($configuredBaseUrl)) {
                            $baseUrls = @(
                                "http://127.0.0.1:8888/search",
                                "http://localhost:8888/search"
                            )
                        } else {
                            $builder = New-Object System.UriBuilder -ArgumentList $configuredBaseUrl
                            if (-not [string]::IsNullOrWhiteSpace($configuredPort)) {
                                $portNum = [int]$configuredPort
                                if ($portNum -lt 1 -or $portNum -gt 65535) { throw "Invalid SearXNG port: $configuredPort" }
                                $builder.Port = $portNum
                            }
                            if ([string]::IsNullOrWhiteSpace($builder.Path) -or $builder.Path -eq "/") {
                                $builder.Path = "/search"
                            }
                            $baseUrls = @($builder.Uri.AbsoluteUri.TrimEnd('?'))
                        }

                        $searchPayload = $null
                        $searchMode = $null
                        $usedBaseUrl = $null
                        $lastSearchError = $null
                        foreach ($baseUrl in $baseUrls) {

                            # --- Try JSON first ---
                            try {
                                $attemptTimeoutMs = Get-ShadowSearchAttemptTimeoutMilliseconds -StartedAt $searchStartedAt -TimeoutMilliseconds $searchTimeoutMs
                                if ($attemptTimeoutMs -le 0) {
                                    $lastSearchError = "Search proxy timed out after $([Math]::Round($searchTimeoutMs / 1000))s before querying $baseUrl."
                                    break
                                }
                                $jsonUrl = "${baseUrl}?q=$([System.Uri]::EscapeDataString($query))&format=json&pageno=1"
                                if ($searchReq.categories) { $jsonUrl += "&categories=$([System.Uri]::EscapeDataString([string]$searchReq.categories))" }
                                if ($searchReq.language) { $jsonUrl += "&language=$([System.Uri]::EscapeDataString([string]$searchReq.language))" }
                                if ($searchReq.time_range) { $jsonUrl += "&time_range=$([System.Uri]::EscapeDataString([string]$searchReq.time_range))" }

                                $webReq = [System.Net.HttpWebRequest]::Create($jsonUrl)
                                $webReq.Method = "GET"
                                $webReq.Accept = "application/json"
                                $webReq.UserAgent = "ShadowAI/1.0"
                                $webReq.Timeout = $attemptTimeoutMs
                                $webReq.ReadWriteTimeout = $attemptTimeoutMs
                                $webReq.Proxy = $null
                                $webResp = $null
                                try {
                                    $webResp = $webReq.GetResponse()
                                    $respStream = $webResp.GetResponseStream()
                                    $respReader = New-Object System.IO.StreamReader($respStream, [System.Text.Encoding]::UTF8)
                                    $respBody = $respReader.ReadToEnd()
                                    $respReader.Close()
                                    $searchPayload = $respBody | ConvertFrom-Json
                                    $searchMode = "json"
                                } finally {
                                    if ($webResp) { $webResp.Close() }
                                }
                                $usedBaseUrl = $baseUrl
                                break
                            } catch {
                                $lastSearchError = "JSON request failed for ${baseUrl}: $($_.Exception.Message)"
                            }

                            # --- Fallback: request HTML and scrape results ---
                            try {
                                $attemptTimeoutMs = Get-ShadowSearchAttemptTimeoutMilliseconds -StartedAt $searchStartedAt -TimeoutMilliseconds $searchTimeoutMs
                                if ($attemptTimeoutMs -le 0) {
                                    $lastSearchError = "Search proxy timed out after $([Math]::Round($searchTimeoutMs / 1000))s before HTML fallback for $baseUrl."
                                    break
                                }
                                $htmlUrl = "${baseUrl}?q=$([System.Uri]::EscapeDataString($query))&pageno=1"
                                $webReq = [System.Net.HttpWebRequest]::Create($htmlUrl)
                                $webReq.Method = "GET"
                                $webReq.Accept = "text/html,application/xhtml+xml"
                                $webReq.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
                                $webReq.Timeout = $attemptTimeoutMs
                                $webReq.ReadWriteTimeout = $attemptTimeoutMs
                                $webReq.Proxy = $null
                                $webResp = $null
                                try {
                                    $webResp = $webReq.GetResponse()
                                    $respStream = $webResp.GetResponseStream()
                                    $respReader = New-Object System.IO.StreamReader($respStream, [System.Text.Encoding]::UTF8)
                                    $html = $respReader.ReadToEnd()
                                    $respReader.Close()

                                    # Scrape results from SearXNG HTML
                                    $scrapedResults = @()
                                    $articlePattern = '<article\s+class="[^"]*result[^"]*"[^>]*>(.*?)</article>'
                                    $articleMatches = [regex]::Matches($html, $articlePattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
                                    foreach ($m in $articleMatches) {
                                        if ($scrapedResults.Count -ge $count) { break }
                                        $inner = $m.Groups[1].Value

                                        # Extract title from <h3> or <a> with result-title class
                                        $title = ''
                                        $titleMatch = [regex]::Match($inner, '<(?:h3|a)[^>]*class="[^"]*?(?:result-title|url_header)[^"]*?"[^>]*>(.*?)</(?:h3|a)>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
                                        if ($titleMatch.Success) { $title = [regex]::Replace($titleMatch.Groups[1].Value, '<[^>]+>', '').Trim() }
                                        if (-not $title) {
                                            $titleMatch = [regex]::Match($inner, '<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
                                            if ($titleMatch.Success) { $title = [regex]::Replace($titleMatch.Groups[2].Value, '<[^>]+>', '').Trim() }
                                        }

                                        # Extract URL
                                        $url = ''
                                        $urlMatch = [regex]::Match($inner, '<a[^>]*href="([^"]+)"[^>]*class="[^"]*?(?:result-link|url_wrapper)[^"]*?"', [System.Text.RegularExpressions.RegexOptions]::Singleline)
                                        if ($urlMatch.Success) { $url = $urlMatch.Groups[1].Value }
                                        if (-not $url) {
                                            $urlMatch = [regex]::Match($inner, '<a[^>]*href="(https?://[^"]+)"', [System.Text.RegularExpressions.RegexOptions]::Singleline)
                                            if ($urlMatch.Success) { $url = $urlMatch.Groups[1].Value }
                                        }

                                        # Extract snippet
                                        $snippet = ''
                                        $snippetMatch = [regex]::Match($inner, '<p[^>]*class="[^"]*?(?:content|result-content)[^"]*?"[^>]*>(.*?)</p>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
                                        if ($snippetMatch.Success) { $snippet = [regex]::Replace($snippetMatch.Groups[1].Value, '<[^>]+>', '').Trim() }
                                        if (-not $snippet) {
                                            $snippetMatch = [regex]::Match($inner, '<p[^>]*>(.*?)</p>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
                                            if ($snippetMatch.Success) { $snippet = [regex]::Replace($snippetMatch.Groups[1].Value, '<[^>]+>', '').Trim() }
                                        }

                                        if ($title -or $url) {
                                            $scrapedResults += [PSCustomObject]@{ title = $title; url = $url; content = $snippet.Substring(0, [Math]::Min($snippet.Length, 300)) }
                                        }
                                    }

                                    $searchPayload = [PSCustomObject]@{ results = $scrapedResults }
                                    $searchMode = "html"
                                } finally {
                                    if ($webResp) { $webResp.Close() }
                                }
                                $usedBaseUrl = $baseUrl
                                break
                            } catch {
                                $lastSearchError = $_.Exception.Message
                            }
                        }

                        if ($null -eq $searchPayload) {
                            throw "Could not query SearXNG within $([Math]::Round($searchTimeoutMs / 1000))s. Check the SearXNG URL and port in Settings. Last error: $lastSearchError"
                        }

                        $results = @()
                        if ($searchPayload.results) {
                            $results = @($searchPayload.results | Select-Object -First $count | ForEach-Object {
                                $snippet = if ($_.content) { $_.content.Substring(0, [Math]::Min($_.content.Length, 300)) } else { "" }
                                [PSCustomObject]@{
                                    title = $_.title
                                    url = $_.url
                                    content = $snippet
                                }
                            })
                        }

                        $resObj = [PSCustomObject]@{
                            status = "success"
                            query = $query
                            source = $usedBaseUrl
                            mode = $searchMode
                            timeout_ms = $searchTimeoutMs
                            results = $results
                        }
                        $resJson = $resObj | ConvertTo-Json -Depth 8 -Compress
                    } catch {
                        $resObj = [PSCustomObject]@{
                            status = "error"
                            error = $_.Exception.Message
                            hint = "Make sure local SearXNG is running and reachable at the configured URL and port, for example http://127.0.0.1:8888/search. You can pass timeout_ms to /api/search; Shadow clamps it between 3s and 30s."
                        }
                        $resJson = $resObj | ConvertTo-Json -Compress
                    }

                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
            }

            # /api/weather returns REAL current conditions from the free Open-Meteo API.
            # Web-search snippets do not contain live numbers, so the model used to
            # hallucinate the temperature; this gives it ground-truth values already in
            # Celsius and km/h.
            if ($urlPath -eq "/api/weather") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                        $wBody = $reader.ReadToEnd()
                        $reader.Close()
                        $wreq = $wBody | ConvertFrom-Json

                        $location = [string]$wreq.location
                        $country = [string]$wreq.country
                        $lat = $null
                        $lon = $null
                        $resolvedName = $location
                        $resolvedCountry = $null
                        $resolvedAdmin = $null

                        if ($null -ne $wreq.latitude -and $null -ne $wreq.longitude) {
                            $lat = [double]$wreq.latitude
                            $lon = [double]$wreq.longitude
                        } else {
                            if ([string]::IsNullOrWhiteSpace($location)) { throw "Missing location (or latitude/longitude) for weather lookup." }
                            $geoUrl = "https://geocoding-api.open-meteo.com/v1/search?name=$([System.Uri]::EscapeDataString($location))&count=10&language=en&format=json"
                            $geo = Invoke-RestMethod -Uri $geoUrl -TimeoutSec 10 -UserAgent "ShadowAI/1.0"
                            if (-not $geo.results -or @($geo.results).Count -eq 0) { throw "Could not find a place named '$location'." }
                            $cands = @($geo.results)
                            $pick = $null
                            if (-not [string]::IsNullOrWhiteSpace($country)) {
                                $pick = $cands | Where-Object { $_.name -ieq $location -and ($_.country_code -ieq $country -or $_.country -ieq $country) } | Select-Object -First 1
                            }
                            if (-not $pick) { $pick = $cands | Where-Object { $_.name -ieq $location } | Sort-Object { if ($_.population) { [int]$_.population } else { 0 } } -Descending | Select-Object -First 1 }
                            if (-not $pick) { $pick = $cands | Sort-Object { if ($_.population) { [int]$_.population } else { 0 } } -Descending | Select-Object -First 1 }
                            if (-not $pick) { $pick = $cands[0] }
                            $lat = [double]$pick.latitude
                            $lon = [double]$pick.longitude
                            $resolvedName = [string]$pick.name
                            $resolvedCountry = [string]$pick.country
                            $resolvedAdmin = [string]$pick.admin1
                        }

                        $inv = [System.Globalization.CultureInfo]::InvariantCulture
                        $latStr = $lat.ToString($inv)
                        $lonStr = $lon.ToString($inv)
                        # Use Open-Meteo's default best_match for CURRENT conditions. We
                        # previously pinned ecmwf_ifs025 for cross-country consistency, but
                        # the ECMWF IFS global model only runs 4x/day (00/06/12/18 UTC) and
                        # publishes hours later, so its "current" value is a smooth forecast
                        # step from an old run - it barely changes between calls and reads as
                        # stale ("info from hours ago"). best_match blends in rapid-update,
                        # hourly regional models that ingest recent observations, so the
                        # reading reflects right-now conditions everywhere in the world.
                        $wxUrl = "https://api.open-meteo.com/v1/forecast?latitude=$latStr&longitude=$lonStr&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,is_day&daily=weather_code,precipitation_probability_max,temperature_2m_max,temperature_2m_min&forecast_days=3&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto"
                        $wx = Invoke-RestMethod -Uri $wxUrl -TimeoutSec 10 -UserAgent "ShadowAI/1.0"
                        $cur = $wx.current

                        # Compute how old the reading is so staleness is never silent. $cur.time
                        # is the location's LOCAL wall-clock (timezone=auto); convert "now" into
                        # that same local zone using utc_offset_seconds, then diff.
                        $observedMinutesAgo = $null
                        $observedLocalLabel = $null
                        try {
                            if (-not [string]::IsNullOrWhiteSpace([string]$cur.time)) {
                                $inv2 = [System.Globalization.CultureInfo]::InvariantCulture
                                $observed = [datetime]::Parse([string]$cur.time, $inv2, [System.Globalization.DateTimeStyles]::None)
                                $offsetSec = if ($null -ne $wx.utc_offset_seconds) { [int]$wx.utc_offset_seconds } else { 0 }
                                $localNow = [datetime]::UtcNow.AddSeconds($offsetSec)
                                $observedMinutesAgo = [int][math]::Round(($localNow - $observed).TotalMinutes)
                                if ($observedMinutesAgo -lt 0) { $observedMinutesAgo = 0 }
                                $observedLocalLabel = $observed.ToString("HH:mm", $inv2)
                            }
                        } catch { }

                        $codeMap = @{ 0 = 'clear sky'; 1 = 'mainly clear'; 2 = 'partly cloudy'; 3 = 'overcast'; 45 = 'fog'; 48 = 'depositing rime fog'; 51 = 'light drizzle'; 53 = 'moderate drizzle'; 55 = 'dense drizzle'; 56 = 'light freezing drizzle'; 57 = 'dense freezing drizzle'; 61 = 'slight rain'; 63 = 'moderate rain'; 65 = 'heavy rain'; 66 = 'light freezing rain'; 67 = 'heavy freezing rain'; 71 = 'slight snowfall'; 73 = 'moderate snowfall'; 75 = 'heavy snowfall'; 77 = 'snow grains'; 80 = 'slight rain showers'; 81 = 'moderate rain showers'; 82 = 'violent rain showers'; 85 = 'slight snow showers'; 86 = 'heavy snow showers'; 95 = 'thunderstorm'; 96 = 'thunderstorm with slight hail'; 99 = 'thunderstorm with heavy hail' }
                        $code = [int]$cur.weather_code
                        $condition = if ($codeMap.ContainsKey($code)) { $codeMap[$code] } else { "weather code $code" }

                        # Convert the wind bearing (0-360 deg) to a compass word. Exposing the
                        # raw degree number caused the model to read e.g. "225" as the wind SPEED;
                        # a cardinal string removes that ambiguity entirely.
                        $windDir = $null
                        if ($null -ne $cur.wind_direction_10m) {
                            $compass = @('N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW')
                            $windDir = $compass[([int][math]::Round(([double]$cur.wind_direction_10m % 360) / 22.5)) % 16]
                        }

                        $placeLabel = $resolvedName
                        if (-not [string]::IsNullOrWhiteSpace($resolvedAdmin)) { $placeLabel = "$placeLabel, $resolvedAdmin" }
                        if (-not [string]::IsNullOrWhiteSpace($resolvedCountry)) { $placeLabel = "$placeLabel, $resolvedCountry" }

                        $windPhrase = "wind $($cur.wind_speed_10m) km/h"
                        if ($windDir) { $windPhrase = "$windPhrase from the $windDir" }
                        if ($null -ne $cur.wind_gusts_10m) { $windPhrase = "$windPhrase, gusting to $($cur.wind_gusts_10m) km/h" }

                        # Short daily forecast so the tool can answer "is it going to rain / thunderstorm?"
                        # questions (current conditions alone cannot). Weather codes 51-82 = rain/showers,
                        # 95-99 = thunderstorm.
                        $forecast = @()
                        $forecastParts = @()
                        if ($wx.daily -and $wx.daily.time) {
                            $fdays = @($wx.daily.time)
                            for ($fi = 0; $fi -lt [Math]::Min(3, $fdays.Count); $fi++) {
                                $dCode = [int]$wx.daily.weather_code[$fi]
                                $dCond = if ($codeMap.ContainsKey($dCode)) { $codeMap[$dCode] } else { "weather code $dCode" }
                                $dPop = $wx.daily.precipitation_probability_max[$fi]
                                $dMax = $wx.daily.temperature_2m_max[$fi]
                                $dMin = $wx.daily.temperature_2m_min[$fi]
                                $dLabel = switch ($fi) { 0 { 'today' } 1 { 'tomorrow' } default { [string]$fdays[$fi] } }
                                $dThunder = ($dCode -ge 95)
                                $dRain = (($dCode -ge 51) -and ($dCode -le 82)) -or ($dCode -ge 95)
                                $forecast += [PSCustomObject]@{
                                    day                               = $dLabel
                                    date                              = [string]$fdays[$fi]
                                    condition                         = $dCond
                                    precipitation_probability_percent = $dPop
                                    temp_max_c                        = $dMax
                                    temp_min_c                        = $dMin
                                    rain_expected                     = $dRain
                                    thunderstorm_expected             = $dThunder
                                }
                                $forecastParts += "$dLabel $dCond (high $dMax / low $dMin deg C, $dPop% chance of precip)"
                            }
                        }
                        $forecastSummary = $forecastParts -join '; '

                        $resObj = [PSCustomObject]@{
                            status                 = "success"
                            source                 = "open-meteo.com"
                            location               = $placeLabel
                            latitude               = $lat
                            longitude              = $lon
                            timezone               = [string]$wx.timezone
                            observed_at            = [string]$cur.time
                            observed_local_time    = $observedLocalLabel
                            observed_minutes_ago   = $observedMinutesAgo
                            temperature_c          = $cur.temperature_2m
                            apparent_temperature_c = $cur.apparent_temperature
                            humidity_percent       = $cur.relative_humidity_2m
                            wind_speed_kmh         = $cur.wind_speed_10m
                            wind_gust_kmh          = $cur.wind_gusts_10m
                            wind_from              = $windDir
                            is_day                 = ([int]$cur.is_day -eq 1)
                            condition              = $condition
                            summary                = "Current weather in $($placeLabel) as of $observedLocalLabel local time: $($cur.temperature_2m) deg C (feels like $($cur.apparent_temperature) deg C), $condition, $windPhrase, humidity $($cur.relative_humidity_2m)%."
                            forecast               = $forecast
                            forecast_summary       = $forecastSummary
                            instruction            = "These are live, just-fetched values - observed_minutes_ago tells you how fresh they are (typically 0-15 min). For 'is it going to rain / thunderstorm / what's the weather later/tomorrow' questions, use the 'forecast' array / 'forecast_summary' (rain_expected and thunderstorm_expected flags + precipitation_probability_percent per day). wind_speed_kmh is the wind SPEED in km/h and wind_from is a compass DIRECTION (a word like SW, not a number) - never report the direction as a speed. All values are already in the user's preferred units (Celsius and km/h); state them exactly, do not convert or invent numbers, and never reuse a weather value from earlier in the conversation - always trust this fresh result."
                        }
                        $resJson = $resObj | ConvertTo-Json -Depth 6 -Compress
                    } catch {
                        $resObj = [PSCustomObject]@{
                            status = "error"
                            error  = $_.Exception.Message
                            hint   = "Weather uses the free Open-Meteo API and needs outbound internet to geocoding-api.open-meteo.com and api.open-meteo.com."
                        }
                        $resJson = $resObj | ConvertTo-Json -Compress
                    }

                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
            }

            # Intercept skills save API endpoint
            if ($urlPath -eq "/api/skills/save") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                        $body = $reader.ReadToEnd()
                        $reader.Close()
                        $json = $body | ConvertFrom-Json
                        $skillName = [string]$json.skill_name
                        $instructions = [string]$json.instructions

                        if ([string]::IsNullOrWhiteSpace($skillName)) { throw "Missing skill_name." }
                        if ([string]::IsNullOrWhiteSpace($instructions)) { throw "Missing instructions." }

                        $safeName = ($skillName -replace '[^a-zA-Z0-9_-]+', '_').Trim('_')
                        if ([string]::IsNullOrWhiteSpace($safeName)) { throw "Invalid skill_name after sanitization." }

                        $resObj = $null
                        $skillsDir = Join-Path $scriptDir "skills"

                        # Quality guard: only persist genuinely reusable PROCEDURES. Reject trivial,
                        # throwaway-test, date-stamped one-off, or creative-content "skills" so the
                        # library stays clean (the same over-eager-capture the memory system had).
                        $combinedSkillText = "$skillName`n$instructions"
                        $normInstr = ($instructions -replace '\s+', ' ').Trim()
                        $nameSalientCount = @(Get-ShadowReusableTokens @($safeName) | Where-Object { $script:ShadowGenericReusableTokens -notcontains $_ }).Count
                        $skillRejectReason = $null
                        if ($normInstr.Length -lt 80) {
                            $skillRejectReason = "too short to be a reusable multi-step procedure"
                        } elseif ($combinedSkillText -match '(?i)(test\.txt|named[_\s]test|create[_\s]text[_\s]named|hello[_\s]world)') {
                            $skillRejectReason = "looks like a throwaway test rather than a reusable skill"
                        } elseif (($combinedSkillText -match '(?i)\b(sci-?fi|short\s*story|\bstory\b|stories|poem|essay|novel|lyrics|haiku|screenplay|fairy\s*tale)\b') -and ($combinedSkillText -match '(?i)\b(write|compose|generate|create|tell)\b')) {
                            $skillRejectReason = "creative content generation is a one-off, not an automation"
                        } elseif (($safeName -match '(?i)_20[2-9]\d($|_)') -or ($combinedSkillText -match '(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*20[2-9]\d\b')) {
                            $skillRejectReason = "tied to a specific date/period, so it is a one-off rather than reusable"
                        } elseif (($combinedSkillText -match '(?i)\b(current (system )?time|what time is it|today.?s date|current date)\b') -and ($normInstr.Length -lt 200)) {
                            $skillRejectReason = "a trivial one-liner lookup, not a reusable workflow"
                        } elseif ($safeName -match '(?i)(^|_)(think|thinks|thinking|wonder|wondering|guess|figure_?out|not_?sure|trying_?to|user_?wants|wants_?to|maybe|probably|unsure)(_|$)') {
                            $skillRejectReason = "reads as a vague intention or the model's own reasoning, not a concrete repeatable procedure"
                        } elseif ($nameSalientCount -eq 0) {
                            # The name is only scaffolding words (create/file/html/open/page/run) with no
                            # concrete subject. Such a name is neither accurate nor findable later.
                            $skillRejectReason = "the name has no specific subject; name it after the concrete deliverable or target (e.g. download_youtube_audio, deploy_landing_page_to_vps), not generic words like create/file/html"
                        }
                        if ($skillRejectReason) {
                            $resObj = [PSCustomObject]@{ status = "skipped"; message = "Skill not saved ($skillRejectReason). Save only repeatable, multi-step automations worth reusing later."; reason = $skillRejectReason }
                        }

                        $skillFindResult = $null
                        # If a skill with this EXACT name already exists, it takes precedence: update it
                        # (handled by the save path below, which overwrites the same-name file). We must NOT
                        # let a fuzzy match to a DIFFERENT skill hijack the merge — that is what made a
                        # second "portfolio_demo" save merge into the unrelated "calculator" skill, because
                        # -ExcludeName hid the real same-named skill and the next-best fuzzy match won.
                        $sameNameSkillExists = Test-Path (Join-Path $skillsDir $safeName) -PathType Container
                        if (-not $resObj) {
                            $skillFindResult = Find-ShadowReusableArtifact -RootDir $skillsDir -Kind "skill" -RequestName $safeName -RequestText $instructions -ExcludeName $safeName
                            $skillMatch = if ($skillFindResult -and -not $sameNameSkillExists) { $skillFindResult.Match } else { $null }
                            if ($skillMatch) {
                                $existingInstPath = Join-Path $skillMatch.Path "instructions.txt"
                                if (Test-Path $existingInstPath -PathType Leaf) {
                                    $existingContent = Get-Content $existingInstPath -Raw -ErrorAction SilentlyContinue
                                    # "Already covered" if the new steps are an exact substring OR a near-duplicate
                                    # of the existing content. The similarity check keeps the file from bloating with
                                    # back-to-back "--- Updated ---" sections that just restate the same procedure.
                                    $instrSim = Get-ShadowReusableSimilarity @(Get-ShadowReusableTokens @($instructions)) @(Get-ShadowReusableTokens @($existingContent))
                                    if ((($existingContent -replace '\s+', ' ').Trim().ToLower()).Contains($normInstr.ToLower()) -or $instrSim.score -ge 0.85) {
                                        $resObj = [PSCustomObject]@{ status = "success"; message = "Skill already covered by '$($skillMatch.Name)'; left unchanged."; merged_into = $skillMatch.Name; merged_kind = "skill" }
                                    } else {
                                        $mergedInstructions = "$existingContent`n`n--- Updated ---`n$instructions"
                                        [System.IO.File]::WriteAllText($existingInstPath, $mergedInstructions, [System.Text.Encoding]::UTF8)
                                        $resObj = [PSCustomObject]@{ status = "success"; message = "Skill merged into existing similar skill '$($skillMatch.Name)'"; merged_into = $skillMatch.Name; merged_kind = "skill" }
                                    }
                                }
                            }
                        }

                        # (Removed a second, looser keyword-overlap merge path that used a tiny stopword
                        # list and merged on bare name-token overlap. It was redundant with the
                        # salient-gated Find-ShadowReusableArtifact above and was a source of wrong merges:
                        # two merge heuristics with different vocabularies disagreeing. One mechanism now.)

                        # No merge found â€” save as new skill
                        if (-not $resObj) {
                            $skillsDir = Join-Path $scriptDir "skills"
                            $skillDir = Join-Path $skillsDir $safeName
                            $skillFile = Join-Path $skillDir "instructions.txt"
                            $resolvedSkillFile = [System.IO.Path]::GetFullPath($skillFile)
                            $resolvedSkillsDir = [System.IO.Path]::GetFullPath($skillsDir)
                            if (-not $resolvedSkillFile.StartsWith($resolvedSkillsDir)) { throw "Path traversal blocked." }
                            if (-not (Test-Path $skillDir)) { New-Item -ItemType Directory -Path $skillDir -Force | Out-Null }
                            $alreadyExisted = Test-Path $skillFile -PathType Leaf
                            [System.IO.File]::WriteAllText($skillFile, $instructions, [System.Text.Encoding]::UTF8)
                            $resObj = [PSCustomObject]@{
                                status = "success"
                                message = if ($alreadyExisted) { "Skill '$safeName' overwritten (same name)" } else { "Skill saved as $safeName" }
                                skill_name = $safeName
                                path = $resolvedSkillFile
                                overwrote_same_name = [bool]$alreadyExisted
                                closest_skill = if ($skillFindResult) { [string]$skillFindResult.ClosestName } else { "" }
                                closest_name_sim = if ($skillFindResult) { $skillFindResult.ClosestNameSim } else { 0 }
                                closest_content_sim = if ($skillFindResult) { $skillFindResult.ClosestContentSim } else { 0 }
                            }
                        }

                        $resJson = $resObj | ConvertTo-Json -Compress
                    } catch {
                        $resObj = [PSCustomObject]@{ status = "error"; error = $_.Exception.Message }
                        $resJson = $resObj | ConvertTo-Json -Compress
                    }

                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resJson)
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
            }

            # Skills delete-all endpoint
            if ($urlPath -eq "/api/skills/all") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "GET") {
                    try {
                        $skillsDir = Join-Path $scriptDir "skills"
                        $list = @()
                        if (Test-Path $skillsDir -PathType Container) {
                            Get-ChildItem -Path $skillsDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
                                $instPath = Join-Path $_.FullName "instructions.txt"
                                $content = ""
                                if (Test-Path $instPath -PathType Leaf) { $content = Get-Content $instPath -Raw -ErrorAction SilentlyContinue }
                                $list += [PSCustomObject]@{
                                    name         = $_.Name
                                    instructions = [string]$content
                                    updated      = $_.LastWriteTime.ToString("o")
                                }
                            }
                        }
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success"; skills = @($list) })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 500
                    }
                    continue
                }

                if ($request.HttpMethod -eq "DELETE") {
                    try {
                        $skillsDir = Join-Path $scriptDir "skills"
                        $resolvedSkillsDir = [System.IO.Path]::GetFullPath($skillsDir)
                        $resolvedScriptDir = [System.IO.Path]::GetFullPath($scriptDir)
                        if (-not $resolvedSkillsDir.StartsWith($resolvedScriptDir, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Path traversal blocked." }
                        $deleted = 0
                        if (Test-Path $skillsDir -PathType Container) {
                            Get-ChildItem -Path $skillsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                                Remove-Item $_.FullName -Recurse -Force
                                $deleted++
                            }
                        }
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success"; deletedCount = $deleted })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 500
                    }
                    continue
                }
            }

            # Skills delete endpoint
            if ($urlPath -eq "/api/skills/delete") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
                        $body = $reader.ReadToEnd()
                        $reader.Close()
                        $json = $body | ConvertFrom-Json
                        $skillName = [string]$json.skill_name
                        if ([string]::IsNullOrWhiteSpace($skillName)) { throw "skill_name is required." }
                        if (-not ($skillName -match '^[a-zA-Z0-9_-]+$')) { throw "skill_name must use only letters, numbers, underscores, or hyphens." }
                        $skillsDir = Join-Path $scriptDir "skills"
                        $skillDir = Join-Path $skillsDir $skillName
                        $resolvedSkillDir = [System.IO.Path]::GetFullPath($skillDir)
                        $resolvedSkillsDir = [System.IO.Path]::GetFullPath($skillsDir)
                        if (-not $resolvedSkillDir.StartsWith($resolvedSkillsDir, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Path traversal blocked." }
                        if (-not (Test-Path $skillDir -PathType Container)) { throw "Skill not found: $skillName" }
                        Remove-Item $skillDir -Recurse -Force
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success"; message = "Skill '$skillName' deleted."; deleted = $skillName })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 400
                    }
                    continue
                }
            }

            # Intercept memories read/write API endpoints
            if ($urlPath -eq "/api/memories") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                
                $memPath = Join-Path $scriptDir "memories.json"
                
                if ($request.HttpMethod -eq "GET") {
                    $memJson = '{"nodes":[{"id":"user","label":"User","type":"person","description":"The user (you)"},{"id":"shadow","label":"Shadow","type":"ai","description":"Shadow, your AI companion"}],"links":[{"source":"shadow","target":"user","type":"COMPANION_OF"}]}'
                    if (Test-Path $memPath) {
                        $rawMemJson = Get-Content $memPath -Raw -Encoding UTF8
                        if (-not [string]::IsNullOrWhiteSpace($rawMemJson)) {
                            $memJson = $rawMemJson
                        }
                    }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes($memJson)
                    Add-ShadowCorsOrigin $response
                    $response.ContentType = "application/json; charset=utf-8"
                    $response.ContentLength64 = $resBytes.Length
                    $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    $response.Close()
                    continue
                }
                
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                        $body = $reader.ReadToEnd()
                        $reader.Close()
                        if ([string]::IsNullOrWhiteSpace($body)) {
                            $body = '{"nodes":[{"id":"user","label":"User","type":"person","description":"The user (you)"},{"id":"shadow","label":"Shadow","type":"ai","description":"Shadow, your AI companion"}],"links":[{"source":"shadow","target":"user","type":"COMPANION_OF"}]}'
                        }
                        # Guard against bloat: size cap (2 MB) is sufficient since memories.json is a flat node/link graph
                        $MAX_MEMORIES_BODY_BYTES = 2097152  # 2 MB
                        $MAX_MEMORY_NODES = 1000
                        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
                        if ($bodyBytes.Length -gt $MAX_MEMORIES_BODY_BYTES) {
                            Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = "Memory graph exceeds maximum size of 2 MB. Rejecting write to prevent bloat attacks." }) 413
                            continue
                        }
                        try {
                            $parsed = $body | ConvertFrom-Json
                            if (-not $parsed.nodes -or -not ($parsed.nodes -is [array])) {
                                throw "Invalid memory graph: missing 'nodes' array."
                            }
                            if (-not $parsed.links -or -not ($parsed.links -is [array])) {
                                throw "Invalid memory graph: missing 'links' array."
                            }
                            if ($parsed.nodes.Count -gt $MAX_MEMORY_NODES) {
                                throw "Memory graph has $($parsed.nodes.Count) nodes, maximum allowed is $MAX_MEMORY_NODES."
                            }
                            # Re-encode as clean UTF-8 to fix any double-encoding corruption from PowerShell file writes
                            $body = [System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::UTF8.GetBytes($body))
                        } catch {
                            Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = "Invalid JSON or memory graph structure: $($_.Exception.Message)" }) 400
                            continue
                        }
                        [System.IO.File]::WriteAllText($memPath, $body, [System.Text.Encoding]::UTF8)
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success"; message = "Memory graph saved." })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 500
                    }
                    continue
                }
            }

            # OpenAI Codex OAuth endpoints for subagent model access
            if ($urlPath -eq "/api/codex/status") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "GET") {
                    Write-ShadowJsonResponse $response (Get-ShadowCodexAuthStatus)
                    continue
                }
            }

            if ($urlPath -eq "/api/codex/login") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "POST") {
                    try {
                        $loginScript = Ensure-ShadowCodexLoginScript
                        $authPath = Get-ShadowCodexAuthPath
                        Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $loginScript, "-AuthPath", $authPath) -WindowStyle Hidden | Out-Null
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "success"
                            message = "Codex OAuth login opened in your browser. Complete the flow there, then return to Shadow."
                        })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 500
                    }
                    continue
                }
            }

            if ($urlPath -eq "/api/codex/logout") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "POST") {
                    $warnings = @()
                    try {
                        try {
                            $logoutResult = Invoke-ShadowCodexCommand -Arguments "logout" -TimeoutMilliseconds 15000
                            if ($logoutResult.exitCode -ne 0 -and -not [string]::IsNullOrWhiteSpace($logoutResult.output)) {
                                $warnings += $logoutResult.output
                            }
                        } catch {
                            $warnings += "Codex CLI logout command failed: $($_.Exception.Message)"
                        }

                        $authPath = Get-ShadowCodexAuthPath
                        if (Test-Path $authPath -PathType Leaf) {
                            Remove-Item -LiteralPath $authPath -Force -ErrorAction Stop
                        }

                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "success"
                            warnings = $warnings
                            message = "Codex local auth cache was cleared."
                        })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message; warnings = $warnings }) 500
                    }
                    continue
                }
            }

            if ($urlPath -eq "/api/codex/responses") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "POST") {
                    $requestId = ""
                    $requestTimeoutMs = 180000
                    $webReq = $null
                    $webResp = $null
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $body = $reader.ReadToEnd()
                        $codexReq = $body | ConvertFrom-Json
                        $requestId = Normalize-ShadowRequestId ([string]$codexReq.request_id)
                        $requestTimeoutMs = Get-ShadowProxyTimeoutMilliseconds -JsonBody $codexReq -DefaultTimeoutMilliseconds 180000
                        $targetBody = $codexReq.body
                        $modelName = [string]$targetBody.model
                        if (@("gpt-5.5", "gpt-5.4") -notcontains $modelName) {
                            throw "Unsupported Codex subagent model '$modelName'. Allowed: gpt-5.5, gpt-5.4."
                        }

                        $targetJson = $targetBody | ConvertTo-Json -Depth 30 -Compress
                        $webReq = [System.Net.HttpWebRequest]::Create("https://chatgpt.com/backend-api/codex/responses")
                        $webReq.Method = "POST"
                        $webReq.ContentType = "application/json"
                        $webReq.Accept = "text/event-stream"
                        $webReq.Timeout = $requestTimeoutMs
                        $webReq.ReadWriteTimeout = $requestTimeoutMs
                        $webReq.Headers.Add("Authorization", "Bearer $(Get-ShadowCodexBearerToken)")
                        $webReq.Headers.Add("OpenAI-Beta", "responses_websockets=2026-02-06")

                        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($targetJson)
                        $webReq.ContentLength = $bodyBytes.Length
                        $reqStream = $webReq.GetRequestStream()
                        $reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
                        $reqStream.Close()

                        $webResp = Get-ShadowHttpWebResponseWithCancellation -WebRequest $webReq -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId
                        $respBody = Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $webResp -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId

                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes($respBody)
                        Add-ShadowCorsOrigin $response
                        $response.ContentType = "text/event-stream; charset=utf-8"
                        $response.ContentLength64 = $resBytes.Length
                        $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    } catch {
                        $errMsg = $_.Exception.Message
                        $statusCode = 500
                        $errBody = ""
                        $cancelled = ($errMsg -match 'Request cancelled by user')
                        if ($cancelled) { $statusCode = 499 }
                        if ($_.Exception.InnerException -and $_.Exception.InnerException -is [System.Net.WebException]) {
                            $webEx = $_.Exception.InnerException
                            if ($webEx.Response) {
                                $statusCode = [int]$webEx.Response.StatusCode
                                try {
                                    $errBody = Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $webEx.Response -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId
                                    $webEx.Response.Close()
                                } catch {}
                            }
                        } elseif ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
                            $statusCode = [int]$_.Exception.Response.StatusCode
                            try {
                                $errBody = Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $_.Exception.Response -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId
                                $_.Exception.Response.Close()
                            } catch {}
                        }
                        $errJson = @{ error = $errMsg; status = $statusCode; body = $errBody; cancelled = $cancelled; request_id = $requestId } | ConvertTo-Json -Compress
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes($errJson)
                        Add-ShadowCorsOrigin $response
                        $response.StatusCode = $statusCode
                        $response.ContentType = "application/json; charset=utf-8"
                        $response.ContentLength64 = $resBytes.Length
                        $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    } finally {
                        if ($webResp) { try { $webResp.Close() } catch {} }
                        Clear-ShadowRequestCancellation $requestId
                    }
                    $response.Close()
                    continue
                }
            }

            # List models available in a local LM Studio server (OpenAI-style /v1/models) for the
            # subagent model picker. Server-side GET so the browser never deals with CORS.
            # Fetch models from ANY OpenAI-compatible endpoint (llama.cpp, vLLM, remote gateways)
            # for the custom-provider model picker. Allows http/https (user-entered on their own
            # machine) and forwards an optional API key.
            if ($urlPath -eq "/api/openai-compat/models") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "GET") {
                    $coEndpoint = $request.QueryString["endpoint"]
                    if ([string]::IsNullOrWhiteSpace($coEndpoint)) {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; models = @(); error = "No endpoint provided." }) 400
                        continue
                    }
                    $coEndpoint = $coEndpoint.TrimEnd('/')
                    $coSchemeOk = $false
                    try {
                        $parsedEndpoint = [System.Uri]$coEndpoint
                        if ($parsedEndpoint.Scheme -eq 'http' -or $parsedEndpoint.Scheme -eq 'https') { $coSchemeOk = $true }
                    } catch {}
                    if (-not $coSchemeOk) {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; models = @(); error = "Endpoint must be an http(s) URL, e.g. http://localhost:8080/v1." }) 400
                        continue
                    }
                    $coKey = $request.QueryString["key"]
                    try {
                        $coHeaders = @{}
                        if (-not [string]::IsNullOrWhiteSpace($coKey)) { $coHeaders["Authorization"] = "Bearer $coKey" }
                        $coModels = Invoke-RestMethod -Uri "$coEndpoint/models" -Method GET -Headers $coHeaders -TimeoutSec 6
                        $coIds = @()
                        if ($coModels -and $coModels.data) {
                            $coIds = @($coModels.data | ForEach-Object { $_.id } | Where-Object { $_ })
                        }
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success"; endpoint = $coEndpoint; models = $coIds }) 200
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; endpoint = $coEndpoint; models = @(); error = "Could not fetch models from $coEndpoint/models. Your server may not expose /models - you can type the model name manually." }) 502
                    }
                    continue
                }
                Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = "Method not allowed" }) 405
                continue
            }

            # Update check: compare the installed version to the latest GitHub release.
            # Returns 200 even on failure (with status=error) so the UI can silently skip
            # the check when offline rather than surfacing an error to the user.
            if ($urlPath -eq "/api/update-check") {
                if ($request.HttpMethod -ne "GET") {
                    Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = "Method not allowed" }) 405
                    continue
                }
                $currentVersion = ""
                try {
                    $pkgPath = Join-Path $scriptDir "package.json"
                    if (Test-Path $pkgPath) {
                        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
                        if ($pkg -and $pkg.version) { $currentVersion = [string]$pkg.version }
                    }
                } catch {}
                try {
                    $ghHeaders = @{ "User-Agent" = "ShadowAI-UpdateCheck"; "Accept" = "application/vnd.github+json" }
                    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/shadowdoggie/shadow-ai/releases/latest" -Method GET -Headers $ghHeaders -TimeoutSec 8
                    $latestTag = ""
                    if ($rel -and $rel.tag_name) { $latestTag = [string]$rel.tag_name }
                    $releaseUrl = ""
                    if ($rel -and $rel.html_url) { $releaseUrl = [string]$rel.html_url }
                    $releaseName = ""
                    if ($rel -and $rel.name) { $releaseName = [string]$rel.name }
                    # Prefer the installer asset's direct download URL when present.
                    $assetUrl = ""
                    if ($rel -and $rel.assets) {
                        $exeAsset = $rel.assets | Where-Object { $_.name -and $_.name -like "*.exe" } | Select-Object -First 1
                        if ($exeAsset -and $exeAsset.browser_download_url) { $assetUrl = [string]$exeAsset.browser_download_url }
                    }
                    $updateAvailable = $false
                    $curV = $null; $latV = $null
                    $curClean = ($currentVersion -replace '^[vV]', '')
                    $latClean = ($latestTag -replace '^[vV]', '')
                    if ([version]::TryParse($curClean, [ref]$curV) -and [version]::TryParse($latClean, [ref]$latV)) {
                        $updateAvailable = ($latV -gt $curV)
                    }
                    Write-ShadowJsonResponse $response ([PSCustomObject]@{
                        status = "success"
                        current = $currentVersion
                        latest = $latestTag
                        update_available = $updateAvailable
                        release_url = $releaseUrl
                        release_name = $releaseName
                        download_url = $assetUrl
                    }) 200
                } catch {
                    Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; current = $currentVersion; update_available = $false; error = "Could not reach GitHub to check for updates." }) 200
                }
                continue
            }

            # Proxy endpoint for third-party AI API calls (bypasses CORS)
            if ($urlPath -eq "/api/proxy") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }

                if ($request.HttpMethod -eq "POST") {
                    $requestId = ""
                    $requestTimeoutMs = 120000
                    $webReq = $null
                    $webResp = $null
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $body = $reader.ReadToEnd()
                        $proxyReq = $body | ConvertFrom-Json
                        $requestId = Normalize-ShadowRequestId ([string]$proxyReq.request_id)
                        $requestTimeoutMs = Get-ShadowProxyTimeoutMilliseconds -JsonBody $proxyReq -DefaultTimeoutMilliseconds 120000

                        $targetUrl = $proxyReq.url
                        $targetHeaders = @{}
                        if ($proxyReq.headers) {
                            $proxyReq.headers.PSObject.Properties | ForEach-Object {
                                $targetHeaders[$_.Name] = $_.Value
                            }
                        }
                        $targetBody = $proxyReq.body | ConvertTo-Json -Depth 20 -Compress

                        $webReq = [System.Net.HttpWebRequest]::Create($targetUrl)
                        $webReq.Method = "POST"
                        $webReq.ContentType = "application/json"
                        $webReq.Timeout = $requestTimeoutMs
                        $webReq.ReadWriteTimeout = $requestTimeoutMs
                        foreach ($h in $targetHeaders.GetEnumerator()) {
                            if ($h.Key -eq "Authorization") {
                                $webReq.Headers.Add("Authorization", $h.Value)
                            }
                        }

                        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($targetBody)
                        $webReq.ContentLength = $bodyBytes.Length
                        $reqStream = $webReq.GetRequestStream()
                        $reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
                        $reqStream.Close()

                        $webResp = Get-ShadowHttpWebResponseWithCancellation -WebRequest $webReq -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId
                        $respBody = Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $webResp -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId

                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes($respBody)
                        Add-ShadowCorsOrigin $response
                        $response.ContentType = "application/json; charset=utf-8"
                        $response.ContentLength64 = $resBytes.Length
                        $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    } catch {
                        $errMsg = $_.Exception.Message
                        $statusCode = 500
                        $errBody = ""
                        $cancelled = ($errMsg -match 'Request cancelled by user')
                        if ($cancelled) { $statusCode = 499 }
                        if ($_.Exception.InnerException -and $_.Exception.InnerException -is [System.Net.WebException]) {
                            $webEx = $_.Exception.InnerException
                            if ($webEx.Response) {
                                $statusCode = [int]$webEx.Response.StatusCode
                                try {
                                    $errBody = Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $webEx.Response -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId
                                    $webEx.Response.Close()
                                } catch {}
                            }
                        } elseif ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
                            $statusCode = [int]$_.Exception.Response.StatusCode
                            try {
                                $errBody = Read-ShadowResponseBodyWithCancellation -WebRequest $webReq -WebResponse $_.Exception.Response -TimeoutMilliseconds $requestTimeoutMs -RequestId $requestId
                                $_.Exception.Response.Close()
                            } catch {}
                        }
                        $errJson = @{ error = $errMsg; status = $statusCode; body = $errBody; cancelled = $cancelled; request_id = $requestId } | ConvertTo-Json -Compress
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes($errJson)
                        Add-ShadowCorsOrigin $response
                        $response.StatusCode = $statusCode
                        $response.ContentType = "application/json; charset=utf-8"
                        $response.ContentLength64 = $resBytes.Length
                        $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
                    } finally {
                        if ($webResp) { try { $webResp.Close() } catch {} }
                        Clear-ShadowRequestCancellation $requestId
                    }
                    $response.Close()
                    continue
                }
            }

            # Google Workspace Integration Endpoints
            $credentialsPath = Get-ShadowPrivatePath "google_credentials.json"
            $tokensPath = Get-ShadowPrivatePath "google_tokens.json"

            if ($urlPath -eq "/api/google/set-credentials") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $body = $reader.ReadToEnd()
                        $credObj = $body | ConvertFrom-Json
                        
                        $clientId = ""
                        $clientSecret = ""
                        if ($credObj.web) {
                            $clientId = $credObj.web.client_id
                            $clientSecret = $credObj.web.client_secret
                        } elseif ($credObj.installed) {
                            $clientId = $credObj.installed.client_id
                            $clientSecret = $credObj.installed.client_secret
                        } else {
                            $clientId = $credObj.client_id
                            $clientSecret = $credObj.client_secret
                        }

                        if ([string]::IsNullOrEmpty($clientId) -or [string]::IsNullOrEmpty($clientSecret)) {
                            throw "Client ID and Client Secret are required."
                        }
                        if ($clientId -match "placeholder" -or $clientSecret -match "placeholder" -or $clientId -notmatch "\.apps\.googleusercontent\.com$") {
                            throw "A valid Google OAuth client id and client secret are required."
                        }

                        $saveObj = @{ client_id = $clientId; client_secret = $clientSecret }
                        [System.IO.File]::WriteAllText($credentialsPath, ($saveObj | ConvertTo-Json -Compress))
                        
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "success"; message = "Google Credentials saved." })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 500
                    }
                    continue
                }
            }

            if ($urlPath -eq "/api/google/auth-url") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "GET") {
                    try {
                        $googleCreds = Get-ShadowGoogleCredentials
                        if (-not $googleCreds.configured) {
                            Write-ShadowJsonResponse $response ([PSCustomObject]@{
                                status = "error"
                                error = $googleCreds.error
                                credentialsConfigured = $false
                                redirectUri = (Get-ShadowGoogleRedirectUri)
                            }) 400
                            continue
                        }
                        
                        $scopeProfile = [string]$request.QueryString["profile"]
                        if ([string]::IsNullOrWhiteSpace($scopeProfile)) { $scopeProfile = "workspace" }

                        $workspaceScopes = @(
                            "https://www.googleapis.com/auth/gmail.modify",
                            "https://www.googleapis.com/auth/calendar",
                            "https://www.googleapis.com/auth/drive",
                            "https://www.googleapis.com/auth/documents",
                            "https://www.googleapis.com/auth/spreadsheets",
                            "https://www.googleapis.com/auth/youtube",
                            "https://www.googleapis.com/auth/contacts.readonly"
                        )
                        $contactsScopes = @(
                            "https://www.googleapis.com/auth/contacts.readonly"
                        )
                        $photosScopes = @(
                            "https://www.googleapis.com/auth/photoslibrary.appendonly",
                            "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
                            "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata"
                        )

                        $selectedScopes = $workspaceScopes
                        if ($scopeProfile -eq "contacts") {
                            $selectedScopes = $contactsScopes
                        } elseif ($scopeProfile -eq "photos") {
                            $selectedScopes = $photosScopes
                        } elseif ($scopeProfile -eq "all") {
                            $selectedScopes = @($workspaceScopes + $photosScopes) | Select-Object -Unique
                        }

                        $clientId = [Uri]::EscapeDataString($googleCreds.client_id)
                        $redirectUri = [Uri]::EscapeDataString((Get-ShadowGoogleRedirectUri))
                        $scopes = [Uri]::EscapeDataString(($selectedScopes -join " "))
                        
                        $authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=$clientId&redirect_uri=$redirectUri&response_type=code&scope=$scopes&access_type=offline&prompt=consent&include_granted_scopes=true"
                        
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "success"
                            url = $authUrl
                            profile = $scopeProfile
                            scopes = $selectedScopes
                        })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 500
                    }
                    continue
                }
            }

            if ($urlPath -eq "/oauth2callback") {
                try {
                    $callbackError = $request.QueryString["error"]
                    if (-not [string]::IsNullOrEmpty($callbackError)) {
                        $callbackDescription = $request.QueryString["error_description"]
                        if ([string]::IsNullOrEmpty($callbackDescription)) { $callbackDescription = $callbackError }
                        throw "Google authorization failed: $callbackDescription"
                    }

                    $code = $request.QueryString["code"]
                    if ([string]::IsNullOrEmpty($code)) {
                        throw "Authorization code not provided in callback."
                    }

                    $googleCreds = Get-ShadowGoogleCredentials
                    if (-not $googleCreds.configured) {
                        throw $googleCreds.error
                    }

                    $tokenBody = "code=" + [Uri]::EscapeDataString($code) +
                                 "&client_id=" + [Uri]::EscapeDataString($googleCreds.client_id) +
                                 "&client_secret=" + [Uri]::EscapeDataString($googleCreds.client_secret) +
                                 "&redirect_uri=" + [Uri]::EscapeDataString((Get-ShadowGoogleRedirectUri)) +
                                 "&grant_type=authorization_code"
                    $formBytes = [System.Text.Encoding]::UTF8.GetBytes($tokenBody)

                    $tokenReq = [System.Net.HttpWebRequest]::Create("https://oauth2.googleapis.com/token")
                    $tokenReq.Method = "POST"
                    $tokenReq.ContentType = "application/x-www-form-urlencoded"
                    $tokenReq.Timeout = 15000
                    $tokenReq.ReadWriteTimeout = 15000
                    $tokenReq.ContentLength = $formBytes.Length
                    
                    $reqStream = $tokenReq.GetRequestStream()
                    $reqStream.Write($formBytes, 0, $formBytes.Length)
                    $reqStream.Close()

                    $tokenResp = $tokenReq.GetResponse()
                    $respStream = $tokenResp.GetResponseStream()
                    $respReader = New-Object System.IO.StreamReader($respStream)
                    $respBody = $respReader.ReadToEnd()
                    $respReader.Close()
                    $tokenResp.Close()

                    $tokens = $respBody | ConvertFrom-Json
                    
                    $expiresIn = 3600
                    if ($tokens.expires_in) {
                        $expiresIn = [int]$tokens.expires_in
                    }
                    
                    $expiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $expiresIn
                    
                    $saveTokens = @{
                        access_token = $tokens.access_token
                        refresh_token = $tokens.refresh_token
                        expires_at = $expiresAt
                        scope = $tokens.scope
                    }
                    
                    if ([string]::IsNullOrEmpty($tokens.refresh_token) -and (Test-Path $tokensPath)) {
                        try {
                            $oldTokens = Get-Content $tokensPath -Raw | ConvertFrom-Json
                            if ($oldTokens.refresh_token) {
                                $saveTokens.refresh_token = $oldTokens.refresh_token
                            }
                            if ([string]::IsNullOrEmpty($saveTokens.scope) -and $oldTokens.scope) {
                                $saveTokens.scope = $oldTokens.scope
                            }
                        } catch {}
                    }

                    [System.IO.File]::WriteAllText($tokensPath, ($saveTokens | ConvertTo-Json -Compress))

                    $html = @"
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Connection Successful - Shadow AI</title>
    <style>
        body {
            font-family: 'Outfit', 'Inter', sans-serif;
            background: linear-gradient(135deg, #0f0807 0%, #170d0c 100%);
            color: #f5ebea;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            overflow: hidden;
        }
        .container {
            background: rgba(22, 14, 13, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.08);
            backdrop-filter: blur(20px);
            padding: 3rem;
            border-radius: 28px;
            text-align: center;
            max-width: 480px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.4);
            animation: fadeIn 0.8s ease-out;
        }
        h1 {
            color: #f75c4c;
            margin-top: 0;
            font-weight: 600;
            letter-spacing: -0.02em;
        }
        p {
            color: rgba(245, 235, 230, 0.7);
            line-height: 1.6;
            margin-bottom: 2rem;
        }
        .success-icon {
            width: 80px;
            height: 80px;
            background: rgba(247, 92, 76, 0.1);
            color: #f75c4c;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem;
            font-size: 2.5rem;
        }
        .btn {
            background: #f75c4c;
            color: white;
            border: none;
            padding: 12px 28px;
            font-size: 1rem;
            font-weight: 500;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            display: inline-block;
        }
        .btn:hover {
            background: #e04b3b;
            transform: translateY(-1px);
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(15px); }
            to { opacity: 1; transform: translateY(0); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✓</div>
        <h1>Connection Successful!</h1>
        <p>Shadow AI is now connected to your Google account. You can close this window and return to the main interface to start using Gmail, Calendar, and Drive tools.</p>
        <button class="btn" onclick="window.close()">Close Window</button>
    </div>
</body>
</html>
"@
                    $htmlBytes = [System.Text.Encoding]::UTF8.GetBytes($html)
                    $response.ContentType = "text/html; charset=utf-8"
                    $response.ContentLength64 = $htmlBytes.Length
                    $response.OutputStream.Write($htmlBytes, 0, $htmlBytes.Length)
                } catch {
                    $errMsg = $_.Exception.Message
                    $errHtml = "<html><body><h2>Authentication Failed</h2><p>$errMsg</p></body></html>"
                    $htmlBytes = [System.Text.Encoding]::UTF8.GetBytes($errHtml)
                    $response.StatusCode = 500
                    $response.ContentType = "text/html; charset=utf-8"
                    $response.ContentLength64 = $htmlBytes.Length
                    $response.OutputStream.Write($htmlBytes, 0, $htmlBytes.Length)
                }
                $response.Close()
                continue
            }

            if ($urlPath -eq "/api/google/status") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "GET") {
                    $googleCreds = Get-ShadowGoogleCredentials
                    $connected = Test-Path $tokensPath
                    Write-ShadowJsonResponse $response ([PSCustomObject]@{
                        status = "success"
                        credentialsConfigured = [bool]$googleCreds.configured
                        credentialsError = $googleCreds.error
                        credentialsSource = $googleCreds.source
                        clientType = $googleCreds.client_type
                        redirectUri = (Get-ShadowGoogleRedirectUri)
                        connected = $connected
                        tokenScopes = $(if ($connected) {
                            try {
                                $existingTokens = Get-Content $tokensPath -Raw | ConvertFrom-Json
                                [string]$existingTokens.scope
                            } catch { "" }
                        } else { "" })
                    })
                    continue
                }
            }

            if ($urlPath -eq "/api/google/disconnect") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST" -or $request.HttpMethod -eq "GET") {
                    if (Test-Path $tokensPath) {
                        Remove-Item $tokensPath -Force
                    }
                    Write-ShadowJsonResponse $response ([PSCustomObject]@{
                        status = "success"
                        message = "Disconnected from Google."
                    })
                    continue
                }
            }

            if ($urlPath -eq "/api/google/upload-local-file") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "POST, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "POST") {
                    $fileStream = $null
                    $httpClient = $null
                    $multipart = $null
                    $cts = $null
                    $requestId = ""
                    try {
                        $reader = New-Object System.IO.StreamReader($request.InputStream)
                        $body = $reader.ReadToEnd()
                        $argsObj = $body | ConvertFrom-Json
                        $requestId = Normalize-ShadowRequestId ([string]$argsObj.request_id)
                        $uploadTimeoutMs = Get-ShadowGoogleUploadTimeoutMilliseconds -JsonBody $argsObj

                        $uploadPath = [string]$argsObj.path
                        if ([string]::IsNullOrWhiteSpace($uploadPath)) {
                            throw "Missing local file path."
                        }

                        # Resolve the file. The path often comes from a spoken filename and may
                        # not match exactly (case/spacing/extension), so fall back to a fuzzy
                        # match in the requested folder (or the Desktop) instead of failing.
                        $fullPath = $null
                        if (Test-Path -LiteralPath $uploadPath -PathType Leaf) {
                            $fullPath = (Resolve-Path -LiteralPath $uploadPath).Path
                        } else {
                            $reqDir = Split-Path -Parent $uploadPath
                            if ([string]::IsNullOrWhiteSpace($reqDir) -or -not (Test-Path -LiteralPath $reqDir -PathType Container)) {
                                $reqDir = [Environment]::GetFolderPath('Desktop')
                            }
                            $reqName = Split-Path -Leaf $uploadPath
                            $reqStem = ([System.IO.Path]::GetFileNameWithoutExtension($reqName).ToLower() -replace '[^a-z0-9]', '')
                            $allFiles = @(Get-ChildItem -LiteralPath $reqDir -File -ErrorAction SilentlyContinue)
                            $exact = $allFiles | Where-Object { $_.Name -ieq $reqName } | Select-Object -First 1
                            if ($exact) {
                                $fullPath = $exact.FullName
                            } else {
                                $scored = $allFiles | ForEach-Object {
                                    $stem = ([System.IO.Path]::GetFileNameWithoutExtension($_.Name).ToLower() -replace '[^a-z0-9]', '')
                                    $score = 0
                                    if ($reqStem -and $stem -eq $reqStem) { $score = 100 }
                                    elseif ($reqStem -and ($stem.Contains($reqStem) -or $reqStem.Contains($stem))) { $score = 50 }
                                    [PSCustomObject]@{ File = $_; Score = $score }
                                } | Where-Object { $_.Score -gt 0 } | Sort-Object Score -Descending
                                if (@($scored).Count -ge 1) {
                                    $fullPath = $scored[0].File.FullName
                                } else {
                                    $sample = (($allFiles | Select-Object -First 15 | ForEach-Object { $_.Name }) -join ', ')
                                    throw "No file matching '$reqName' was found in $reqDir. Files there: $sample. Call list_directory to pick the exact file name."
                                }
                            }
                        }

                        $fileName = [string]$argsObj.filename
                        if ([string]::IsNullOrWhiteSpace($fileName)) {
                            $fileName = [System.IO.Path]::GetFileName($fullPath)
                        }
                        $mimeType = Get-ShadowMimeType $fullPath ([string]$argsObj.mime_type)
                        $accessToken = Get-ShadowGoogleAccessToken

                        Add-Type -AssemblyName System.Net.Http
                        $metadata = @{
                            name = $fileName
                        }
                        if (-not [string]::IsNullOrWhiteSpace([string]$argsObj.parent_id)) {
                            $metadata.parents = @([string]$argsObj.parent_id)
                        }
                        $metadataJson = $metadata | ConvertTo-Json -Compress

                        $boundary = "shadow_ai_drive_upload_" + [Guid]::NewGuid().ToString("N")
                        $multipart = New-Object System.Net.Http.MultipartContent("related", $boundary)

                        $metadataContent = New-Object System.Net.Http.StringContent($metadataJson, [System.Text.Encoding]::UTF8, "application/json")
                        $multipart.Add($metadataContent)

                        $fileStream = [System.IO.File]::OpenRead($fullPath)
                        $fileContent = New-Object System.Net.Http.StreamContent($fileStream)
                        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($mimeType)
                        $multipart.Add($fileContent)

                        $httpClient = New-Object System.Net.Http.HttpClient
                        $httpClient.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
                        $httpClient.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", $accessToken)
                        $cts = New-Object System.Threading.CancellationTokenSource

                        $uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,parents,webViewLink,size"
                        $startedAt = [DateTime]::UtcNow
                        $uploadTask = $httpClient.PostAsync($uploadUrl, $multipart, $cts.Token)
                        while (-not $uploadTask.Wait(250)) {
                            if (Test-ShadowRequestCancellation $requestId) {
                                $cts.Cancel()
                                $httpClient.CancelPendingRequests()
                                throw "Request cancelled by user."
                            }
                            if (([DateTime]::UtcNow - $startedAt).TotalMilliseconds -ge $uploadTimeoutMs) {
                                $cts.Cancel()
                                $httpClient.CancelPendingRequests()
                                throw "Google Drive upload timed out after $([Math]::Round($uploadTimeoutMs / 1000))s."
                            }
                        }
                        $uploadResp = $uploadTask.Result
                        $readTask = $uploadResp.Content.ReadAsStringAsync()
                        while (-not $readTask.Wait(250)) {
                            if (Test-ShadowRequestCancellation $requestId) {
                                $cts.Cancel()
                                $httpClient.CancelPendingRequests()
                                throw "Request cancelled by user."
                            }
                            if (([DateTime]::UtcNow - $startedAt).TotalMilliseconds -ge $uploadTimeoutMs) {
                                $cts.Cancel()
                                $httpClient.CancelPendingRequests()
                                throw "Google Drive upload response timed out after $([Math]::Round($uploadTimeoutMs / 1000))s."
                            }
                        }
                        $uploadBody = $readTask.Result
                        if (-not $uploadResp.IsSuccessStatusCode) {
                            throw "Google Drive upload failed ($([int]$uploadResp.StatusCode)): $uploadBody"
                        }

                        $driveFile = $uploadBody | ConvertFrom-Json
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "success"
                            file = $driveFile
                            localPath = $fullPath
                            bytes = (Get-Item -LiteralPath $fullPath).Length
                            request_id = $requestId
                        })
                    } catch {
                        $errMsg = $_.Exception.Message
                        $cancelled = ($errMsg -match 'Request cancelled by user')
                        $timedOut = ($errMsg -match 'timed out')
                        $statusCode = if ($cancelled) { 499 } else { 500 }
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "error"
                            error = $errMsg
                            cancelled = $cancelled
                            timedOut = $timedOut
                            request_id = $requestId
                        }) $statusCode
                    } finally {
                        Clear-ShadowRequestCancellation $requestId
                        if ($cts) { $cts.Dispose() }
                        if ($multipart) { $multipart.Dispose() }
                        if ($fileStream) { $fileStream.Dispose() }
                        if ($httpClient) { $httpClient.Dispose() }
                    }
                    continue
                }
            }

            if ($urlPath -eq "/api/google/token") {
                if ($request.HttpMethod -eq "OPTIONS") {
                    Add-ShadowCorsOrigin $response
                    $response.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
                    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
                    $response.StatusCode = 200
                    $response.Close()
                    continue
                }
                if ($request.HttpMethod -eq "GET") {
                    try {
                        if (-not (Test-Path $tokensPath)) {
                            throw "Google integration is not connected."
                        }
                        $tokens = Get-Content $tokensPath -Raw | ConvertFrom-Json
                        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
                        
                        if (($tokens.expires_at - $now) -lt 300) {
                            if ([string]::IsNullOrEmpty($tokens.refresh_token)) {
                                throw "Access token expired and no refresh token is available. Please reconnect."
                            }
                            $googleCreds = Get-ShadowGoogleCredentials
                            if (-not $googleCreds.configured) {
                                throw "Credentials config is missing or invalid, cannot refresh token. $($googleCreds.error)"
                            }
                            
                            $formBody = "client_id=" + [Uri]::EscapeDataString($googleCreds.client_id) +
                                        "&client_secret=" + [Uri]::EscapeDataString($googleCreds.client_secret) +
                                        "&refresh_token=" + [Uri]::EscapeDataString($tokens.refresh_token) +
                                        "&grant_type=refresh_token"
                            $formBytes = [System.Text.Encoding]::UTF8.GetBytes($formBody)

                            $tokenReq = [System.Net.HttpWebRequest]::Create("https://oauth2.googleapis.com/token")
                            $tokenReq.Method = "POST"
                            $tokenReq.ContentType = "application/x-www-form-urlencoded"
                            $tokenReq.Timeout = 15000
                            $tokenReq.ReadWriteTimeout = 15000
                            $tokenReq.ContentLength = $formBytes.Length
                            
                            $reqStream = $tokenReq.GetRequestStream()
                            $reqStream.Write($formBytes, 0, $formBytes.Length)
                            $reqStream.Close()

                            $tokenResp = $tokenReq.GetResponse()
                            $respStream = $tokenResp.GetResponseStream()
                            $respReader = New-Object System.IO.StreamReader($respStream)
                            $respBody = $respReader.ReadToEnd()
                            $respReader.Close()
                            $tokenResp.Close()

                            $refreshed = $respBody | ConvertFrom-Json
                            
                            $expiresIn = 3600
                            if ($refreshed.expires_in) {
                                $expiresIn = [int]$refreshed.expires_in
                            }
                            $newExpiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $expiresIn
                            
                            $tokens.access_token = $refreshed.access_token
                            $tokens.expires_at = $newExpiresAt
                            if (-not [string]::IsNullOrEmpty($refreshed.refresh_token)) {
                                $tokens.refresh_token = $refreshed.refresh_token
                            }
                            
                            [System.IO.File]::WriteAllText($tokensPath, ($tokens | ConvertTo-Json -Compress))
                        }
                        
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{
                            status = "success"
                            access_token = $tokens.access_token
                        })
                    } catch {
                        Write-ShadowJsonResponse $response ([PSCustomObject]@{ status = "error"; error = $_.Exception.Message }) 500
                    }
                    continue
                }
            }

            # Sanitize path to prevent directory traversal
            $cleanPath = $urlPath.Replace("/", [System.IO.Path]::DirectorySeparatorChar)
            if ($cleanPath.StartsWith([System.IO.Path]::DirectorySeparatorChar)) {
                $cleanPath = $cleanPath.Substring(1)
            }
            $filePath = Join-Path "$scriptDir\src" $cleanPath
                
                if (Test-Path $filePath -PathType Leaf) {
                    $bytes = [System.IO.File]::ReadAllBytes($filePath)
                    $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                    $contentType = switch ($ext) {
                        ".html" { "text/html; charset=utf-8" }
                        ".css" { "text/css" }
                        ".js" { "application/javascript" }
                        ".svg" { "image/svg+xml" }
                        default { "application/octet-stream" }
                    }
                    $response.ContentType = $contentType
                    $response.Headers.Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                    $response.Headers.Set("Pragma", "no-cache")
                    $response.Headers.Set("Expires", "0")
                    $response.ContentLength64 = $bytes.Length
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $response.StatusCode = 404
                    $errBytes = [System.Text.Encoding]::UTF8.GetBytes("404 File Not Found: $urlPath")
                    $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
                }
                $response.Close()
            } catch {
                # Connection interrupted or closed
            }
        }
}

# --- Push-to-talk: global key state ---
# A dedicated runspace polls the OS-level state of the user's chosen push-to-talk key via
# GetAsyncKeyState (which reads the global async key state regardless of which window has focus)
# and bumps a sequence counter on every press/release edge. The /api/ptt/wait long-poll lets the
# UI learn of an edge in ~15-30ms so it can open/close the mic. We poll a SINGLE bound key, not a
# system-wide keyboard hook (WH_KEYBOARD_LL) — far lighter and far less keylogger-like, which
# matters for an unsigned installer. If Add-Type is blocked, PTT degrades to focused-window-only
# (the front-end keydown/keyup fallback) and 'supported' reports false.
$pttState = [hashtable]::Synchronized(@{
    run       = $true
    enabled   = $false
    vk        = 0
    held      = $false
    seq       = 0
    supported = $false
})
try {
    if (-not ([System.Management.Automation.PSTypeName]'ShadowPTT.Keys').Type) {
        Add-Type -Namespace 'ShadowPTT' -Name 'Keys' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern short GetAsyncKeyState(int vKey);
'@
    }
    $pttState.supported = $true
} catch {
    $pttState.supported = $false
}

if ($pttState.supported) {
    $pttPollScript = {
        $prevDown = $false
        $prevVk = 0
        while ($pttState.run) {
            try {
                $vk = [int]$pttState.vk
                if ($pttState.enabled -and $vk -gt 0) {
                    if ($vk -ne $prevVk) { $prevDown = $false; $prevVk = $vk }
                    $down = ([ShadowPTT.Keys]::GetAsyncKeyState($vk) -band 0x8000) -ne 0
                    if ($down -ne $prevDown) {
                        $prevDown = $down
                        $pttState.held = $down
                        $pttState.seq = [int]$pttState.seq + 1
                    }
                } else {
                    if ($pttState.held) {
                        $pttState.held = $false
                        $pttState.seq = [int]$pttState.seq + 1
                    }
                    $prevDown = $false
                    $prevVk = 0
                }
            } catch {}
            Start-Sleep -Milliseconds 8
        }
    }
    $pttSessionState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $pttSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("pttState", $pttState, "Push-to-talk shared state")))
    $pttRunspaceThread = [PowerShell]::Create($pttSessionState)
    $null = $pttRunspaceThread.AddScript($pttPollScript)
    $null = $pttRunspaceThread.BeginInvoke()
}

$powershellThreads = @()
for ($i = 0; $i -lt 8; $i++) {
    $threadSessionState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("listener", $listener, "The listener object")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("scriptDir", $scriptDir, "Path to script root")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("browserControllerPort", $browserControllerPort, "Browser controller port")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("port", $port, "Shadow web server port")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("serverStartedAt", $serverStartedAt, "Shadow server start time")))
    $threadSessionState.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("pttState", $pttState, "Push-to-talk shared state")))

    $thread = [PowerShell]::Create($threadSessionState)
    $null = $thread.AddScript($serverScript)
    $powershellThreads += $thread
    $null = $thread.BeginInvoke()
}

# Wait for server to start listening on target port
Write-Host "[Server] Waiting for port $port to accept connections..." -ForegroundColor DarkGray
$serverReady = $false
$maxAttempts = 50 # 5 seconds max wait
for ($i = 0; $i -lt $maxAttempts; $i++) {
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $tcp.Connect($hostAddress, $port)
        $serverReady = $true
        $tcp.Close()
        break
    } catch {
        Start-Sleep -Milliseconds 100
    } finally {
        if ($tcp) { $tcp.Dispose() }
    }
}

if ($serverReady) {
    Write-Host "[Server] Port active and ready." -ForegroundColor Green
} else {
    Write-Host "[Server] Warning: Port test timed out. Attempting to launch anyway..." -ForegroundColor Yellow
}

# 2. Locate a Chromium browser for app-window mode. Prefer Chrome; fall back to Edge,
#    which ships with Windows 11 so we get a real borderless app window (not a browser
#    tab) on essentially every machine. Detection uses the registry "App Paths" keys first
#    (absolute install paths that work regardless of the launching process's environment —
#    e.g. when the installer's post-install "launch now" runs run.ps1, %LocalAppData% /
#    %ProgramFiles% may not resolve the same as a desktop shortcut, which previously caused
#    a fall-through to a plain browser tab), then hardcoded path fallbacks.
$chromeCandidates = New-Object System.Collections.Generic.List[string]
foreach ($browserExe in @('chrome.exe', 'msedge.exe')) {
    foreach ($hive in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\'
    )) {
        try {
            $regVal = (Get-ItemProperty -Path ($hive + $browserExe) -ErrorAction SilentlyContinue).'(default)'
            if ($regVal) { $chromeCandidates.Add(($regVal -replace '"', '').Trim()) }
        } catch {}
    }
}
$chromeCandidates.AddRange([string[]]@(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
))
$chromePath = $null
foreach ($path in $chromeCandidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
        $chromePath = $path
        break
    }
}

$url = "http://$($hostAddress):$($port)/"

# 3. Launch App Window
if ($chromePath) {
    Write-Host "[App] Starting borderless app window ($([System.IO.Path]::GetFileName($chromePath)))..." -ForegroundColor Green
    $appProfileDir = Join-Path $scriptDir "runtime\profiles\shadow_app"
    if (-not (Test-Path $appProfileDir -PathType Container)) { New-Item -ItemType Directory -Path $appProfileDir -Force | Out-Null }
    # Disable the browser's "save / update password?" bubble in our dedicated app profile — the API-key
    # fields are password inputs, which would otherwise trigger it. Set it in the profile's Preferences
    # (merged so we keep window state etc.), written BOM-less so Chromium accepts it.
    try {
        $defDir = Join-Path $appProfileDir "Default"
        if (-not (Test-Path $defDir)) { New-Item -ItemType Directory -Path $defDir -Force | Out-Null }
        $prefPath = Join-Path $defDir "Preferences"
        $prefs = $null
        if (Test-Path $prefPath) { try { $prefs = Get-Content $prefPath -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $prefs = $null } }
        if ($null -eq $prefs) { $prefs = [PSCustomObject]@{} }
        $prefs | Add-Member -NotePropertyName credentials_enable_service -NotePropertyValue $false -Force
        $prefs | Add-Member -NotePropertyName credentials_enable_autosignin -NotePropertyValue $false -Force
        if (-not ($prefs.PSObject.Properties.Name -contains 'profile') -or $null -eq $prefs.profile) {
            $prefs | Add-Member -NotePropertyName profile -NotePropertyValue ([PSCustomObject]@{}) -Force
        }
        $prefs.profile | Add-Member -NotePropertyName password_manager_enabled -NotePropertyValue $false -Force
        $prefs.profile | Add-Member -NotePropertyName password_manager_leak_detection -NotePropertyValue $false -Force
        # Persistently grant microphone + camera permission for OUR app origin in OUR profile. This
        # makes getUserMedia never prompt (the borderless window has no UI to grant one) AND, because
        # the permission is "granted", enumerateDevices() exposes real device names so the Settings
        # mic picker can list them. Merged so any existing content settings are preserved.
        $allow = [PSCustomObject]@{ setting = 1 }
        $mkExc = {
            $e = [PSCustomObject]@{}
            $e | Add-Member -NotePropertyName "http://127.0.0.1:$port,*" -NotePropertyValue $allow -Force
            $e | Add-Member -NotePropertyName "http://localhost:$port,*" -NotePropertyValue $allow -Force
            $e
        }
        if (-not ($prefs.profile.PSObject.Properties.Name -contains 'content_settings') -or $null -eq $prefs.profile.content_settings) {
            $prefs.profile | Add-Member -NotePropertyName content_settings -NotePropertyValue ([PSCustomObject]@{}) -Force
        }
        if (-not ($prefs.profile.content_settings.PSObject.Properties.Name -contains 'exceptions') -or $null -eq $prefs.profile.content_settings.exceptions) {
            $prefs.profile.content_settings | Add-Member -NotePropertyName exceptions -NotePropertyValue ([PSCustomObject]@{}) -Force
        }
        $prefs.profile.content_settings.exceptions | Add-Member -NotePropertyName media_stream_mic -NotePropertyValue (& $mkExc) -Force
        $prefs.profile.content_settings.exceptions | Add-Member -NotePropertyName media_stream_camera -NotePropertyValue (& $mkExc) -Force
        [System.IO.File]::WriteAllText($prefPath, ($prefs | ConvertTo-Json -Depth 60), (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
    $chromeArgs = @(
        "--app=$url",
        "--window-size=960,800",
        "--user-data-dir=$appProfileDir",
        "--no-first-run",
        "--no-default-browser-check",
        # Auto-grant the mic in OUR borderless app window (no address bar to re-enable a denied prompt).
        # Scoped to this dedicated profile/origin only — never affects the user's normal browser.
        # NOTE: --use-fake-ui-for-media-stream was tried here but it prevents the --app window from
        # opening at all on current Chrome, so the mic permission is instead pre-granted persistently
        # in the profile Preferences (content_settings.media_stream_mic) below.
        "--auto-accept-camera-and-microphone-capture",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        # No password manager / keychain prompts for our app profile.
        "--password-store=basic",
        # Stop the browser from auto-lowering the OS microphone input level over time
        # (WebRTC input-volume adjustment). Pairs with autoGainControl:false in 04-audio.js.
        "--disable-features=WebRtcAllowInputVolumeAdjustment,AutofillServerCommunication"
    )
    $appProcess = Start-Process $chromePath -ArgumentList $chromeArgs -PassThru
} else {
    Write-Host "[App] No Chrome/Edge found. Opening in default browser..." -ForegroundColor Yellow
    $appProcess = Start-Process $url -PassThru
}

# 4. Active state
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "Shadow is running! Keep this window open." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan

# Keep terminal open and wait for user input to shut down
Read-Host "Press ENTER in this window to shut down Shadow"

Write-Host "Terminating server background processes..." -ForegroundColor Yellow

if ($appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
}

if ($browserProc -and -not $browserProc.HasExited) {
    Stop-Process -Id $browserProc.Id -Force -ErrorAction SilentlyContinue
}

if ($schedulerProc -and -not $schedulerProc.HasExited) {
    Stop-Process -Id $schedulerProc.Id -Force -ErrorAction SilentlyContinue
}

if ($searxngProc -and -not $searxngProc.HasExited) {
    Stop-Process -Id $searxngProc.Id -Force -ErrorAction SilentlyContinue
}

if ($pttState) { $pttState.run = $false }
if ($pttRunspaceThread) { try { $pttRunspaceThread.Dispose() } catch {} }

if ($serverType -eq "powershell") {
    $listener.Stop()
    $listener.Close()
    foreach ($thread in $powershellThreads) {
        try { $thread.Dispose() } catch {}
    }
} else {
    if ($serverProcess) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Shuting down. Goodbye!" -ForegroundColor Red
Start-Sleep -Seconds 1
