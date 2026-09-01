$ErrorActionPreference = 'Stop'

$toolRoot = $PSScriptRoot
$repositoryRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $toolRoot))
$projectRoot = $repositoryRoot
$reportRoot = Join-Path $projectRoot 'reports\official-terms'
$englishPath = Join-Path $toolRoot 'tables\English\BaseItemTypes.json'
$koreanPath = Join-Path $toolRoot 'tables\Korean\BaseItemTypes.json'
$configPath = Join-Path $toolRoot 'config.json'
$clientLogPath = 'C:\Daum Games\Path of Exile\logs\KakaoClient.txt'

foreach ($requiredPath in @($englishPath, $koreanPath, $configPath, $clientLogPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required input is missing: $requiredPath"
    }
}

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
$englishRows = @(Get-Content -LiteralPath $englishPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable)
$koreanRows = @(Get-Content -LiteralPath $koreanPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable)

function Group-RowsById {
    param([Parameter(Mandatory)][array]$Rows)

    $index = [System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[hashtable]]]::new([System.StringComparer]::Ordinal)
    $missingId = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($row in $Rows) {
        $id = [string]$row['Id']
        if ([string]::IsNullOrWhiteSpace($id)) {
            $missingId.Add($row)
            continue
        }
        if (-not $index.ContainsKey($id)) {
            $index[$id] = [System.Collections.Generic.List[hashtable]]::new()
        }
        $index[$id].Add($row)
    }
    return @{
        index = $index
        missingId = $missingId
    }
}

function Get-DistinctNames {
    param([AllowEmptyCollection()][array]$Rows)

    return @(
        $Rows |
            ForEach-Object { [string]$_['Name'] } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object -Unique
    )
}

$englishGrouped = Group-RowsById -Rows $englishRows
$koreanGrouped = Group-RowsById -Rows $koreanRows
$allIds = @($englishGrouped.index.Keys + $koreanGrouped.index.Keys | Sort-Object -Unique)
$candidates = [System.Collections.Generic.List[hashtable]]::new()
$conflicts = [System.Collections.Generic.List[hashtable]]::new()
$unmatched = [System.Collections.Generic.List[hashtable]]::new()

foreach ($row in $englishGrouped.missingId) {
    $unmatched.Add(@{
        id = $null
        english = [string]$row['Name']
        korean = $null
        sourceIndex = $row['_index']
        reason = 'english row has no stable Id'
    })
}
foreach ($row in $koreanGrouped.missingId) {
    $unmatched.Add(@{
        id = $null
        english = $null
        korean = [string]$row['Name']
        sourceIndex = $row['_index']
        reason = 'korean row has no stable Id'
    })
}

foreach ($id in $allIds) {
    $englishForId = if ($englishGrouped.index.ContainsKey($id)) { @($englishGrouped.index[$id]) } else { @() }
    $koreanForId = if ($koreanGrouped.index.ContainsKey($id)) { @($koreanGrouped.index[$id]) } else { @() }
    $englishNames = @(Get-DistinctNames -Rows $englishForId)
    $koreanNames = @(Get-DistinctNames -Rows $koreanForId)

    if ($englishNames.Count -eq 1 -and $koreanNames.Count -eq 1) {
        $candidates.Add(@{
            id = $id
            english = $englishNames[0]
            korean = $koreanNames[0]
        })
        continue
    }

    if ($englishNames.Count -gt 1 -or $koreanNames.Count -gt 1) {
        $conflicts.Add(@{
            id = $id
            english = $englishNames
            korean = $koreanNames
            reason = 'one stable Id has multiple displayed names in a language'
        })
    }
    else {
        $unmatched.Add(@{
            id = $id
            english = if ($englishNames.Count -eq 1) { $englishNames[0] } else { $null }
            korean = if ($koreanNames.Count -eq 1) { $koreanNames[0] } else { $null }
            reason = if ($englishNames.Count -eq 0 -and $koreanNames.Count -eq 0) {
                'both displayed names are empty'
            }
            elseif ($englishNames.Count -eq 0) {
                'english displayed name is missing'
            }
            else {
                'korean displayed name is missing'
            }
        })
    }
}

$ambiguousEnglish = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
foreach ($group in @($candidates | Group-Object { $_['english'] })) {
    $koreanNames = @($group.Group | ForEach-Object { $_['korean'] } | Sort-Object -Unique)
    if ($koreanNames.Count -gt 1) {
        $ambiguousEnglish[$group.Name] = $koreanNames
    }
}

$accepted = [System.Collections.Generic.List[hashtable]]::new()
foreach ($candidate in $candidates) {
    if ($ambiguousEnglish.ContainsKey($candidate['english'])) {
        $conflicts.Add(@{
            id = $candidate['id']
            english = $candidate['english']
            korean = @($ambiguousEnglish[$candidate['english']])
            reason = 'one English lookup key maps to multiple official Korean names'
        })
    }
    else {
        $accepted.Add($candidate)
    }
}

$acceptedSorted = @($accepted | Sort-Object { $_['id'] }, { $_['english'] })
$conflictsSorted = @($conflicts | Sort-Object { [string]$_['id'] }, { [string]$_['english'] })
$unmatchedSorted = @($unmatched | Sort-Object { [string]$_['id'] }, sourceIndex)

$localPatchMatches = @(Select-String -LiteralPath $clientLogPath -Pattern '/patch/(?<patch>[^/]+)/' -AllMatches) |
    ForEach-Object { $_.Matches } |
    ForEach-Object { $_.Groups['patch'].Value } |
    Select-Object -Last 1

$manifest = [ordered]@{
    source = 'official Path of Exile patch data'
    patch = [string]$config['patch']
    table = 'BaseItemTypes'
    idColumn = 'Id'
    nameColumn = 'Name'
    languages = [ordered]@{
        english = 'Data'
        korean = 'Data/Korean'
    }
    tool = [ordered]@{
        name = 'pathofexile-dat'
        version = '15.2.0'
        license = 'MIT'
        npmIntegrity = 'sha512-Jb/xHVhdDvkq34VFgQWBDuR69ugm1fb6sxSd/1GhSD1tqe3tukbosCoVgWzwBDI1HoLk1U4xKuvkjGVGNSndeg=='
    }
    clientEvidence = [ordered]@{
        log = $clientLogPath
        detectedPatch = [string]$localPatchMatches
        matchesExportPatch = ([string]$localPatchMatches -eq [string]$config['patch'])
    }
    inputs = [ordered]@{
        englishRows = $englishRows.Count
        koreanRows = $koreanRows.Count
        stableIds = $allIds.Count
        englishSha256 = (Get-FileHash -LiteralPath $englishPath -Algorithm SHA256).Hash
        koreanSha256 = (Get-FileHash -LiteralPath $koreanPath -Algorithm SHA256).Hash
    }
    counts = [ordered]@{
        accepted = $acceptedSorted.Count
        conflicts = $conflictsSorted.Count
        unmatched = $unmatchedSorted.Count
    }
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
}

$acceptedReport = [ordered]@{
    patch = [string]$config['patch']
    table = 'BaseItemTypes'
    join = 'Id'
    rows = $acceptedSorted
}
$conflictReport = [ordered]@{
    patch = [string]$config['patch']
    table = 'BaseItemTypes'
    rows = $conflictsSorted
}
$unmatchedReport = [ordered]@{
    patch = [string]$config['patch']
    table = 'BaseItemTypes'
    rows = $unmatchedSorted
}

[System.IO.Directory]::CreateDirectory($reportRoot) | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
foreach ($output in @(
    @{ Path = Join-Path $reportRoot 'manifest.json'; Value = $manifest },
    @{ Path = Join-Path $reportRoot 'accepted.json'; Value = $acceptedReport },
    @{ Path = Join-Path $reportRoot 'conflicts.json'; Value = $conflictReport },
    @{ Path = Join-Path $reportRoot 'unmatched.json'; Value = $unmatchedReport }
)) {
    $json = $output.Value | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($output.Path, $json + [Environment]::NewLine, $utf8NoBom)
}

Write-Host "Generated official mapping reports: $($acceptedSorted.Count) accepted, $($conflictsSorted.Count) conflicts, $($unmatchedSorted.Count) unmatched." -ForegroundColor Green
