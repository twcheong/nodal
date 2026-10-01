#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ModelPath = '',
    [ValidateRange(1, 65535)][int]$Port = 8210
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ModelPath) { $ModelPath = Join-Path $repoRoot 'models/Qwen-Image-2.1' }
$previousDevice = $env:NODAL_DEVICE
$previousModel = $env:NODAL_QWEN21_MODEL
$previousUtf8 = $env:PYTHONUTF8
Push-Location $repoRoot
try {
    $env:NODAL_DEVICE = 'cuda'
    $env:NODAL_QWEN21_MODEL = [System.IO.Path]::GetFullPath($ModelPath)
    $env:PYTHONUTF8 = '1'
    New-Item -ItemType Directory -Force -Path 'outputs/qwen21/templates' | Out-Null
    foreach ($name in @('qwen21_generate', 'qwen21_edit', 'qwen21_compose')) {
        Copy-Item -LiteralPath "examples/templates/$name.nodal.json" -Destination "outputs/qwen21/templates/$name.nodal.json" -Force
    }
    & .venv/Scripts/python.exe -c 'from nodal_nodes_diffusion.qwen21 import model_directory; from diffusers import QwenImage21Pipeline; print(model_directory(""))'
    if ($LASTEXITCODE -ne 0) { throw 'Follow docs/qwen-image-21.md to finish setup.' }
    $arguments = @('serve', '--host', '127.0.0.1', '--port', "$Port", '--assets', 'outputs/qwen21/assets', '--templates', 'outputs/qwen21/templates')
    if (Test-Path -LiteralPath 'apps/web/dist/index.html') {
        $arguments += @('--web', 'apps/web/dist')
    }
    Write-Host "Qwen workspace: http://127.0.0.1:$Port | MCP: http://127.0.0.1:$Port/mcp"
    & .venv/Scripts/python.exe -c 'from nodal_nodes_core.cli import main; raise SystemExit(main())' @arguments
    if ($LASTEXITCODE -ne 0) { throw "Qwen server exited with code $LASTEXITCODE." }
}
finally {
    $env:NODAL_DEVICE = $previousDevice
    $env:NODAL_QWEN21_MODEL = $previousModel
    $env:PYTHONUTF8 = $previousUtf8
    Pop-Location
}
