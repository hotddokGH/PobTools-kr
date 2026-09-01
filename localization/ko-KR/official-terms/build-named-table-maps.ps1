$ErrorActionPreference = 'Stop'

$toolRoot = $PSScriptRoot
$projectRoot = Split-Path -Parent (Split-Path -Parent $toolRoot)
$reportRoot = Join-Path $projectRoot 'reports\official-terms\tables'
$config = Get-Content -LiteralPath (Join-Path $toolRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
$clientLogPath = 'C:\Daum Games\Path of Exile\logs\KakaoClient.txt'

$specs = @(
    @{ table = 'ActiveSkills'; nameColumn = 'DisplayedName' },
    @{ table = 'PassiveSkills'; nameColumn = 'Name' },
    @{ table = 'MonsterVarieties'; nameColumn = 'Name' },
    @{ table = 'ClientStrings'; nameColumn = 'Text' },
    @{ table = 'ClientStrings2'; nameColumn = 'Text' }
)

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
    return @{ index = $index; missingId = $missingId }
}

function Get-DistinctNames {
    param(
        [AllowEmptyCollection()][array]$Rows,
        [Parameter(Mandatory)][string]$NameColumn
    )

    $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($row in $Rows) {
        $name = [string]$row[$NameColumn]
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            [void]$names.Add($name)
        }
    }
    return @($names | Sort-Object)
}

$latestLocalPatch = @(Select-String -LiteralPath $clientLogPath -Pattern '/patch/(?<patch>[^/]+)/' -AllMatches) |
    ForEach-Object { $_.Matches } |
    ForEach-Object { $_.Groups['patch'].Value } |
    Select-Object -Last 1

foreach ($spec in $specs) {
    $table = $spec.table
    $nameColumn = $spec.nameColumn
    $englishPath = Join-Path $toolRoot "tables\English\$table.json"
    $koreanPath = Join-Path $toolRoot "tables\Korean\$table.json"
    foreach ($requiredPath in @($englishPath, $koreanPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required export is missing: $requiredPath"
        }
    }

    $englishRows = @(Get-Content -LiteralPath $englishPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable)
    $koreanRows = @(Get-Content -LiteralPath $koreanPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable)
    $englishGrouped = Group-RowsById -Rows $englishRows
    $koreanGrouped = Group-RowsById -Rows $koreanRows

    $idSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($id in $englishGrouped.index.Keys) { [void]$idSet.Add($id) }
    foreach ($id in $koreanGrouped.index.Keys) { [void]$idSet.Add($id) }
    $allIds = @($idSet | Sort-Object)

    $candidates = [System.Collections.Generic.List[hashtable]]::new()
    $conflicts = [System.Collections.Generic.List[hashtable]]::new()
    $unmatched = [System.Collections.Generic.List[hashtable]]::new()

    foreach ($row in $englishGrouped.missingId) {
        $unmatched.Add(@{ id = $null; english = [string]$row[$nameColumn]; korean = $null; sourceIndex = $row['_index']; reason = 'english row has no stable Id' })
    }
    foreach ($row in $koreanGrouped.missingId) {
        $unmatched.Add(@{ id = $null; english = $null; korean = [string]$row[$nameColumn]; sourceIndex = $row['_index']; reason = 'korean row has no stable Id' })
    }

    foreach ($id in $allIds) {
        $englishForId = if ($englishGrouped.index.ContainsKey($id)) { @($englishGrouped.index[$id]) } else { @() }
        $koreanForId = if ($koreanGrouped.index.ContainsKey($id)) { @($koreanGrouped.index[$id]) } else { @() }
        $englishNames = @(Get-DistinctNames -Rows $englishForId -NameColumn $nameColumn)
        $koreanNames = @(Get-DistinctNames -Rows $koreanForId -NameColumn $nameColumn)

        if ($englishNames.Count -eq 1 -and $koreanNames.Count -eq 1) {
            $candidates.Add(@{ id = $id; english = $englishNames[0]; korean = $koreanNames[0] })
        }
        elseif ($englishNames.Count -gt 1 -or $koreanNames.Count -gt 1) {
            $conflicts.Add(@{ id = $id; english = $englishNames; korean = $koreanNames; reason = 'one stable Id has multiple displayed names in a language' })
        }
        else {
            $reason = if ($englishNames.Count -eq 0 -and $koreanNames.Count -eq 0) {
                'both displayed names are empty'
            }
            elseif ($englishNames.Count -eq 0) {
                'english displayed name is missing'
            }
            else {
                'korean displayed name is missing'
            }
            $unmatched.Add(@{
                id = $id
                english = if ($englishNames.Count -eq 1) { $englishNames[0] } else { $null }
                korean = if ($koreanNames.Count -eq 1) { $koreanNames[0] } else { $null }
                reason = $reason
            })
        }
    }

    $ambiguousEnglish = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
    foreach ($group in @($candidates | Group-Object { $_['english'] } -CaseSensitive)) {
        $koreanNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        foreach ($row in $group.Group) { [void]$koreanNames.Add([string]$row['korean']) }
        if ($koreanNames.Count -gt 1) {
            $ambiguousEnglish[$group.Name] = @($koreanNames | Sort-Object)
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
    $tableReportRoot = Join-Path $reportRoot $table
    [System.IO.Directory]::CreateDirectory($tableReportRoot) | Out-Null

    $manifest = [ordered]@{
        source = 'official Path of Exile patch data'
        patch = [string]$config['patch']
        table = $table
        idColumn = 'Id'
        nameColumn = $nameColumn
        languages = [ordered]@{ english = 'Data'; korean = 'Data/Korean' }
        tool = [ordered]@{ name = 'pathofexile-dat'; version = '15.2.0'; license = 'MIT' }
        clientEvidence = [ordered]@{
            log = $clientLogPath
            detectedPatch = [string]$latestLocalPatch
            matchesExportPatch = ([string]$latestLocalPatch -eq [string]$config['patch'])
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
    $reports = @(
        @{ name = 'manifest.json'; value = $manifest },
        @{ name = 'accepted.json'; value = [ordered]@{ patch = [string]$config['patch']; table = $table; join = 'Id'; nameColumn = $nameColumn; rows = $acceptedSorted } },
        @{ name = 'conflicts.json'; value = [ordered]@{ patch = [string]$config['patch']; table = $table; rows = $conflictsSorted } },
        @{ name = 'unmatched.json'; value = [ordered]@{ patch = [string]$config['patch']; table = $table; rows = $unmatchedSorted } }
    )
    foreach ($report in $reports) {
        $path = Join-Path $tableReportRoot $report.name
        $json = $report.value | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($path, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    }
    Write-Host "${table}: $($acceptedSorted.Count) accepted, $($conflictsSorted.Count) conflicts, $($unmatchedSorted.Count) unmatched" -ForegroundColor Green
}
