$ErrorActionPreference = 'Stop'

$toolRoot = $PSScriptRoot
$repositoryRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $toolRoot))
$runtimeRoot = Join-Path $repositoryRoot 'pob-zh-engine\dist'
$projectRoot = $repositoryRoot
$reportRoot = Join-Path $projectRoot 'reports\official-terms\tables'

$specs = @(
    @{ table = 'ActiveSkills'; nameColumn = 'DisplayedName'; locale = 'gems' },
    @{ table = 'PassiveSkills'; nameColumn = 'Name'; locale = 'passives' },
    @{ table = 'MonsterVarieties'; nameColumn = 'Name'; locale = 'monsters' }
)

foreach ($spec in $specs) {
    $acceptedPath = Join-Path $reportRoot ("$($spec.table)\accepted.json")
    $referencePath = Join-Path $runtimeRoot ("Data\poe1\zh-rTW\$($spec.locale).json")
    $targetPath = Join-Path $runtimeRoot ("Data\poe1\ko-KR\$($spec.locale).json")
    foreach ($requiredPath in @($acceptedPath, $referencePath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required input is missing: $requiredPath"
        }
    }

    $accepted = Get-Content -LiteralPath $acceptedPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $reference = Get-Content -LiteralPath $referencePath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $officialRows = @($accepted['rows'])
    $sourceFiles = @(
        "official PoE patch $($accepted['patch']): Data/$($spec.table).datc64 ($($spec.nameColumn))",
        "official PoE patch $($accepted['patch']): Data/Korean/$($spec.table).datc64 ($($spec.nameColumn))"
    )
    if ($spec.locale -eq 'gems') {
        $baseAcceptedPath = Join-Path (Split-Path -Parent $reportRoot) 'accepted.json'
        if (-not (Test-Path -LiteralPath $baseAcceptedPath -PathType Leaf)) {
            throw "Required input is missing: $baseAcceptedPath"
        }
        $baseAccepted = Get-Content -LiteralPath $baseAcceptedPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        $officialRows += @($baseAccepted['rows'])
        $sourceFiles += @(
            "official PoE patch $($baseAccepted['patch']): Data/BaseItemTypes.datc64 (Name)",
            "official PoE patch $($baseAccepted['patch']): Data/Korean/BaseItemTypes.datc64 (Name)"
        )
    }

    $officialCandidates = [System.Collections.Generic.Dictionary[string,System.Collections.Generic.HashSet[string]]]::new([System.StringComparer]::Ordinal)
    foreach ($row in $officialRows) {
        $english = [string]$row['english']
        $korean = [string]$row['korean']
        if (-not $officialCandidates.ContainsKey($english)) {
            $officialCandidates[$english] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        }
        [void]$officialCandidates[$english].Add($korean)
    }
    $officialByEnglish = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
    foreach ($pair in $officialCandidates.GetEnumerator()) {
        if ($pair.Value.Count -eq 1) {
            $officialByEnglish[$pair.Key] = @($pair.Value)[0]
        }
    }
    if ($spec.locale -eq 'passives') {
        $officialReportRoot = Split-Path -Parent $reportRoot
        $supplementPaths = @(
            (Join-Path $officialReportRoot 'stat-descriptions\accepted.json'),
            (Join-Path $reportRoot 'ClientStrings\accepted.json'),
            (Join-Path $reportRoot 'ClientStrings2\accepted.json')
        )
        $supplementCandidates = [System.Collections.Generic.Dictionary[string,System.Collections.Generic.HashSet[string]]]::new([System.StringComparer]::Ordinal)
        foreach ($supplementPath in $supplementPaths) {
            if (-not (Test-Path -LiteralPath $supplementPath -PathType Leaf)) {
                throw "Required input is missing: $supplementPath"
            }
            $supplement = Get-Content -LiteralPath $supplementPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
            foreach ($row in @($supplement['rows'])) {
                $english = [string]$row['english']
                if (-not $supplementCandidates.ContainsKey($english)) {
                    $supplementCandidates[$english] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
                }
                [void]$supplementCandidates[$english].Add([string]$row['korean'])
            }
        }
        foreach ($pair in $supplementCandidates.GetEnumerator()) {
            if ($pair.Value.Count -eq 1 -and -not $officialByEnglish.ContainsKey($pair.Key)) {
                $officialByEnglish[$pair.Key] = @($pair.Value)[0]
            }
        }
        $sourceFiles += @(
            "official PoE patch $($accepted['patch']): RePoE English/Korean stat_translations.min.json",
            "official PoE patch $($accepted['patch']): Data English/Korean ClientStrings.datc64 and ClientStrings2.datc64"
        )
    }

    $entries = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
    foreach ($key in $reference['entries'].Keys) {
        if ($officialByEnglish.ContainsKey($key)) {
            $entries[$key] = $officialByEnglish[$key]
        }
    }

    $output = [ordered]@{
        source_files = $sourceFiles
        is_base_items = $false
        entries = $entries
    }
    $json = $output | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($targetPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-Host "$($spec.locale).json: wrote $($entries.Count) exact official $($spec.table) mappings" -ForegroundColor Green
}
