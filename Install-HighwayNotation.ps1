<#
Highway Notation installer.

Copies the three folders that ship next to this script into the right
places inside a FeedBack install:
  - highway_notation\  -> <FeedBack>\resources\slopsmith\plugins\highway_notation
  - highway_3d\        -> <FeedBack>\resources\slopsmith\plugins\highway_3d
  - static\             -> <FeedBack>\resources\slopsmith\  (merged, not replaced)

Run this from the extracted release folder (it expects highway_notation\,
highway_3d\, and static\ as siblings of this script).
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# $PSScriptRoot is empty inside a ps2exe-compiled binary (it's only
# populated when running the raw .ps1 from disk), so this reads the
# running process's own .exe path instead — works both compiled and as
# a plain script (falls back to $PSScriptRoot there).
if ($PSScriptRoot) {
    $ScriptRoot = $PSScriptRoot
}
else {
    $ScriptRoot = Split-Path -Parent ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
}
$SourceFolders = @('highway_notation', 'highway_3d', 'static')

function Show-Info($text, $title = 'Highway Notation Installer') {
    [System.Windows.Forms.MessageBox]::Show($text, $title, 'OK', 'Information') | Out-Null
}
function Show-ErrorBox($text, $title = 'Highway Notation Installer') {
    [System.Windows.Forms.MessageBox]::Show($text, $title, 'OK', 'Error') | Out-Null
}
function Ask-YesNo($text, $title = 'Highway Notation Installer') {
    $result = [System.Windows.Forms.MessageBox]::Show($text, $title, 'YesNo', 'Question')
    return $result -eq 'Yes'
}

# A valid FeedBack root is any folder that has resources\slopsmith\plugins under it.
function Test-FeedBackRoot($path) {
    if (-not $path) { return $false }
    return Test-Path (Join-Path $path 'resources\slopsmith\plugins')
}

function Find-FeedBackRoot {
    # Build each candidate only if its base env var actually has a value —
    # Join-Path throws on a null/empty base path instead of just skipping
    # it, and not every one of these env vars is guaranteed to be set on
    # every machine (e.g. ProgramFiles(x86) on some configurations).
    $bases = @(
        @($env:ProgramFiles, 'Feedback\current'),
        @(${env:ProgramFiles(x86)}, 'Feedback\current'),
        @($env:LOCALAPPDATA, 'Feedback\current'),
        @($env:LOCALAPPDATA, 'Programs\Feedback\current')
    )
    $candidates = @()
    foreach ($b in $bases) {
        if ($b[0]) { $candidates += (Join-Path $b[0] $b[1]) }
    }
    foreach ($c in $candidates) {
        if (Test-FeedBackRoot $c) { return $c }
    }
    return $null
}

# Verify this script actually has its payload folders sitting next to it
# before doing anything else.
foreach ($folder in $SourceFolders) {
    $p = Join-Path $ScriptRoot $folder
    if (-not (Test-Path $p)) {
        Show-ErrorBox "Missing folder: $folder`n`nThis script needs to run from inside the extracted Highway Notation release folder, with highway_notation\, highway_3d\, and static\ next to it."
        exit 1
    }
}

$feedbackRoot = Find-FeedBackRoot

if (-not $feedbackRoot) {
    Show-Info "Couldn't automatically find your FeedBack install.`n`nOn the next screen, browse to your FeedBack folder — the one that contains a 'resources' folder (usually named 'current')."
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select your FeedBack install folder (the one containing 'resources')"
    if ($dialog.ShowDialog() -ne 'OK') {
        exit 0
    }
    if (Test-FeedBackRoot $dialog.SelectedPath) {
        $feedbackRoot = $dialog.SelectedPath
    }
    else {
        Show-ErrorBox "That folder doesn't look like a FeedBack install — no resources\slopsmith\plugins found inside it. Installer stopping, nothing was changed."
        exit 1
    }
}

$pluginsDir = Join-Path $feedbackRoot 'resources\slopsmith\plugins'
$staticDir = Join-Path $feedbackRoot 'resources\slopsmith\static'

$confirmMsg = "Found FeedBack at:`n$feedbackRoot`n`nThis will install/overwrite:`n - plugins\highway_notation`n - plugins\highway_3d`n - static\ (highway.js, js\highway-draw.js)`n`nContinue?"
if (-not (Ask-YesNo $confirmMsg)) {
    exit 0
}

try {
    # Plugin folders: straight overwrite (Copy-Item -Force merges files,
    # -Recurse walks subfolders — this does NOT delete files that exist in
    # the destination but not the source, same caveat as the static merge
    # below).
    Copy-Item -Path (Join-Path $ScriptRoot 'highway_notation') -Destination $pluginsDir -Recurse -Force
    Copy-Item -Path (Join-Path $ScriptRoot 'highway_3d') -Destination $pluginsDir -Recurse -Force

    # static\: this repo's static\ only carries the two patched files
    # (highway.js, js\highway-draw.js), not a full copy of FeedBack's real
    # static folder — merge-copy so nothing else under static\ gets removed.
    if (-not (Test-Path $staticDir)) {
        New-Item -ItemType Directory -Path $staticDir -Force | Out-Null
    }
    Copy-Item -Path (Join-Path $ScriptRoot 'static\*') -Destination $staticDir -Recurse -Force

    Show-Info "Installed successfully.`n`nRestart FeedBack to activate."
}
catch {
    Show-ErrorBox "Something went wrong during install:`n`n$($_.Exception.Message)"
    exit 1
}
