param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$OutputRoot,
    [Parameter(Mandatory)][string]$ZipPath
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$install = [IO.Path]::GetFullPath($InstallRoot)
$output = [IO.Path]::GetFullPath($OutputRoot)
$zip = [IO.Path]::GetFullPath($ZipPath)

function Test-SameOrDescendant([string]$candidate, [string]$ancestor) {
    return $candidate.Equals($ancestor, [StringComparison]::OrdinalIgnoreCase) -or
        $candidate.StartsWith($ancestor + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

if (-not (Test-Path -LiteralPath $install -PathType Container)) {
    throw "InstallRoot does not exist: $install"
}
if (-not $output.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside repository: $output"
}
if (-not $zip.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "ZipPath must stay inside repository: $zip"
}
if ((Test-SameOrDescendant $output $install) -or (Test-SameOrDescendant $install $output)) {
    throw "InstallRoot and OutputRoot must not overlap: $install; $output"
}

if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Path $output | Out-Null
Get-ChildItem -LiteralPath $install -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $output -Recurse -Force
}
foreach ($slot in 'launcher','poe1') {
    $slotPath = Join-Path $output "Data/$slot"
    if (Test-Path -LiteralPath $slotPath) {
        Get-ChildItem -LiteralPath $slotPath -Directory | Where-Object Name -ne 'ko-KR' |
            Remove-Item -Recurse -Force
    }
    $targetLocale = Join-Path $slotPath 'ko-KR'
    $sourceLocale = Join-Path $repo "pob-zh-engine/dist/Data/$slot/ko-KR"
    New-Item -ItemType Directory -Path $targetLocale -Force | Out-Null
    Get-ChildItem -LiteralPath $sourceLocale -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $targetLocale -Recurse -Force
    }
}
New-Item -ItemType Directory -Path (Join-Path $output 'Fonts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf') -Destination (Join-Path $output 'Fonts')
Copy-Item -LiteralPath (Join-Path $repo 'pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt') -Destination (Join-Path $output 'Fonts')
Copy-Item -LiteralPath (Join-Path $repo 'pob-zh-engine/dist/pob-zh.ini') -Destination $output
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination $output
Copy-Item -LiteralPath (Join-Path $repo 'NOTICE.md') -Destination $output
$files = @(Get-ChildItem -LiteralPath $output -Recurse -File | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path = $_.FullName.Substring($output.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$zipItems = @(Get-ChildItem -LiteralPath $output -Force | Select-Object -ExpandProperty FullName)
Compress-Archive -Path $zipItems -DestinationPath $zip -CompressionLevel Optimal -Force
$archive = Get-Item -LiteralPath $zip
[ordered]@{
    archive = [ordered]@{ path = $archive.Name; bytes = $archive.Length; sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash }
    files = $files
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$zip.sha256.json" -Encoding utf8NoBOM
