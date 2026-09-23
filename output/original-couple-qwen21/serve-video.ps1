$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$env:PYTHONUTF8 = '1'
$env:NODAL_DEVICE = 'cuda'
$env:NODAL_H3_MODEL = Join-Path $taskRepo 'models/MiniMax-H3-Pruned'
Push-Location $taskRepo
try {
    & .venv/Scripts/python.exe -c 'from nodal_nodes_core.cli import main; raise SystemExit(main())' serve `
        --host 127.0.0.1 --port 8199 `
        --assets output/original-couple-draft/video-assets `
        --templates output/original-couple-draft/video-templates
    exit $LASTEXITCODE
}
finally { Pop-Location }
