<#
.SYNOPSIS
    Prepares a Windows-runnable, built-in SearXNG payload for Shadow AI.

.DESCRIPTION
    Shadow AI ships SearXNG as a bundled, server-managed web-search backend so end users
    need no Docker. Upstream SearXNG is Linux-oriented and has two Windows blockers that
    this script works around (both validated by a live spike on 2026-05-29):

      1. The repo tracks deploy-template files whose names contain ':' (e.g.
         utils/templates/etc/nginx/...searxng.conf:socket). ':' is illegal in NTFS
         filenames, so a plain `git clone` cannot check out the working tree on Windows.
         Those files are deploy configs and are NOT needed at runtime, so we skip them.

      2. searx/valkeydb.py does a top-level `import pwd` (POSIX-only) used only to log the
         OS user when a Valkey/Redis connection fails. We make that import + its single use
         optional so the module imports on Windows. (Local single-user SearXNG uses no Valkey.)

    The result, under <OutDir>, is:
      <OutDir>/app          the SearXNG source (searx/ package, requirements.txt, ...)
      <OutDir>/venv         a venv with requirements installed
    run.ps1 launches it with `python -m searx.webapp` and SEARXNG_SETTINGS_PATH.

    NOTE: a venv is not fully standalone on Windows (it references a base Python). Making
    the bundle self-contained for the installer (embeddable Python) is a packaging step
    handled in the installer build (Phase 3).

.EXAMPLE
    pwsh -File tools/prepare-searxng.ps1
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path $PSScriptRoot "..\searxng"),
    [string]$Ref = "master",
    [string]$PythonLauncherArg = "-3.12"
)

$ErrorActionPreference = "Stop"
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$appDir = Join-Path $OutDir "app"
$venvDir = Join-Path $OutDir "venv"

Write-Host "Preparing built-in SearXNG payload in: $OutDir" -ForegroundColor Cyan
if (Test-Path $OutDir) {
    Write-Host "Removing existing payload..." -ForegroundColor DarkYellow
    Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 1. Clone without checkout, then check out tolerating the known NTFS-illegal files.
Write-Host "Cloning SearXNG ($Ref)..." -ForegroundColor Cyan
git clone --depth 1 --branch $Ref --no-checkout https://github.com/searxng/searxng.git $appDir
Push-Location $appDir
try {
    git config core.sparseCheckout true
    # Exclude the deploy-template dirs that contain ':' filenames.
    @"
/*
!/utils/templates/etc/uwsgi/
!/utils/templates/etc/nginx/
!/utils/templates/etc/httpd/
"@ | Set-Content -Encoding ascii ".git/info/sparse-checkout"
    # The ':' files still error individually (NTFS cannot create them); that is expected
    # and harmless. Drop to Continue so git's stderr doesn't terminate under -EA Stop; we
    # verify the essential files afterwards instead of trusting the exit code.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    git checkout HEAD -- .
    $ErrorActionPreference = $prevEAP
} finally {
    Pop-Location
}

$webapp = Join-Path $appDir "searx\webapp.py"
$reqs = Join-Path $appDir "requirements.txt"
if (-not (Test-Path $webapp) -or -not (Test-Path $reqs)) {
    throw "Checkout incomplete: missing searx/webapp.py or requirements.txt. SearXNG layout may have changed."
}

# 2. Patch the POSIX-only `pwd` usage in valkeydb.py so the module imports on Windows.
$vdb = Join-Path $appDir "searx\valkeydb.py"
if (Test-Path $vdb) {
    $txt = Get-Content $vdb -Raw
    $txt = $txt -replace '(?m)^import pwd\r?$', "try:`r`n    import pwd  # POSIX-only; absent on Windows`r`nexcept ImportError:`r`n    pwd = None"
    $txt = $txt.Replace(
        '        _pw = pwd.getpwuid(os.getuid())',
        '        _pw = pwd.getpwuid(os.getuid()) if (pwd and hasattr(os, "getuid")) else None')
    Set-Content -Encoding ascii $vdb $txt
    Write-Host "Patched searx/valkeydb.py for Windows." -ForegroundColor DarkGray
} else {
    Write-Host "WARNING: searx/valkeydb.py not found; skipping pwd patch (verify SearXNG still imports on Windows)." -ForegroundColor Yellow
}

# 3. Create the venv and install requirements (all ship Windows wheels).
Write-Host "Creating venv..." -ForegroundColor Cyan
py $PythonLauncherArg -m venv $venvDir
$venvPy = Join-Path $venvDir "Scripts\python.exe"
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r $reqs

Write-Host ""
Write-Host "Done. Built-in SearXNG payload ready at $OutDir" -ForegroundColor Green
Write-Host "run.ps1 will launch it automatically on the next start (port 8888)." -ForegroundColor Green
