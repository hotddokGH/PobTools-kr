param(
    [Parameter(Mandatory)][string]$ZipPath,
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$RunnerTemp
)

$ErrorActionPreference = 'Stop'
$zip = [IO.Path]::GetFullPath($ZipPath)
$manifestFile = [IO.Path]::GetFullPath($ManifestPath)
$runner = [IO.Path]::GetFullPath($RunnerTemp)
$extract = [IO.Path]::GetFullPath((Join-Path $runner 'pobtools-ko-package'))
$packageTest = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Test-KoreanPackage.ps1'))

function Test-SameOrDescendant([string]$candidate, [string]$ancestor) {
    return $candidate.Equals($ancestor, [StringComparison]::OrdinalIgnoreCase) -or
        $candidate.StartsWith($ancestor + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-Reparse([IO.FileSystemInfo]$item) {
    return ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}

function Assert-RegularLeaf([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path)) { throw "$label does not exist: $path" }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or (Test-Reparse $item)) { throw "$label must be a regular file without reparse points: $path" }
}

function Assert-RegularDirectory([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path)) { throw "$label does not exist: $path" }
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.PSIsContainer -or (Test-Reparse $item)) { throw "$label must be a regular directory without reparse points: $path" }
}

function Assert-ExactProperties([object]$value, [string[]]$expected, [string]$label) {
    if ($null -eq $value) { throw "$label must be an object" }
    $actual = @($value.PSObject.Properties.Name)
    if ($actual.Count -ne $expected.Count) { throw "$label keys must be exactly $($expected -join ', ')" }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ($actual[$index] -cne $expected[$index]) { throw "$label keys must be exactly $($expected -join ', ')" }
    }
}

function Assert-NormalizedRelativePath([string]$path, [string]$label) {
    if ([string]::IsNullOrEmpty($path) -or $path -match '[\x00-\x1f\x7f-\x9f]' -or
        $path.Contains('\') -or [IO.Path]::IsPathRooted($path) -or $path.StartsWith('/') -or
        $path -match '^[A-Za-z]:' -or $path.StartsWith('//')) {
        throw "$label must be a normalized relative path: $path"
    }
    $segments = @($path -split '/')
    if (@($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) {
        throw "$label contains an unsafe segment: $path"
    }
}

function Get-OrdinalSorted([string[]]$values) {
    $copy = [string[]]@($values)
    [Array]::Sort($copy, [StringComparer]::Ordinal)
    return $copy
}

function Assert-NoReparseTree([string]$root, [string]$label) {
    Assert-RegularDirectory $root $label
    Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object {
        if (Test-Reparse $_) { throw "$label contains a reparse point: $($_.FullName)" }
    }
}

function Remove-SafeExtract {
    if (-not (Test-Path -LiteralPath $extract)) { return }
    if (-not (Test-SameOrDescendant $extract $runner) -or $extract.Equals($runner, [StringComparison]::OrdinalIgnoreCase)) {
        throw "extract path is not a strict RunnerTemp descendant: $extract"
    }
    Assert-NoReparseTree $extract 'extract directory'
    Remove-Item -LiteralPath $extract -Recurse -Force
}

Assert-RegularDirectory $runner 'RunnerTemp'
if (-not (Test-SameOrDescendant $extract $runner) -or $extract.Equals($runner, [StringComparison]::OrdinalIgnoreCase)) {
    throw "extract path must be a strict RunnerTemp descendant: $extract"
}
Assert-RegularLeaf $zip 'ZIP'
Assert-RegularLeaf $manifestFile 'manifest'
Assert-RegularLeaf $packageTest 'package contract'

try {
    try {
        $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch { throw "manifest must be valid UTF-8 JSON: $($_.Exception.Message)" }
    Assert-ExactProperties $manifest @('archive','files') 'manifest'
    Assert-ExactProperties $manifest.archive @('path','bytes','sha256') 'manifest archive'
    if ($manifest.archive.path -cne ([IO.Path]::GetFileName($zip))) { throw 'manifest archive path does not match ZIP name' }
    if (-not ($manifest.archive.bytes -is [byte] -or $manifest.archive.bytes -is [int16] -or
        $manifest.archive.bytes -is [int32] -or $manifest.archive.bytes -is [int64]) -or $manifest.archive.bytes -lt 1) {
        throw 'manifest archive bytes must be a positive integer'
    }
    if ($manifest.archive.sha256 -cnotmatch '^[0-9A-F]{64}$') { throw 'manifest archive SHA-256 is malformed' }
    $zipItem = Get-Item -LiteralPath $zip -Force
    if ($zipItem.Length -ne [long]$manifest.archive.bytes) { throw 'archive bytes do not match the ZIP' }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -cne $manifest.archive.sha256) {
        throw 'archive SHA-256 does not match the ZIP'
    }
    if ($manifest.files -isnot [Array]) { throw 'manifest files must be an array' }
    $manifestPaths = [Collections.Generic.List[string]]::new()
    $manifestHashes = @{}
    $foldedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $previous = $null
    foreach ($row in @($manifest.files)) {
        Assert-ExactProperties $row @('path','sha256') 'manifest file row'
        Assert-NormalizedRelativePath $row.path 'manifest file path'
        if ($row.sha256 -cnotmatch '^[0-9A-F]{64}$') { throw "manifest file SHA-256 is malformed: $($row.path)" }
        if (-not $foldedPaths.Add($row.path)) { throw "manifest file path is duplicated: $($row.path)" }
        if ($null -ne $previous -and [StringComparer]::Ordinal.Compare($previous, $row.path) -ge 0) {
            throw 'manifest file paths must be sorted and unique'
        }
        $manifestPaths.Add($row.path)
        $manifestHashes[$row.path] = $row.sha256
        $previous = $row.path
    }
    if ($manifestPaths.Count -eq 0) { throw 'manifest files must not be empty' }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $zipFiles = [Collections.Generic.List[string]]::new()
        $zipNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            $directory = $name.EndsWith('/')
            $normalizedName = if ($directory) { $name.TrimEnd('/') } else { $name }
            Assert-NormalizedRelativePath $normalizedName 'ZIP entry path'
            if (-not $zipNames.Add($normalizedName)) { throw "ZIP entry path is duplicated: $normalizedName" }
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            $windowsReparse = (($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0)
            if ($unixType -eq 0xA000 -or $windowsReparse) { throw "ZIP entry is a reparse point: $normalizedName" }
            if (-not $directory) { $zipFiles.Add($normalizedName) }
        }
        $sortedZipFiles = Get-OrdinalSorted $zipFiles.ToArray()
        if ($sortedZipFiles.Count -ne $manifestPaths.Count) { throw 'ZIP has extra or missing files compared with the manifest' }
        for ($index = 0; $index -lt $manifestPaths.Count; $index++) {
            if ($sortedZipFiles[$index] -cne $manifestPaths[$index]) { throw 'ZIP has extra or missing files compared with the manifest' }
        }
    }
    finally { $archive.Dispose() }

    Remove-SafeExtract
    New-Item -ItemType Directory -Path $extract | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $extract
    Assert-NoReparseTree $extract 'extracted package'

    & pwsh -NoProfile -File $packageTest -PackageRoot $extract
    if ($LASTEXITCODE -ne 0) { throw "extracted package contract failed with exit code $LASTEXITCODE" }

    $actualRows = @(Get-ChildItem -LiteralPath $extract -Recurse -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($extract.Length + 1).Replace('\','/')
        [pscustomobject]@{ path = $relativePath; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
    $actualPaths = Get-OrdinalSorted @($actualRows.path)
    if ($actualPaths.Count -ne $manifestPaths.Count) { throw 'extracted package has extra or missing files' }
    $actualHashes = @{}
    foreach ($row in $actualRows) { $actualHashes[$row.path] = $row.sha256 }
    for ($index = 0; $index -lt $manifestPaths.Count; $index++) {
        $path = $manifestPaths[$index]
        if ($actualPaths[$index] -cne $path -or $actualHashes[$path] -cne $manifestHashes[$path]) {
            throw "extracted package path or SHA-256 mismatch: $path"
        }
    }
    Write-Host 'PASS: Korean package ZIP, manifest, and extracted package are valid.'
}
finally {
    Remove-SafeExtract
}
