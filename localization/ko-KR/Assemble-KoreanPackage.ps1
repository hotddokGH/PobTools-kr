param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$AssetRoot,
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][string]$ZipPath
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$install = [IO.Path]::GetFullPath($InstallRoot)
$assets = [IO.Path]::GetFullPath($AssetRoot)
$output = [IO.Path]::GetFullPath($OutputRoot)
$zip = [IO.Path]::GetFullPath($ZipPath)

function Test-SameOrDescendant([string]$candidate, [string]$ancestor) {
    return $candidate.Equals($ancestor, [StringComparison]::OrdinalIgnoreCase) -or
        $candidate.StartsWith($ancestor + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-Reparse([IO.FileSystemInfo]$item) {
    return ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}

function Assert-RegularDirectory([string]$path, [string]$label) {
    if (-not (Test-Path -LiteralPath $path)) { throw "$label does not exist: $path" }
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.PSIsContainer -or (Test-Reparse $item)) {
        throw "$label must be a regular directory without reparse points: $path"
    }
}

function Assert-SafeSource([string]$root, [string]$relative, [bool]$directory = $false) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not (Test-SameOrDescendant $candidate $root) -or $candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Asset path escapes AssetRoot: $relative"
    }
    $cursor = $root
    foreach ($segment in ($relative -split '[/\\]')) {
        $cursor = Join-Path $cursor $segment
        if (-not (Test-Path -LiteralPath $cursor)) { throw "Missing package source: $relative" }
        $item = Get-Item -LiteralPath $cursor -Force
        if (Test-Reparse $item) { throw "Package source contains a reparse point: $relative" }
    }
    $leaf = Get-Item -LiteralPath $candidate -Force
    if ($directory -and -not $leaf.PSIsContainer) { throw "Package source must be a directory: $relative" }
    if (-not $directory -and $leaf.PSIsContainer) { throw "Package source must be a file: $relative" }
    return $candidate
}

function Assert-NoReparseTree([string]$root, [string]$label) {
    Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object {
        if (Test-Reparse $_) { throw "$label contains a reparse point: $($_.FullName)" }
    }
}

function Assert-SafeOutputPath([string]$path, [string]$label, [bool]$allowDirectory) {
    if (-not (Test-SameOrDescendant $path $repo) -or $path.Equals($repo, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$label must stay inside repository: $path"
    }
    $relative = $path.Substring($repo.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $cursor = $repo
    foreach ($segment in ($relative -split '[/\\]')) {
        $cursor = Join-Path $cursor $segment
        if (-not (Test-Path -LiteralPath $cursor)) { break }
        $item = Get-Item -LiteralPath $cursor -Force
        if (Test-Reparse $item) { throw "$label path contains a reparse point: $path" }
        if (-not $item.PSIsContainer -and -not $cursor.Equals($path, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$label ancestor must be a directory: $path"
        }
    }
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
        if ((Test-Reparse $item) -or ($allowDirectory -and -not $item.PSIsContainer) -or (-not $allowDirectory -and $item.PSIsContainer)) {
            throw "$label has an unsafe existing type: $path"
        }
    }
}

function Remove-PreviewArtifact([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Preview artifact path must be a file: $path"
    }
    Remove-Item -LiteralPath $path -Force
}

Assert-RegularDirectory $install 'InstallRoot'
Assert-RegularDirectory $assets 'AssetRoot'
Assert-NoReparseTree $install 'InstallRoot'
Assert-SafeOutputPath $output 'OutputRoot' $true
Assert-SafeOutputPath $zip 'ZipPath' $false
Assert-SafeOutputPath "$zip.sha256.json" 'manifest path' $false
if ((Test-SameOrDescendant $output $install) -or (Test-SameOrDescendant $install $output)) {
    throw "InstallRoot and OutputRoot must not overlap: $install; $output"
}
if ((Test-SameOrDescendant $output $assets) -or (Test-SameOrDescendant $assets $output)) {
    throw "AssetRoot and OutputRoot must not overlap: $assets; $output"
}
if ((Test-SameOrDescendant $zip $install) -or (Test-SameOrDescendant $zip $assets) -or (Test-SameOrDescendant $zip $output)) {
    throw "ZipPath must not be inside InstallRoot, AssetRoot, or OutputRoot: $zip"
}

$assetSources = [ordered]@{}
foreach ($slot in 'launcher','poe1') {
    $assetSources[$slot] = Assert-SafeSource $assets "dist/Data/$slot/ko-KR" $true
    Assert-NoReparseTree $assetSources[$slot] "AssetRoot dist/Data/$slot/ko-KR"
}
$assetSources['font'] = Assert-SafeSource $assets 'dist/Fonts/NotoSansKR-Variable.ttf'
$assetSources['ofl'] = Assert-SafeSource $assets 'dist/Fonts/OFL-NotoSansKR.txt'
$assetSources['ini'] = Assert-SafeSource $assets 'dist/pob-zh.ini'
$trustedSources = [ordered]@{
    license = Assert-SafeSource $repo 'LICENSE'
    notice = Assert-SafeSource $repo 'NOTICE.md'
    install = Assert-SafeSource $repo 'docs/ko-KR/INSTALL.md'
    preview = Assert-SafeSource $repo 'docs/ko-KR/PREVIEW-NOTES.md'
}

Remove-PreviewArtifact $zip
Remove-PreviewArtifact "$zip.sha256.json"
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Path $output | Out-Null
Get-ChildItem -LiteralPath $install -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $output -Recurse -Force
}
$forbiddenOutputPaths = @(
    'Data/poe2',
    'Path of Building Community',
    'PobTools',
    'tools',
    'reports',
    'tests',
    'node_modules',
    'cache',
    'logs',
    'translate_misses.log',
    'MalgunGothic-TestOnly.ttf'
)
foreach ($relative in $forbiddenOutputPaths) {
    $path = Join-Path $output $relative
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}
foreach ($slot in 'launcher','poe1') {
    $slotPath = Join-Path $output "Data/$slot"
    if (Test-Path -LiteralPath $slotPath) {
        Get-ChildItem -LiteralPath $slotPath -Directory | Where-Object Name -ne 'ko-KR' |
            Remove-Item -Recurse -Force
    }
    $targetLocale = Join-Path $slotPath 'ko-KR'
    $sourceLocale = $assetSources[$slot]
    if (Test-Path -LiteralPath $targetLocale) {
        Remove-Item -LiteralPath $targetLocale -Recurse -Force
    }
    New-Item -ItemType Directory -Path $targetLocale -Force | Out-Null
    Get-ChildItem -LiteralPath $sourceLocale -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $targetLocale -Recurse -Force
    }
}
New-Item -ItemType Directory -Path (Join-Path $output 'Fonts') -Force | Out-Null
Copy-Item -LiteralPath $assetSources['font'] -Destination (Join-Path $output 'Fonts')
Copy-Item -LiteralPath $assetSources['ofl'] -Destination (Join-Path $output 'Fonts')
Copy-Item -LiteralPath $assetSources['ini'] -Destination $output
Copy-Item -LiteralPath $trustedSources['license'] -Destination $output
Copy-Item -LiteralPath $trustedSources['notice'] -Destination $output
Copy-Item -LiteralPath $trustedSources['install'] -Destination (Join-Path $output 'INSTALL-KO.md')
Copy-Item -LiteralPath $trustedSources['preview'] -Destination (Join-Path $output 'PREVIEW-NOTES-KO.md')
$relativeFiles = [string[]]@(Get-ChildItem -LiteralPath $output -Recurse -File | ForEach-Object {
    $_.FullName.Substring($output.Length + 1).Replace('\','/')
})
[Array]::Sort($relativeFiles, [StringComparer]::Ordinal)
$files = @($relativeFiles | ForEach-Object {
    [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $output $_) -Algorithm SHA256).Hash }
})
$zipItems = @(Get-ChildItem -LiteralPath $output -Force | Select-Object -ExpandProperty FullName)
Compress-Archive -Path $zipItems -DestinationPath $zip -CompressionLevel Optimal -Force
$archive = Get-Item -LiteralPath $zip
[ordered]@{
    archive = [ordered]@{ path = $archive.Name; bytes = $archive.Length; sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash }
    files = $files
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$zip.sha256.json" -Encoding utf8NoBOM
