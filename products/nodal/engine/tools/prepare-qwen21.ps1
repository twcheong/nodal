#Requires -Version 7.0
[CmdletBinding()]
param([switch]$SkipDownload)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    # First install the platform's CUDA runtime with uv sync --extra cuda.
    & uv pip install --python .venv/Scripts/python.exe -r tools/qwen21-requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Qwen runtime installation failed.' }
    if (-not $SkipDownload) {
        & .venv/Scripts/python.exe tools/qwen21_download.py
        if ($LASTEXITCODE -ne 0) { throw 'Qwen weight download failed.' }
    }
    & .venv/Scripts/python.exe -c 'from diffusers import QwenImage21Pipeline; from transformers import Qwen3VLProcessor; print("Qwen 2.1 runtime imports OK")'
    if ($LASTEXITCODE -ne 0) { throw 'Qwen runtime import failed.' }
}
finally { Pop-Location }
