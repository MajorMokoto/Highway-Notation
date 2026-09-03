<#
Highway Notation installer.

Self-contained via a self-extracting-archive trick: the compiled .exe of
this script has the plugin payload (a zip of highway_notation/, highway_3d/,
static/) appended as raw bytes after a fixed marker string. At runtime this
reads ITS OWN .exe file, finds the marker, and treats everything after it
as the zip — no ps2exe compiler involvement for the payload at all (that's
what corrupted it when the payload was embedded as a PowerShell string
literal/array instead). Doesn't need any other files sitting next to it,
including when run straight out of Explorer's zip preview.

When run as a plain .ps1 (marker not found — nothing's been appended), it
falls back to looking for a sibling payload.zip, for local testing without
a full ps2exe rebuild each time.
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$PayloadMarker = [System.Text.Encoding]::ASCII.GetBytes('===HWN_PAYLOAD_START===')

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

# Finds $PayloadMarker in a byte array (own .exe file's bytes), returns the
# index right after the LAST occurrence of the marker, or -1 if not found.
# Must search from the END backward, not forward from the start — ps2exe
# embeds this script's own source text inside the compiled exe (for the
# runtime to execute), and that embedded copy contains this same marker
# string as a literal, so a forward search finds THAT one instead of the
# real appended payload, which is always the true last occurrence.
function Find-MarkerEnd($bytes, $marker) {
    $mLen = $marker.Length
    for ($i = $bytes.Length - $mLen; $i -ge 0; $i--) {
        $match = $true
        for ($j = 0; $j -lt $mLen; $j++) {
            if ($bytes[$i + $j] -ne $marker[$j]) { $match = $false; break }
        }
        if ($match) { return $i + $mLen }
    }
    return -1
}

function Get-PayloadBytes {
    $ownPath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $ownBytes = [System.IO.File]::ReadAllBytes($ownPath)
    $start = Find-MarkerEnd $ownBytes $PayloadMarker
    if ($start -ge 0) {
        $len = $ownBytes.Length - $start
        $payload = New-Object byte[] $len
        [System.Array]::Copy($ownBytes, $start, $payload, 0, $len)
        return $payload
    }
    # Dev fallback: no marker (running as a plain .ps1) — use a sibling
    # payload.zip if one exists, so this can be tested without a full
    # ps2exe + append rebuild every time.
    $sibling = Join-Path (Split-Path -Parent $ownPath) 'payload.zip'
    if (Test-Path $sibling) {
        return [System.IO.File]::ReadAllBytes($sibling)
    }
    return $null
}

$payloadBytes = Get-PayloadBytes
if (-not $payloadBytes) {
    Show-ErrorBox "Couldn't find the installer's payload data. This .exe may be corrupted or incomplete — try re-downloading it."
    exit 1
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

$tempRoot = Join-Path $env:TEMP ('HighwayNotationInstall_' + [guid]::NewGuid().ToString('N'))

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $tempZip = Join-Path $tempRoot 'payload.zip'
    [System.IO.File]::WriteAllBytes($tempZip, $payloadBytes)
    $extractDir = Join-Path $tempRoot 'extracted'
    Expand-Archive -Path $tempZip -DestinationPath $extractDir -Force

    # Plugin folders: straight overwrite (Copy-Item -Force merges files,
    # -Recurse walks subfolders — this does NOT delete files that exist in
    # the destination but not the source, same caveat as the static merge
    # below).
    Copy-Item -Path (Join-Path $extractDir 'highway_notation') -Destination $pluginsDir -Recurse -Force
    Copy-Item -Path (Join-Path $extractDir 'highway_3d') -Destination $pluginsDir -Recurse -Force

    # static\: this repo's static\ only carries the two patched files
    # (highway.js, js\highway-draw.js), not a full copy of FeedBack's real
    # static folder — merge-copy so nothing else under static\ gets removed.
    if (-not (Test-Path $staticDir)) {
        New-Item -ItemType Directory -Path $staticDir -Force | Out-Null
    }
    Copy-Item -Path (Join-Path $extractDir 'static\*') -Destination $staticDir -Recurse -Force

    Show-Info "Installed successfully.`n`nRestart FeedBack to activate."
}
catch {
    Show-ErrorBox "Something went wrong during install:`n`n$($_.Exception.Message)"
    exit 1
}
finally {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
