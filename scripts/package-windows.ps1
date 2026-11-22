# Run from PowerShell in its own process. Build dependencies: Node, pnpm,
# Rust's x86_64-pc-windows-gnu toolchain and GNU binutils (or llvm-objdump).
param([string]$Version = '0.1.0')
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw 'Expected Windows and a numeric major.minor.patch release version.'
}
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo
. (Join-Path $PSScriptRoot 'rust-env.ps1')
$triple = 'x86_64-pc-windows-gnu'
$sysroot = (& rustc --print sysroot).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not locate the Rust toolchain.' }
$artifactDir = Join-Path $repo 'artifacts'
[IO.Directory]::CreateDirectory($artifactDir) | Out-Null

# Use neutral compile-time source locations for both file!() and panic strings.
# rustc uses the last matching prefix, so add specialized registry paths last.
$cargoDir = $env:CARGO_HOME
if (!$cargoDir) { $cargoDir = Join-Path $env:USERPROFILE '.cargo' }
$prefixes = [ordered]@{}
$prefixes[$env:USERPROFILE] = '/build/user'
$prefixes[$repo] = '/build/source'
$prefixes[$sysroot] = '/build/toolchain'
$prefixes[$cargoDir] = '/build/cargo'
Get-ChildItem -Directory -LiteralPath (Join-Path $cargoDir 'registry/src') | ForEach-Object {
    $prefixes[$_.FullName] = '/build/dependencies'
}
$flags = @('-C', 'target-feature=+crt-static', '-C', 'link-arg=-Wl,--no-insert-timestamp')
foreach ($item in $prefixes.GetEnumerator()) {
    foreach ($sourcePrefix in @($item.Key, $item.Key.Replace('\','/'), "\\?\$($item.Key)")) {
        $flags += "--remap-path-prefix=$sourcePrefix=$($item.Value)"
    }
}
$env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]31
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_PROFILE_RELEASE_STRIP = 'symbols'
$env:CARGO_PROFILE_RELEASE_DEBUG = '0'
$env:SOURCE_DATE_EPOCH = '315532800'
& cargo build --release --locked --target $triple -p c5isr-server --target-dir (Join-Path $repo 'target/package')
if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
& pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

# Only the named payloads returned by the inspector can enter the archive.
$exe = Join-Path $repo "target/package/$triple/release/c5isr-server.exe"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$env:C5ISR_AUDIT_SID = $identity.User.Value
$env:C5ISR_AUDIT_MACHINE_GUID = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
$inventory = & node (Join-Path $PSScriptRoot 'package-windows.mjs') $exe $sysroot $artifactDir
if ($LASTEXITCODE -ne 0) { throw 'Package inventory or privacy checks failed.' }
$entries = $inventory | ConvertFrom-Json
$archiveName = "C5ISR-Observatory-v$Version-windows-x64.zip"
$output = Join-Path $artifactDir $archiveName
$temporary = Join-Path $artifactDir ([IO.Path]::GetRandomFileName() + '.zip')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $stream = [IO.File]::Open($temporary, 'CreateNew', 'ReadWrite', 'None')
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, 'Create')
        try {
            foreach ($item in $entries) {
                $entry = $zip.CreateEntry($item.name, 'Optimal')
                $entry.LastWriteTime = $zipTime
                $entry.ExternalAttributes = 0
                $writer = $entry.Open()
                try {
                    $payload = [IO.File]::OpenRead($item.path)
                    try { $payload.CopyTo($writer) } finally { $payload.Dispose() }
                } finally { $writer.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }

    # Check the actual decompressed ZIP content against the inspected byte hashes.
    $zip = [IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        if ($zip.Entries.Count -ne $entries.Count) { throw 'Archive entry count mismatch.' }
        foreach ($item in $entries) {
            $entry = $zip.GetEntry($item.name)
            if (!$entry) { throw "Missing archive entry $($item.name)." }
            $reader = $entry.Open()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($reader)).Replace('-','') }
            finally { $reader.Dispose() }
            if ($hash -ne $item.sha256) { throw "Archive verification failed for $($item.name)." }
        }
    } finally { $zip.Dispose() }
    if ([IO.File]::Exists($output)) {
        [IO.File]::Replace($temporary, $output, [NullString]::Value)
    } else {
        [IO.File]::Move($temporary, $output)
    }
    $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$output.sha256", "$hash  $archiveName`n", [Text.Encoding]::ASCII)
    Write-Output "$archiveName ($($entries.Count) entries) SHA256 $hash"
} finally {
    $sha.Dispose()
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
