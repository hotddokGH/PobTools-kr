$ErrorActionPreference = 'Stop'

$toolRoot = $PSScriptRoot
$projectRoot = Split-Path -Parent (Split-Path -Parent $toolRoot)
$acceptedPath = Join-Path $projectRoot 'reports\official-terms\accepted.json'
$referencePath = Join-Path $projectRoot 'Data\poe1\zh-rTW\items.json'
$targetPath = Join-Path $projectRoot 'Data\poe1\ko-KR\items.json'

foreach ($requiredPath in @($acceptedPath, $referencePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required input is missing: $requiredPath"
    }
}

$accepted = Get-Content -LiteralPath $acceptedPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
$reference = Get-Content -LiteralPath $referencePath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
$officialByEnglish = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)

foreach ($row in @($accepted['rows'])) {
    $english = [string]$row['english']
    $korean = [string]$row['korean']
    if ($officialByEnglish.ContainsKey($english) -and $officialByEnglish[$english] -ne $korean) {
        throw "Refusing to apply ambiguous official mapping for '$english'"
    }
    $officialByEnglish[$english] = $korean
}

$entries = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
foreach ($key in $reference['entries'].Keys) {
    if ($officialByEnglish.ContainsKey($key)) {
        $entries[$key] = $officialByEnglish[$key]
    }
}

$output = [ordered]@{
    source_files = @(
        "official PoE patch $($accepted['patch']): Data/BaseItemTypes.datc64",
        "official PoE patch $($accepted['patch']): Data/Korean/BaseItemTypes.datc64"
    )
    is_base_items = $true
    entries = $entries
}

$json = $output | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($targetPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $($entries.Count) exact official item mappings to $targetPath" -ForegroundColor Green
