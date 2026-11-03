param([switch]$Build)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'rust-env.ps1')
if ($Build -or -not (Test-Path -LiteralPath 'dist\index.html')) {
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
}
if ($Build -or -not (Test-Path -LiteralPath 'target\debug\c5isr-server.exe')) {
    & cargo build -p c5isr-server
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
}
& '.\target\debug\c5isr-server.exe'
