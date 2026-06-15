<#
.SYNOPSIS
    Builds a standalone Windows installer (.exe) for Shadow AI.

.DESCRIPTION
    Assembles a fully self-contained payload under dist/staging:
      - runtime/python : a relocatable CPython (astral python-build-standalone) with the
                         SearXNG requirements installed, so end users need no Python.
      - searxng/app    : the patched SearXNG source (see prepare logic below).
      - runtime/node   : a relocatable Node.js (for scheduler.js / browser automation).
      - the app files   : run.ps1, run.bat, scheduler.js, src/, models.json, etc.
    Then compiles installer/shadow-ai.iss with Inno Setup (ISCC) into dist/ShadowAI-Setup.exe.

    run.ps1 auto-detects runtime/node and runtime/python, so the installed app uses these
    bundled runtimes and needs nothing on the system PATH.

    REQUIREMENTS on the build machine:
      - git, tar (built into Windows 10+), PowerShell 5+.
      - Inno Setup (ISCC.exe) — https://jrsoftware.org/isdl.php — only for the final compile.

.EXAMPLE
    pwsh -File tools/build-installer.ps1
    pwsh -File tools/build-installer.ps1 -SkipInstallerCompile   # assemble payload only
#>
[CmdletBinding()]
param(
    [string]$PythonVersion = "3.12",
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$IsccPath = "",
    [switch]$SkipInstallerCompile
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # faster downloads (no progress UI)
# Windows PowerShell 5.1 can default to TLS 1.0; GitHub/nodejs require TLS 1.2+.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$dist = Join-Path $RepoRoot "dist"
$staging = Join-Path $dist "staging"
$runtime = Join-Path $staging "runtime"
$work = Join-Path $dist "_work"

Write-Host "=== Shadow AI installer build ===" -ForegroundColor Cyan
Write-Host "Repo:    $RepoRoot"
Write-Host "Staging: $staging"

foreach ($d in @($staging, $work)) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
}
New-Item -ItemType Directory -Force -Path $staging, $runtime, $work | Out-Null

# ---------------------------------------------------------------------------
# 1. Relocatable Python (astral python-build-standalone, "install_only").
# ---------------------------------------------------------------------------
Write-Host "`n[1/5] Fetching relocatable Python $PythonVersion ..." -ForegroundColor Magenta
$pbsRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest" -Headers @{ "User-Agent" = "shadow-ai-build" }
$pyAsset = $pbsRelease.assets |
    Where-Object { $_.name -match "^cpython-$([regex]::Escape($PythonVersion))\.\d+\+.*-x86_64-pc-windows-msvc-install_only\.tar\.gz$" } |
    Select-Object -First 1
if (-not $pyAsset) { throw "Could not find a python-build-standalone install_only asset for Python $PythonVersion." }
$pyArchive = Join-Path $work $pyAsset.name
Write-Host "  downloading $($pyAsset.name)"
Invoke-WebRequest -Uri $pyAsset.browser_download_url -OutFile $pyArchive
# install_only archives extract to a top-level "python/" directory.
tar -xzf $pyArchive -C $runtime
if (-not (Test-Path (Join-Path $runtime "python\python.exe"))) { throw "Python extraction failed (no runtime/python/python.exe)." }
$pyExe = Join-Path $runtime "python\python.exe"
& $pyExe --version

# ---------------------------------------------------------------------------
# 2. SearXNG source (Windows-patched) + requirements into the bundled Python.
# ---------------------------------------------------------------------------
Write-Host "`n[2/5] Preparing built-in SearXNG ..." -ForegroundColor Magenta
$searxApp = Join-Path $staging "searxng\app"
New-Item -ItemType Directory -Force -Path (Split-Path $searxApp) | Out-Null
git clone --depth 1 --no-checkout https://github.com/searxng/searxng.git $searxApp
Push-Location $searxApp
try {
    git config core.sparseCheckout true
    @"
/*
!/utils/templates/etc/uwsgi/
!/utils/templates/etc/nginx/
!/utils/templates/etc/httpd/
"@ | Set-Content -Encoding ascii ".git/info/sparse-checkout"
    # The ':' deploy-template files error on NTFS and are skipped — expected. Drop to
    # Continue so git's harmless stderr doesn't terminate the script under -EA Stop.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    git checkout HEAD -- .
    $ErrorActionPreference = $prevEAP
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $searxApp "searx\webapp.py"))) { throw "SearXNG checkout incomplete." }
# Patch the POSIX-only `pwd` import so the module imports on Windows.
$vdb = Join-Path $searxApp "searx\valkeydb.py"
if (Test-Path $vdb) {
    $t = Get-Content $vdb -Raw
    $t = $t -replace '(?m)^import pwd\r?$', "try:`r`n    import pwd  # POSIX-only; absent on Windows`r`nexcept ImportError:`r`n    pwd = None"
    $t = $t.Replace('        _pw = pwd.getpwuid(os.getuid())', '        _pw = pwd.getpwuid(os.getuid()) if (pwd and hasattr(os, "getuid")) else None')
    Set-Content -Encoding ascii $vdb $t
}
# Freeze the version so SearXNG doesn't shell out to `git` at runtime (the bundle has no
# .git, which otherwise logs "fatal: not a git repository" errors on every start).
@"
VERSION_STRING = "1.0.0"
VERSION_TAG = "1.0.0"
DOCKER_TAG = "1.0.0"
GIT_URL = "https://github.com/searxng/searxng"
GIT_BRANCH = "master"
"@ | Set-Content -Encoding ascii (Join-Path $searxApp "searx\version_frozen.py")
# Drop the .git dir from the bundled source (not needed at runtime, keeps the installer small).
Remove-Item -Recurse -Force (Join-Path $searxApp ".git") -ErrorAction SilentlyContinue
Write-Host "  installing SearXNG requirements into bundled Python ..."
& $pyExe -m pip install --upgrade pip
& $pyExe -m pip install -r (Join-Path $searxApp "requirements.txt")

# ---------------------------------------------------------------------------
# 3. Relocatable Node.js (latest LTS).
# ---------------------------------------------------------------------------
Write-Host "`n[3/5] Fetching Node.js (latest LTS) ..." -ForegroundColor Magenta
$nodeIndex = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -Headers @{ "User-Agent" = "shadow-ai-build" }
$nodeLts = $nodeIndex | Where-Object { $_.lts } | Select-Object -First 1
if (-not $nodeLts) { throw "Could not determine latest Node LTS." }
$nodeVer = $nodeLts.version
$nodeZipName = "node-$nodeVer-win-x64"
$nodeZip = Join-Path $work "$nodeZipName.zip"
Write-Host "  downloading $nodeZipName"
Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVer/$nodeZipName.zip" -OutFile $nodeZip
Expand-Archive -Path $nodeZip -DestinationPath $work -Force
Move-Item -Path (Join-Path $work $nodeZipName) -Destination (Join-Path $runtime "node")
if (-not (Test-Path (Join-Path $runtime "node\node.exe"))) { throw "Node extraction failed." }
& (Join-Path $runtime "node\node.exe") --version

# ---------------------------------------------------------------------------
# 4. App files.
# ---------------------------------------------------------------------------
Write-Host "`n[4/5] Copying app files ..." -ForegroundColor Magenta
$appItems = @(
    "run.ps1", "run.bat", "scheduler.js", "browser_controller.js", "desktop_controller.ps1",
    "models.json", "package.json", "README.md", "LICENSE", "CONTRIBUTING.md"
)
foreach ($item in $appItems) {
    $src = Join-Path $RepoRoot $item
    if (Test-Path $src) { Copy-Item $src -Destination $staging -Force }
}
Copy-Item (Join-Path $RepoRoot "src") -Destination (Join-Path $staging "src") -Recurse -Force

$payloadMB = (Get-ChildItem $staging -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("  staged payload size: {0:N0} MB" -f $payloadMB)

# ---------------------------------------------------------------------------
# 5. Compile the installer with Inno Setup.
# ---------------------------------------------------------------------------
if ($SkipInstallerCompile) {
    Write-Host "`n[5/5] Skipping installer compile (-SkipInstallerCompile). Payload is in $staging" -ForegroundColor Yellow
    return
}
Write-Host "`n[5/5] Compiling installer with Inno Setup ..." -ForegroundColor Magenta
if (-not $IsccPath) {
    $candidates = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    )
    $IsccPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $IsccPath -or -not (Test-Path $IsccPath)) {
    throw "Inno Setup (ISCC.exe) not found. Install it from https://jrsoftware.org/isdl.php, then re-run (or pass -IsccPath)."
}
$iss = Join-Path $RepoRoot "installer\shadow-ai.iss"
& $IsccPath "/DStagingDir=$staging" "/DRepoRoot=$RepoRoot" $iss
Write-Host "`nDone. Installer is in $dist" -ForegroundColor Green
