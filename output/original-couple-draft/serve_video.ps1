$ErrorActionPreference = 'Stop'
$draftRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$env:PYTHONUTF8 = '1'
$env:NODAL_DEVICE = 'cuda'
$env:NODAL_H3_MODEL = Join-Path $draftRepo 'models/MiniMax-H3-Pruned'
& (Join-Path $draftRepo '.venv/Scripts/nodal.exe') serve `
    --host 127.0.0.1 --port 8199 `
    --assets (Join-Path $PSScriptRoot 'video-assets') `
    --templates (Join-Path $PSScriptRoot 'video-templates')
exit $LASTEXITCODE
