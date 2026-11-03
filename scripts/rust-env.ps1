$projectRoot = Split-Path -Parent $PSScriptRoot
$localCargoBin = Join-Path $projectRoot '.tools\cargo\bin'
if (Test-Path -LiteralPath (Join-Path $localCargoBin 'cargo.exe')) {
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
    $gnuBin = Join-Path $env:RUSTUP_HOME 'toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained'
    $env:PATH = "$localCargoBin;$gnuBin;$env:PATH"
    $gnuCompiler = Join-Path $gnuBin 'x86_64-w64-mingw32-gcc.exe'
    if (Test-Path -LiteralPath $gnuCompiler) {
        $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = $gnuCompiler
    }
    $portableGnuBin = Join-Path $projectRoot '.tools\w64devkit\bin'
    if (Test-Path -LiteralPath (Join-Path $portableGnuBin 'gcc.exe')) {
        $env:PATH = "$portableGnuBin;$env:PATH"
    }
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust is not installed. Install Rust via https://rustup.rs, then reopen this terminal.'
}
