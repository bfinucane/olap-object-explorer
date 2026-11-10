# Chooses a node.exe whose architecture matches the native rollup/esbuild
# packages installed in this checkout's node_modules.
#
# Why this exists: on Windows-on-ARM, node_modules may be installed under x64
# (emulated) while a newer arm64 Node is first on PATH (or vice versa). The
# mismatch fails later inside Vite/rollup with "Cannot find module
# @rollup/rollup-win32-<arch>-msvc", which says nothing about the real cause.
#
# stdout: one line, the chosen node.exe. stderr: diagnostics when nothing fits.
# Set OLAP_EXPLORER_NODE to force a specific node.exe (compatibility warned about,
# not enforced).
$ErrorActionPreference = 'SilentlyContinue'

$repo = Split-Path -Parent $PSScriptRoot

function Get-Arch([string]$exe) {
    $out = & $exe -p 'process.arch' 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    if (-not $out) { return $null }
    return ([string]($out | Select-Object -First 1)).Trim()
}

function Get-CompatibleArch([string]$exe) {
    $arch = Get-Arch $exe
    if (-not $arch) { return $null }
    $rollup = Join-Path $repo "node_modules\@rollup\rollup-win32-$arch-msvc"
    $esbuild = Join-Path $repo "node_modules\@esbuild\win32-$arch"
    if ((Test-Path $rollup) -and (Test-Path $esbuild)) { return $arch }
    return $null
}

$override = $env:OLAP_EXPLORER_NODE
if ($override) {
    if (-not (Test-Path $override)) {
        [Console]::Error.WriteLine("OLAP_EXPLORER_NODE does not exist: $override")
        exit 1
    }
    $arch = Get-CompatibleArch $override
    if (-not $arch) {
        $actual = Get-Arch $override
        [Console]::Error.WriteLine(
            "WARNING: OLAP_EXPLORER_NODE runs as win32-$actual, but node_modules has no native packages for that architecture; the app may fail."
        )
    }
    Write-Output $override
    exit 0
}

$candidates = New-Object System.Collections.Generic.List[string]

function Add-Candidate([string]$path) {
    if (-not $path) { return }
    if (-not (Test-Path $path)) { return }
    $resolved = (Resolve-Path $path).Path
    if (-not $candidates.Contains($resolved)) { $candidates.Add($resolved) }
}

Get-Command node -All -ErrorAction SilentlyContinue | ForEach-Object { Add-Candidate $_.Source }
Add-Candidate (Join-Path $env:ProgramFiles 'nodejs\node.exe')
if ($env:LOCALAPPDATA) { Add-Candidate (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
if ($env:USERPROFILE) {
    $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
    if (Test-Path $runtimes) {
        Get-ChildItem $runtimes -Directory | ForEach-Object {
            Add-Candidate (Join-Path $_.FullName 'dependencies\node\bin\node.exe')
        }
    }
}

foreach ($candidate in $candidates) {
    $arch = Get-CompatibleArch $candidate
    if ($arch) {
        Write-Output $candidate
        exit 0
    }
}

[Console]::Error.WriteLine('No Node matching the native packages in node_modules was found.')
[Console]::Error.WriteLine('Tried:')
if ($candidates.Count -eq 0) {
    [Console]::Error.WriteLine('  (no node.exe on PATH or in the usual install locations)')
} else {
    foreach ($candidate in $candidates) {
        $arch = Get-Arch $candidate
        if (-not $arch) { $arch = 'unknown' }
        [Console]::Error.WriteLine("  $candidate (win32-$arch)")
    }
}
[Console]::Error.WriteLine(
    'Fix: reinstall dependencies with the Node you run (npm install), or set OLAP_EXPLORER_NODE to a node.exe of the matching architecture.'
)
exit 1
