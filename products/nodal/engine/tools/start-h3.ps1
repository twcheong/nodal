# Run from PowerShell after following docs/minimax-h3.md.
[CmdletBinding()]
param(
    [string]$ModelPath = '',
    [ValidateRange(1, 65535)]
    [int]$Port = 8190,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ModelPath) {
    $ModelPath = Join-Path $repoRoot 'models/MiniMax-H3-Pruned'
}
elseif (-not [System.IO.Path]::IsPathRooted($ModelPath)) {
    $ModelPath = Join-Path $repoRoot $ModelPath
}
$previousDevice = $env:NODAL_DEVICE
$previousModel = $env:NODAL_H3_MODEL
$previousUtf8 = $env:PYTHONUTF8

Push-Location $repoRoot
try {
    $env:NODAL_DEVICE = 'cuda'
    $env:NODAL_H3_MODEL = [System.IO.Path]::GetFullPath($ModelPath)
    $env:PYTHONUTF8 = '1'
    & uv run --no-sync python -m nodal_nodes_diffusion.h3_check
    if ($LASTEXITCODE -ne 0) {
        throw 'H3 readiness check failed. Follow docs/minimax-h3.md to finish setup.'
    }
    if (-not $CheckOnly) {
        if (-not (Test-Path -LiteralPath 'apps/web/dist/index.html')) {
            throw 'Build the web UI first: pnpm --filter @nodal/web build'
        }
        Write-Host "H3 workspace: http://127.0.0.1:$Port"
        Write-Host 'Open examples/h3-pruned-text-to-video.nodal.json in the web UI.'
        & uv run --no-sync nodal serve --host 127.0.0.1 --port $Port --assets outputs/h3/assets --web apps/web/dist
        if ($LASTEXITCODE -ne 0) {
            throw "H3 server exited with code $LASTEXITCODE."
        }
    }
}
finally {
    $env:NODAL_DEVICE = $previousDevice
    $env:NODAL_H3_MODEL = $previousModel
    $env:PYTHONUTF8 = $previousUtf8
    Pop-Location
}
