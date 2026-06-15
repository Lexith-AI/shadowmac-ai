$ErrorActionPreference = 'Stop'
$src = Get-Content (Join-Path $PSScriptRoot '..\run.ps1') -Raw
$si = $src.IndexOf('function ConvertTo-ShadowReusableToken {')
$ei = $src.IndexOf('while ($listener.IsListening) {')
Invoke-Expression $src.Substring($si, $ei - $si)

function New-Skill { param($Root,$Name,$Text)
    $d = Join-Path $Root $Name; New-Item -ItemType Directory -Path $d -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $d 'instructions.txt'), $Text, [System.Text.Encoding]::UTF8)
}
function Probe { param($Existing,$ReqName,$ReqText)
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("p_"+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    foreach ($e in $Existing) { New-Skill $tmp $e.Name $e.Text }
    $r = Find-ShadowReusableArtifact -RootDir $tmp -Kind 'skill' -RequestName $ReqName -RequestText $ReqText -ExcludeName $ReqName
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    return $r
}
$fail = 0
function Check { param($label,$r,[bool]$wantMerge,$wantName)
    $got = if ($r.Match) { $r.Match.Name } else { '' }
    $ok = if ($wantMerge) { [bool]$r.Match -and ($null -eq $wantName -or $got -eq $wantName) } else { -not $r.Match }
    if ($ok) { Write-Host "PASS: $label (match='$got' nameSim=$($r.ClosestNameSim) contentSim=$($r.ClosestContentSim))" }
    else { Write-Host "FAIL: $label -> match='$got' (wanted merge=$wantMerge name=$wantName) nameSim=$($r.ClosestNameSim) contentSim=$($r.ClosestContentSim)"; $script:fail++ }
}

# A BLOATED calculator skill that has absorbed calc1/calc2/calc3 (this is what the real run produced and
# what my earlier clean-skill probes did NOT simulate -- the gap that let the portfolio bug through).
$calcBlob = @"
Reusable workflow learned from successful task.
Task: Build a working calculator web app saved as calculator.html on the user's desktop.
Outcome / verification: Created a fully functional calculator web app saved as calculator.html on the desktop. Self-contained single HTML file with inline CSS, number and operator buttons, a display, and JavaScript add/subtract/multiply/divide functions. Verified with Test-Path.
--- Updated ---
Create a second simple calculator as a self-contained single HTML file named calculator2.html on the desktop with a modern dark-themed UI, inline CSS, keyboard input, and arithmetic functions. Verified via Test-Path.
--- Updated ---
Create a third simple calculator contained within a single HTML file named calculator3.html on the desktop with standard calculator functionality, inline styling, and JavaScript. Verified with Test-Path returning True.
"@
$calc = @{ Name='workflow_create_working_calculator_web_app_contained'; Text=$calcBlob }
$landing = @{ Name='workflow_create_basic_html_css_landing_page'; Text="Create a basic HTML CSS landing page on the desktop with a hero section, headline, call to action button and inline styling. Open it to confirm it renders." }
$portfolioExisting = @{ Name='workflow_create_demo_personal_portfolio_website'; Text="Create a demo personal portfolio website as a self-contained single HTML file on the desktop with an about section, projects grid, contact links and inline CSS. Verified with Test-Path." }
$vps = @{ Name='connect_to_vps'; Text="Connect to the user's VPS over SSH using the saved host address and credentials, then report the shell is ready." }
$yt = @{ Name='download_youtube_audio_to_desktop_mp3'; Text="Download the audio track of a given YouTube video as an MP3 to the desktop using yt-dlp." }

# 1) THE BUG: a portfolio website must NOT merge into the bloated calculator skill (content-path leak).
Check 'portfolio does NOT merge into bloated calculator' (Probe @($calc) 'workflow_create_demo_personal_portfolio_website_single' "Create a demo personal portfolio website as a single self-contained HTML file on the user's desktop with about, projects and contact sections, inline CSS and a dark theme. Verified with Test-Path.") $false $null

# 2) A 4th calculator SHOULD still merge into the calculator skill (real dedup must keep working).
Check '4th calculator merges into calculator skill' (Probe @($calc) 'workflow_create_simple_calculator_html' "Create a simple calculator as a self-contained HTML file on the desktop with buttons, a display and JavaScript arithmetic. Verified with Test-Path.") $true $calc.Name

# 3) Calculator must NOT merge into a landing page.
Check 'calculator does NOT merge into landing' (Probe @($landing) 'workflow_create_working_calculator_web_app' "Build a working calculator web app as a single HTML file on the desktop with buttons and arithmetic. Open to confirm.") $false $null

# 4) A second portfolio SHOULD merge into an existing portfolio skill.
Check 'second portfolio merges into portfolio' (Probe @($portfolioExisting) 'workflow_create_personal_portfolio_website_demo' "Create a personal portfolio website demo as a self-contained HTML file on the desktop with projects and contact sections and inline CSS. Verified.") $true $portfolioExisting.Name

# 5) Different VPS operations sharing only 'vps' must NOT merge.
Check 'take_vps_offline does NOT merge into connect_to_vps' (Probe @($vps) 'take_vps_domain_offline_safely' "Take the user's VPS domain offline safely by stopping the caddy service for that hostname over SSH.") $false $null

# 6) Different YouTube operations sharing only 'youtube' must NOT merge.
Check 'upload_youtube does NOT merge into download_youtube' (Probe @($yt) 'upload_video_to_youtube_unlisted' "Upload a local video file to YouTube as unlisted using the YouTube Data API.") $false $null

# 7) Calculator must NOT merge into the portfolio skill either (reverse of #1).
Check 'calculator does NOT merge into portfolio' (Probe @($portfolioExisting) 'workflow_create_working_calculator_web_app' "Build a working calculator web app as a self-contained single HTML file on the desktop with buttons, display and JavaScript arithmetic. Verified with Test-Path.") $false $null

# ---- The EXACT scenario from the user's 2026-05-31 logs (calculator2 filename suffix) ----
# calc1 was saved as workflow_build_working_calculator_single_html_user. The 2nd calculator's task named
# the file calculator2.html, so the name carried "calculator2" -> must still merge into calc1 (no dup).
$calc1Real = @{ Name='workflow_build_working_calculator_single_html_user'; Text="Reusable workflow. Task: Build a working calculator as a single HTML file on the user's desktop named calculator.html with number and operator buttons, a display and JavaScript arithmetic. Verified via Test-Path." }
Check 'calculator2.html merges into the calculator1 skill (digit suffix)' (Probe @($calc1Real) 'workflow_create_calculator2_html_user_desktop_same' "Create calculator2.html on the user's desktop with the same clean professional calculator UI, buttons, display and JavaScript arithmetic as calculator.html. Verified via Test-Path.") $true $calc1Real.Name

# And a portfolio next to that calculator skill must STILL stay its own skill.
Check 'portfolio_demo stays separate from calculator1 skill' (Probe @($calc1Real) 'workflow_create_portfolio_demo_html_user_desktop' "Create a portfolio_demo.html file on the user's desktop serving as a personal portfolio website with about, projects, contact sections, a navigation bar and footer. Verified via Test-Path.") $false $null

if ($fail -eq 0) { Write-Host "`nALL_REGRESSION_PASSED" } else { Write-Host "`n$fail FAILED"; exit 1 }
