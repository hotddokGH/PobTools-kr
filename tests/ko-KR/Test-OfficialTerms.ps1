$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$rootPath = Join-Path $repoRoot 'pob-zh-engine\dist'
$reportRoot = Join-Path $repoRoot 'reports\official-terms'
$failures = [System.Collections.Generic.List[string]]::new()

function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $script:failures.Add("Missing file: $Path")
        return $null
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    }
    catch {
        $script:failures.Add("Invalid JSON: $Path ($($_.Exception.Message))")
        return $null
    }
}

function Get-NumberedPlaceholders {
    param([Parameter(Mandatory)][string]$Text)

    return @([regex]::Matches($Text, '\{\d+\}') | ForEach-Object { $_.Value } | Sort-Object)
}

$manifest = Read-JsonFile -Path (Join-Path $reportRoot 'manifest.json')
$accepted = Read-JsonFile -Path (Join-Path $reportRoot 'accepted.json')
$conflicts = Read-JsonFile -Path (Join-Path $reportRoot 'conflicts.json')
$unmatched = Read-JsonFile -Path (Join-Path $reportRoot 'unmatched.json')

if ($null -ne $manifest) {
    if ($manifest['patch'] -ne '3.29.3.2') {
        $failures.Add('Manifest must identify patch 3.29.3.2')
    }
    if ($manifest['table'] -ne 'BaseItemTypes' -or $manifest['idColumn'] -ne 'Id') {
        $failures.Add('Manifest must identify BaseItemTypes.Id as the join identity')
    }
    if ($manifest['languages']['english'] -ne 'Data' -or $manifest['languages']['korean'] -ne 'Data/Korean') {
        $failures.Add('Manifest must identify the English and Korean game-data paths')
    }
    if ($manifest['tool']['name'] -ne 'pathofexile-dat' -or $manifest['tool']['version'] -ne '15.2.0') {
        $failures.Add('Manifest must pin pathofexile-dat 15.2.0')
    }
    if ($manifest['clientEvidence']['matchesExportPatch'] -ne $true) {
        $failures.Add('Manifest must confirm that the local Korean client patch matches the export patch')
    }
}

$acceptedRows = if ($null -ne $accepted) { @($accepted['rows']) } else { @() }
$conflictRows = if ($null -ne $conflicts) { @($conflicts['rows']) } else { @() }
$unmatchedRows = if ($null -ne $unmatched) { @($unmatched['rows']) } else { @() }

if ($null -ne $accepted) {
    if ($accepted['patch'] -ne '3.29.3.2' -or $accepted['table'] -ne 'BaseItemTypes') {
        $failures.Add('Accepted report must identify its patch and table')
    }
    if ($acceptedRows.Count -eq 0) {
        $failures.Add('Accepted report must contain at least one exact official mapping')
    }

    $identities = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $hasHangul = $false
    foreach ($row in $acceptedRows) {
        foreach ($field in @('id', 'english', 'korean')) {
            if (-not $row.ContainsKey($field) -or [string]::IsNullOrWhiteSpace([string]$row[$field])) {
                $failures.Add("Accepted row is missing non-empty field '$field'")
            }
        }
        if ([string]$row['korean'] -match '[가-힣]') {
            $hasHangul = $true
        }
        $identity = "$($row['id'])`u{001F}$($row['english'])"
        if (-not $identities.Add($identity)) {
            $failures.Add("Duplicate accepted identity: $($row['id']) / $($row['english'])")
        }
    }
    if (-not $hasHangul) {
        $failures.Add('Accepted report must contain at least one Hangul official name')
    }
}

foreach ($report in @($conflicts, $unmatched)) {
    if ($null -ne $report -and $report['rows'] -isnot [array]) {
        $failures.Add('Conflict and unmatched reports must contain rows arrays, including when empty')
    }
}

if ($null -ne $manifest -and $manifest.ContainsKey('counts')) {
    if ([int]$manifest['counts']['accepted'] -ne $acceptedRows.Count) {
        $failures.Add('Manifest accepted count does not match accepted.json')
    }
    if ([int]$manifest['counts']['conflicts'] -ne $conflictRows.Count) {
        $failures.Add('Manifest conflict count does not match conflicts.json')
    }
    if ([int]$manifest['counts']['unmatched'] -ne $unmatchedRows.Count) {
        $failures.Add('Manifest unmatched count does not match unmatched.json')
    }
}

$namedTableSpecs = @(
    @{ table = 'ActiveSkills'; nameColumn = 'DisplayedName'; locale = 'gems' },
    @{ table = 'PassiveSkills'; nameColumn = 'Name'; locale = 'passives' },
    @{ table = 'MonsterVarieties'; nameColumn = 'Name'; locale = 'monsters' },
    @{ table = 'ClientStrings'; nameColumn = 'Text' },
    @{ table = 'ClientStrings2'; nameColumn = 'Text' }
)

foreach ($spec in $namedTableSpecs) {
    $tableReportRoot = Join-Path $reportRoot ("tables\" + $spec.table)
    $tableManifest = Read-JsonFile -Path (Join-Path $tableReportRoot 'manifest.json')
    $tableAccepted = Read-JsonFile -Path (Join-Path $tableReportRoot 'accepted.json')
    $tableConflicts = Read-JsonFile -Path (Join-Path $tableReportRoot 'conflicts.json')
    $tableUnmatched = Read-JsonFile -Path (Join-Path $tableReportRoot 'unmatched.json')

    if ($null -eq $tableManifest -or $null -eq $tableAccepted -or $null -eq $tableConflicts -or $null -eq $tableUnmatched) {
        continue
    }

    if ($tableManifest['patch'] -ne '3.29.3.2' -or $tableManifest['table'] -ne $spec.table) {
        $failures.Add("$($spec.table) manifest must identify patch 3.29.3.2 and the correct table")
    }
    if ($tableManifest['idColumn'] -ne 'Id' -or $tableManifest['nameColumn'] -ne $spec.nameColumn) {
        $failures.Add("$($spec.table) manifest must identify Id and $($spec.nameColumn)")
    }
    foreach ($field in @('englishSha256', 'koreanSha256')) {
        if ([string]$tableManifest['inputs'][$field] -notmatch '^[0-9A-F]{64}$') {
            $failures.Add("$($spec.table) manifest has no valid $field")
        }
    }

    $tableAcceptedRows = @($tableAccepted['rows'])
    $tableConflictRows = @($tableConflicts['rows'])
    $tableUnmatchedRows = @($tableUnmatched['rows'])
    if ($tableAcceptedRows.Count -eq 0) {
        $failures.Add("$($spec.table) must contain at least one accepted official mapping")
    }
    if ($tableAcceptedRows.Count -gt 0 -and $null -eq ($tableAcceptedRows | Where-Object { [string]$_['korean'] -match '[가-힣]' } | Select-Object -First 1)) {
        $failures.Add("$($spec.table) accepted report must contain Hangul")
    }
    foreach ($row in $tableAcceptedRows) {
        if ([string]::IsNullOrWhiteSpace([string]$row['id']) -or
            [string]::IsNullOrWhiteSpace([string]$row['english']) -or
            [string]::IsNullOrWhiteSpace([string]$row['korean'])) {
            $failures.Add("$($spec.table) accepted rows require non-empty id, english, and korean fields")
            break
        }
    }
    if ($tableConflicts['rows'] -isnot [array] -or $tableUnmatched['rows'] -isnot [array]) {
        $failures.Add("$($spec.table) conflict and unmatched rows must always be arrays")
    }
    if ([int]$tableManifest['counts']['accepted'] -ne $tableAcceptedRows.Count -or
        [int]$tableManifest['counts']['conflicts'] -ne $tableConflictRows.Count -or
        [int]$tableManifest['counts']['unmatched'] -ne $tableUnmatchedRows.Count) {
        $failures.Add("$($spec.table) manifest counts must match its three reports")
    }

    if (-not $spec.ContainsKey('locale')) {
        continue
    }

    $referenceLocale = Read-JsonFile -Path (Join-Path $rootPath ("Data\poe1\zh-rTW\" + $spec.locale + '.json'))
    $koreanLocale = Read-JsonFile -Path (Join-Path $rootPath ("Data\poe1\ko-KR\" + $spec.locale + '.json'))
    if ($null -ne $referenceLocale -and $null -ne $koreanLocale) {
        $officialRows = @($tableAcceptedRows)
        if ($spec.locale -eq 'gems') {
            $officialRows += @($acceptedRows)
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
            $passiveSupplementReports = @(
                (Read-JsonFile -Path (Join-Path $reportRoot 'stat-descriptions\accepted.json')),
                (Read-JsonFile -Path (Join-Path $reportRoot 'tables\ClientStrings\accepted.json')),
                (Read-JsonFile -Path (Join-Path $reportRoot 'tables\ClientStrings2\accepted.json'))
            )
            $supplementCandidates = [System.Collections.Generic.Dictionary[string,System.Collections.Generic.HashSet[string]]]::new([System.StringComparer]::Ordinal)
            foreach ($supplementReport in $passiveSupplementReports) {
                if ($null -eq $supplementReport) { continue }
                foreach ($row in @($supplementReport['rows'])) {
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
        }

        $expectedKeys = @($referenceLocale['entries'].Keys | Where-Object { $officialByEnglish.ContainsKey($_) } | Sort-Object)
        $actualEntries = $koreanLocale['entries']
        if ($actualEntries -isnot [hashtable]) {
            $failures.Add("Korean $($spec.locale).json must contain an entries object")
        }
        else {
            if ($actualEntries.Keys.Count -ne $expectedKeys.Count) {
                $failures.Add("Korean $($spec.locale).json must contain all and only $($expectedKeys.Count) exact $($spec.table) matches; found $($actualEntries.Keys.Count)")
            }
            $missingKeys = @($expectedKeys | Where-Object { -not $actualEntries.ContainsKey($_) })
            $wrongKeys = @($expectedKeys | Where-Object { $actualEntries.ContainsKey($_) -and $actualEntries[$_] -ne $officialByEnglish[$_] })
            if ($missingKeys.Count -gt 0) {
                $failures.Add("Korean $($spec.locale).json is missing $($missingKeys.Count) exact official key(s), including: $(@($missingKeys | Select-Object -First 5) -join ' | ')")
            }
            if ($wrongKeys.Count -gt 0) {
                $failures.Add("Korean $($spec.locale).json differs from $($wrongKeys.Count) official Korean name(s), including: $(@($wrongKeys | Select-Object -First 5) -join ' | ')")
            }
            $expectedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($key in $expectedKeys) { [void]$expectedSet.Add($key) }
            $unexpectedKeys = @($actualEntries.Keys | Where-Object { -not $expectedSet.Contains($_) })
            if ($unexpectedKeys.Count -gt 0) {
                $failures.Add("Korean $($spec.locale).json contains $($unexpectedKeys.Count) key(s) not proven by the $($spec.table) mapping")
            }
        }
    }
}

$statReportRoot = Join-Path $reportRoot 'stat-descriptions'
$statManifest = Read-JsonFile -Path (Join-Path $statReportRoot 'manifest.json')
$statAccepted = Read-JsonFile -Path (Join-Path $statReportRoot 'accepted.json')
$statConflicts = Read-JsonFile -Path (Join-Path $statReportRoot 'conflicts.json')
$statUnmatched = Read-JsonFile -Path (Join-Path $statReportRoot 'unmatched.json')

if ($null -ne $statManifest -and $null -ne $statAccepted -and $null -ne $statConflicts -and $null -ne $statUnmatched) {
    if ($statManifest['patch'] -ne '3.29.3.2' -or $statManifest['identity'] -ne 'ordered stat ids + condition/format/index_handlers') {
        $failures.Add('Stat-description manifest must identify patch 3.29.3.2 and the structural join identity')
    }
    if ($statManifest['clientEvidence']['detectedPatch'] -ne '3.29.3.2' -or $statManifest['clientEvidence']['matchesExportPatch'] -ne $true) {
        $failures.Add('Stat-description manifest must prove that the local Korean client patch matches the export patch')
    }
    foreach ($language in @('english', 'korean')) {
        $source = $statManifest['sources'][$language]
        if ([string]$source['url'] -notmatch '^https://repoe-fork\.github\.io/' -or
            [string]$source['sha256'] -notmatch '^[0-9A-F]{64}$' -or
            [int64]$source['bytes'] -le 0) {
            $failures.Add("Stat-description manifest must pin the $language RePoE URL, hash, and byte size")
        }
    }

    $statAcceptedRows = @($statAccepted['rows'])
    $statConflictRows = @($statConflicts['rows'])
    $statUnmatchedRows = @($statUnmatched['rows'])
    if ($statAcceptedRows.Count -eq 0) {
        $failures.Add('Stat-description report must contain accepted official mappings')
    }

    $statHasHangul = $false
    foreach ($row in $statAcceptedRows) {
        if (@($row['ids']).Count -eq 0 -or
            [string]::IsNullOrWhiteSpace([string]$row['variantIdentity']) -or
            [string]$row['kind'] -notin @('string', 'reminder_text') -or
            [string]::IsNullOrWhiteSpace([string]$row['english']) -or
            [string]::IsNullOrWhiteSpace([string]$row['korean'])) {
            $failures.Add('Every accepted stat mapping requires ids, variantIdentity, kind, english, and korean')
            break
        }
        if ([string]$row['korean'] -match '[가-힣]') {
            $statHasHangul = $true
        }
        $sourcePlaceholders = @(Get-NumberedPlaceholders -Text ([string]$row['english']))
        $targetPlaceholders = @(Get-NumberedPlaceholders -Text ([string]$row['korean']))
        if (($sourcePlaceholders -join '|') -ne ($targetPlaceholders -join '|')) {
            $failures.Add("Official stat placeholder mismatch for '$($row['english'])'")
            break
        }
    }
    if (-not $statHasHangul) {
        $failures.Add('Accepted stat-description mappings must contain Hangul')
    }
    if ($statConflicts['rows'] -isnot [array] -or $statUnmatched['rows'] -isnot [array]) {
        $failures.Add('Stat-description conflict and unmatched rows must always be arrays')
    }
    if ([int]$statManifest['counts']['accepted'] -ne $statAcceptedRows.Count -or
        [int]$statManifest['counts']['conflicts'] -ne $statConflictRows.Count -or
        [int]$statManifest['counts']['unmatched'] -ne $statUnmatchedRows.Count) {
        $failures.Add('Stat-description manifest counts must match its three reports')
    }

    $referenceStats = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\zh-rTW\stats.json')
    $koreanStats = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\ko-KR\stats.json')
    if ($null -ne $referenceStats -and $null -ne $koreanStats) {
        $officialStats = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
        foreach ($row in $statAcceptedRows) {
            $english = [string]$row['english']
            $korean = [string]$row['korean']
            if ($officialStats.ContainsKey($english) -and $officialStats[$english] -ne $korean) {
                $failures.Add("Accepted stat report contains an unresolved English-key conflict: $english")
            }
            else {
                $officialStats[$english] = $korean
            }
        }

        $expectedStatKeys = @($referenceStats['entries'].Keys | Where-Object { $officialStats.ContainsKey($_) } | Sort-Object)
        $actualStatEntries = $koreanStats['entries']
        if ($actualStatEntries -isnot [hashtable]) {
            $failures.Add('Korean stats.json must contain an entries object')
        }
        else {
            if ($actualStatEntries.Keys.Count -ne $expectedStatKeys.Count) {
                $failures.Add("Korean stats.json must contain all and only $($expectedStatKeys.Count) exact official stat matches; found $($actualStatEntries.Keys.Count)")
            }
            $missingStatKeys = @($expectedStatKeys | Where-Object { -not $actualStatEntries.ContainsKey($_) })
            $wrongStatKeys = @($expectedStatKeys | Where-Object { $actualStatEntries.ContainsKey($_) -and $actualStatEntries[$_] -ne $officialStats[$_] })
            if ($missingStatKeys.Count -gt 0) {
                $failures.Add("Korean stats.json is missing $($missingStatKeys.Count) exact official stat key(s), including: $(@($missingStatKeys | Select-Object -First 5) -join ' | ')")
            }
            if ($wrongStatKeys.Count -gt 0) {
                $failures.Add("Korean stats.json differs from $($wrongStatKeys.Count) official Korean stat template(s), including: $(@($wrongStatKeys | Select-Object -First 5) -join ' | ')")
            }
            $expectedStatSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($key in $expectedStatKeys) { [void]$expectedStatSet.Add($key) }
            $unexpectedStatKeys = @($actualStatEntries.Keys | Where-Object { -not $expectedStatSet.Contains($_) })
            if ($unexpectedStatKeys.Count -gt 0) {
                $failures.Add("Korean stats.json contains $($unexpectedStatKeys.Count) key(s) not proven by the official stat mapping")
            }
        }
    }
}

$clientStringsAccepted = Read-JsonFile -Path (Join-Path $reportRoot 'tables\ClientStrings\accepted.json')
$clientStrings2Accepted = Read-JsonFile -Path (Join-Path $reportRoot 'tables\ClientStrings2\accepted.json')
$statUiAccepted = Read-JsonFile -Path (Join-Path $reportRoot 'stat-descriptions\accepted.json')
$manualPobUi = Read-JsonFile -Path (Join-Path $repoRoot 'localization\ko-KR\official-terms\manual-pob-ui.json')
$referenceUi = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\zh-rTW\ui.json')
$koreanUi = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\ko-KR\ui.json')

if ($null -ne $clientStringsAccepted -and $null -ne $clientStrings2Accepted -and $null -ne $statUiAccepted -and $null -ne $manualPobUi -and $null -ne $referenceUi -and $null -ne $koreanUi) {
    if ($manualPobUi['entries'].Keys.Count -ne 268) {
        $failures.Add("Manual PoB UI review set must contain exactly 268 entries; found $($manualPobUi['entries'].Keys.Count)")
    }
    $reviewedSource = @($manualPobUi['reviewed_sources'] | Where-Object {
        $_['repository'] -eq 'https://github.com/antonio-kim-77/PathOfBuilding-kor' -and
        $_['commit'] -eq '72555c9d5e54c66a3b064c8dc38a30e8dcb06b43'
    })
    if ($reviewedSource.Count -ne 1) {
        $failures.Add('Manual PoB UI review set must pin its Korean-fork wording reference repository and commit')
    }

    $officialUiCandidates = [System.Collections.Generic.Dictionary[string,System.Collections.Generic.HashSet[string]]]::new([System.StringComparer]::Ordinal)
    foreach ($row in @($clientStringsAccepted['rows']) + @($clientStrings2Accepted['rows']) + @($statUiAccepted['rows'])) {
        $english = [string]$row['english']
        if (-not $officialUiCandidates.ContainsKey($english)) {
            $officialUiCandidates[$english] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        }
        [void]$officialUiCandidates[$english].Add([string]$row['korean'])
    }

    $safeOfficialUi = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
    foreach ($pair in $officialUiCandidates.GetEnumerator()) {
        if ($pair.Value.Count -eq 1) {
            $safeOfficialUi[$pair.Key] = @($pair.Value)[0]
        }
    }

    $uiSupplementReports = @(
        $accepted,
        (Read-JsonFile -Path (Join-Path $reportRoot 'tables\ActiveSkills\accepted.json')),
        (Read-JsonFile -Path (Join-Path $reportRoot 'tables\PassiveSkills\accepted.json')),
        (Read-JsonFile -Path (Join-Path $reportRoot 'tables\MonsterVarieties\accepted.json')),
        (Read-JsonFile -Path (Join-Path $reportRoot 'unique-items\accepted.json')),
        (Read-JsonFile -Path (Join-Path $reportRoot 'mod-names\accepted.json'))
    )
    $uiSupplementCandidates = [System.Collections.Generic.Dictionary[string,System.Collections.Generic.HashSet[string]]]::new([System.StringComparer]::Ordinal)
    foreach ($supplementReport in $uiSupplementReports) {
        if ($null -eq $supplementReport) { continue }
        foreach ($row in @($supplementReport['rows'])) {
            $english = [string]$row['english']
            if (-not $uiSupplementCandidates.ContainsKey($english)) {
                $uiSupplementCandidates[$english] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            }
            [void]$uiSupplementCandidates[$english].Add([string]$row['korean'])
        }
    }
    foreach ($pair in $uiSupplementCandidates.GetEnumerator()) {
        if ($pair.Value.Count -eq 1 -and -not $safeOfficialUi.ContainsKey($pair.Key)) {
            $safeOfficialUi[$pair.Key] = @($pair.Value)[0]
        }
    }

    $expectedUi = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
    foreach ($key in $referenceUi['entries'].Keys) {
        if ($safeOfficialUi.ContainsKey($key)) {
            $expectedUi[$key] = $safeOfficialUi[$key]
        }
    }
    foreach ($pair in $manualPobUi['entries'].GetEnumerator()) {
        $expectedUi[$pair.Key] = [string]$pair.Value
    }

    $actualUiEntries = $koreanUi['entries']
    if ($actualUiEntries -isnot [hashtable]) {
        $failures.Add('Korean ui.json must contain an entries object')
    }
    else {
        if ($actualUiEntries.Keys.Count -ne $expectedUi.Keys.Count) {
            $failures.Add("Korean ui.json must contain all and only $($expectedUi.Keys.Count) exact official-plus-manual UI mappings; found $($actualUiEntries.Keys.Count)")
        }
        $missingUiKeys = @($expectedUi.Keys | Where-Object { -not $actualUiEntries.ContainsKey($_) })
        $wrongUiKeys = @($expectedUi.Keys | Where-Object { $actualUiEntries.ContainsKey($_) -and $actualUiEntries[$_] -ne $expectedUi[$_] })
        if ($missingUiKeys.Count -gt 0) {
            $failures.Add("Korean ui.json is missing $($missingUiKeys.Count) UI key(s), including: $(@($missingUiKeys | Select-Object -First 5) -join ' | ')")
        }
        if ($wrongUiKeys.Count -gt 0) {
            $failures.Add("Korean ui.json differs from $($wrongUiKeys.Count) expected UI value(s), including: $(@($wrongUiKeys | Select-Object -First 5) -join ' | ')")
        }
        $unexpectedUiKeys = @($actualUiEntries.Keys | Where-Object { -not $expectedUi.ContainsKey($_) })
        if ($unexpectedUiKeys.Count -gt 0) {
            $failures.Add("Korean ui.json contains $($unexpectedUiKeys.Count) UI key(s) outside the deterministic official-plus-manual set")
        }
    }
}

$uniqueReportRoot = Join-Path $reportRoot 'unique-items'
$uniqueManifest = Read-JsonFile -Path (Join-Path $uniqueReportRoot 'manifest.json')
$uniqueAccepted = Read-JsonFile -Path (Join-Path $uniqueReportRoot 'accepted.json')
$uniqueConflicts = Read-JsonFile -Path (Join-Path $uniqueReportRoot 'conflicts.json')
$uniqueUnmatched = Read-JsonFile -Path (Join-Path $uniqueReportRoot 'unmatched.json')

if ($null -ne $uniqueManifest -and $null -ne $uniqueAccepted -and $null -ne $uniqueConflicts -and $null -ne $uniqueUnmatched) {
    if ($uniqueManifest['patch'] -ne '3.29.3.2' -or $uniqueManifest['identity'] -ne 'unique item id') {
        $failures.Add('Unique-item manifest must identify patch 3.29.3.2 and the item id join')
    }
    foreach ($language in @('english', 'korean')) {
        $source = $uniqueManifest['sources'][$language]
        if ([string]$source['url'] -notmatch '^https://repoe-fork\.github\.io/' -or
            [string]$source['sha256'] -notmatch '^[0-9A-F]{64}$' -or
            [int64]$source['bytes'] -le 0) {
            $failures.Add("Unique-item manifest must pin the $language URL, hash, and byte size")
        }
    }

    $uniqueAcceptedRows = @($uniqueAccepted['rows'])
    $uniqueConflictRows = @($uniqueConflicts['rows'])
    $uniqueUnmatchedRows = @($uniqueUnmatched['rows'])
    if ($uniqueAcceptedRows.Count -eq 0 -or $null -eq ($uniqueAcceptedRows | Where-Object { [string]$_['korean'] -match '[가-힣]' } | Select-Object -First 1)) {
        $failures.Add('Unique-item report must contain accepted Hangul mappings')
    }
    foreach ($row in $uniqueAcceptedRows) {
        if ([string]::IsNullOrWhiteSpace([string]$row['id']) -or [string]::IsNullOrWhiteSpace([string]$row['english']) -or [string]::IsNullOrWhiteSpace([string]$row['korean'])) {
            $failures.Add('Every accepted unique-item mapping requires non-empty id, english, and korean')
            break
        }
    }
    if ($uniqueConflicts['rows'] -isnot [array] -or $uniqueUnmatched['rows'] -isnot [array]) {
        $failures.Add('Unique-item conflict and unmatched rows must always be arrays')
    }
    if ([int]$uniqueManifest['counts']['accepted'] -ne $uniqueAcceptedRows.Count -or
        [int]$uniqueManifest['counts']['conflicts'] -ne $uniqueConflictRows.Count -or
        [int]$uniqueManifest['counts']['unmatched'] -ne $uniqueUnmatchedRows.Count) {
        $failures.Add('Unique-item manifest counts must match its reports')
    }

    $referenceUniques = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\zh-rTW\uniques.json')
    $koreanUniques = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\ko-KR\uniques.json')
    if ($null -ne $referenceUniques -and $null -ne $koreanUniques) {
        $officialUniques = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
        foreach ($row in $uniqueAcceptedRows) {
            $english = [string]$row['english']
            $korean = [string]$row['korean']
            if ($officialUniques.ContainsKey($english) -and $officialUniques[$english] -ne $korean) {
                $failures.Add("Unique-item report contains an unresolved English-key conflict: $english")
            }
            else {
                $officialUniques[$english] = $korean
            }
        }
        $expectedUniqueKeys = @($referenceUniques['entries'].Keys | Where-Object { $officialUniques.ContainsKey($_) } | Sort-Object)
        $actualUniqueEntries = $koreanUniques['entries']
        if ($actualUniqueEntries -isnot [hashtable]) {
            $failures.Add('Korean uniques.json must contain an entries object')
        }
        else {
            if ($actualUniqueEntries.Keys.Count -ne $expectedUniqueKeys.Count) {
                $failures.Add("Korean uniques.json must contain all and only $($expectedUniqueKeys.Count) exact official unique names; found $($actualUniqueEntries.Keys.Count)")
            }
            $missingUniqueKeys = @($expectedUniqueKeys | Where-Object { -not $actualUniqueEntries.ContainsKey($_) })
            $wrongUniqueKeys = @($expectedUniqueKeys | Where-Object { $actualUniqueEntries.ContainsKey($_) -and $actualUniqueEntries[$_] -ne $officialUniques[$_] })
            if ($missingUniqueKeys.Count -gt 0) {
                $failures.Add("Korean uniques.json is missing $($missingUniqueKeys.Count) exact official name(s), including: $(@($missingUniqueKeys | Select-Object -First 5) -join ' | ')")
            }
            if ($wrongUniqueKeys.Count -gt 0) {
                $failures.Add("Korean uniques.json differs from $($wrongUniqueKeys.Count) official name(s)")
            }
            $expectedUniqueSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($key in $expectedUniqueKeys) { [void]$expectedUniqueSet.Add($key) }
            $unexpectedUniqueKeys = @($actualUniqueEntries.Keys | Where-Object { -not $expectedUniqueSet.Contains($_) })
            if ($unexpectedUniqueKeys.Count -gt 0) {
                $failures.Add("Korean uniques.json contains $($unexpectedUniqueKeys.Count) unproven key(s)")
            }
        }
    }
}

$modReportRoot = Join-Path $reportRoot 'mod-names'
$modManifest = Read-JsonFile -Path (Join-Path $modReportRoot 'manifest.json')
$modAccepted = Read-JsonFile -Path (Join-Path $modReportRoot 'accepted.json')
$modConflicts = Read-JsonFile -Path (Join-Path $modReportRoot 'conflicts.json')
$modUnmatched = Read-JsonFile -Path (Join-Path $modReportRoot 'unmatched.json')

if ($null -ne $modManifest -and $null -ne $modAccepted -and $null -ne $modConflicts -and $null -ne $modUnmatched) {
    if ($modManifest['patch'] -ne '3.29.3.2' -or $modManifest['identity'] -ne 'mod id') {
        $failures.Add('Mod-name manifest must identify patch 3.29.3.2 and the mod id join')
    }
    if ($modManifest['clientEvidence']['detectedPatch'] -ne '3.29.3.2' -or $modManifest['clientEvidence']['matchesExportPatch'] -ne $true) {
        $failures.Add('Mod-name manifest must prove that the local Korean client patch matches the export patch')
    }
    foreach ($language in @('english', 'korean')) {
        $source = $modManifest['sources'][$language]
        if ([string]$source['url'] -notmatch '^https://repoe-fork\.github\.io/' -or
            [string]$source['sha256'] -notmatch '^[0-9A-F]{64}$' -or
            [int64]$source['bytes'] -le 0) {
            $failures.Add("Mod-name manifest must pin the $language URL, hash, and byte size")
        }
    }

    $modAcceptedRows = @($modAccepted['rows'])
    $modConflictRows = @($modConflicts['rows'])
    $modUnmatchedRows = @($modUnmatched['rows'])
    if ($modAcceptedRows.Count -eq 0 -or $null -eq ($modAcceptedRows | Where-Object { [string]$_['korean'] -match '[가-힣]' } | Select-Object -First 1)) {
        $failures.Add('Mod-name report must contain accepted Hangul mappings')
    }
    foreach ($row in $modAcceptedRows) {
        if ([string]::IsNullOrWhiteSpace([string]$row['id']) -or [string]::IsNullOrWhiteSpace([string]$row['english']) -or [string]::IsNullOrWhiteSpace([string]$row['korean'])) {
            $failures.Add('Every accepted mod-name mapping requires non-empty id, english, and korean')
            break
        }
    }
    if ($modConflicts['rows'] -isnot [array] -or $modUnmatched['rows'] -isnot [array]) {
        $failures.Add('Mod-name conflict and unmatched rows must always be arrays')
    }
    if ([int]$modManifest['counts']['accepted'] -ne $modAcceptedRows.Count -or
        [int]$modManifest['counts']['conflicts'] -ne $modConflictRows.Count -or
        [int]$modManifest['counts']['unmatched'] -ne $modUnmatchedRows.Count) {
        $failures.Add('Mod-name manifest counts must match its reports')
    }

    $referenceTags = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\zh-rTW\tags.json')
    $koreanTags = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\ko-KR\tags.json')
    if ($null -ne $referenceTags -and $null -ne $koreanTags) {
        $officialModNames = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
        foreach ($row in $modAcceptedRows) {
            $english = [string]$row['english']
            $korean = [string]$row['korean']
            if ($officialModNames.ContainsKey($english) -and $officialModNames[$english] -ne $korean) {
                $failures.Add("Mod-name report contains an unresolved English-key conflict: $english")
            }
            else {
                $officialModNames[$english] = $korean
            }
        }
        $expectedTagKeys = @($referenceTags['entries'].Keys | Where-Object { $officialModNames.ContainsKey($_) } | Sort-Object)
        $actualTagEntries = $koreanTags['entries']
        if ($actualTagEntries -isnot [hashtable]) {
            $failures.Add('Korean tags.json must contain an entries object')
        }
        else {
            if ($actualTagEntries.Keys.Count -ne $expectedTagKeys.Count) {
                $failures.Add("Korean tags.json must contain all and only $($expectedTagKeys.Count) exact official mod names; found $($actualTagEntries.Keys.Count)")
            }
            $missingTagKeys = @($expectedTagKeys | Where-Object { -not $actualTagEntries.ContainsKey($_) })
            $wrongTagKeys = @($expectedTagKeys | Where-Object { $actualTagEntries.ContainsKey($_) -and $actualTagEntries[$_] -ne $officialModNames[$_] })
            if ($missingTagKeys.Count -gt 0) {
                $failures.Add("Korean tags.json is missing $($missingTagKeys.Count) exact official mod name(s), including: $(@($missingTagKeys | Select-Object -First 5) -join ' | ')")
            }
            if ($wrongTagKeys.Count -gt 0) {
                $failures.Add("Korean tags.json differs from $($wrongTagKeys.Count) official mod name(s)")
            }
            $expectedTagSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($key in $expectedTagKeys) { [void]$expectedTagSet.Add($key) }
            $unexpectedTagKeys = @($actualTagEntries.Keys | Where-Object { -not $expectedTagSet.Contains($_) })
            if ($unexpectedTagKeys.Count -gt 0) {
                $failures.Add("Korean tags.json contains $($unexpectedTagKeys.Count) unproven key(s)")
            }
        }
    }
}

if ($null -ne $accepted -and $acceptedRows.Count -gt 0) {
    $referenceItems = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\zh-rTW\items.json')
    $koreanItems = Read-JsonFile -Path (Join-Path $rootPath 'Data\poe1\ko-KR\items.json')
    if ($null -ne $referenceItems -and $null -ne $koreanItems) {
        $officialByEnglish = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
        foreach ($row in $acceptedRows) {
            $english = [string]$row['english']
            $korean = [string]$row['korean']
            if ($officialByEnglish.ContainsKey($english) -and $officialByEnglish[$english] -ne $korean) {
                $failures.Add("Accepted report contains an unresolved English-key conflict: $english")
            }
            else {
                $officialByEnglish[$english] = $korean
            }
        }

        $expectedItemKeys = @(
            $referenceItems['entries'].Keys |
                Where-Object { $officialByEnglish.ContainsKey($_) } |
                Sort-Object
        )
        $actualItemEntries = $koreanItems['entries']
        if ($actualItemEntries -isnot [hashtable]) {
            $failures.Add('Korean items.json must contain an entries object')
        }
        else {
            if ($actualItemEntries.Keys.Count -ne $expectedItemKeys.Count) {
                $failures.Add("Korean items.json must contain all and only $($expectedItemKeys.Count) exact official BaseItemTypes matches; found $($actualItemEntries.Keys.Count)")
            }
            $missingItemKeys = @($expectedItemKeys | Where-Object { -not $actualItemEntries.ContainsKey($_) })
            $wrongItemKeys = @($expectedItemKeys | Where-Object { $actualItemEntries.ContainsKey($_) -and $actualItemEntries[$_] -ne $officialByEnglish[$_] })
            if ($missingItemKeys.Count -gt 0) {
                $failures.Add("Korean items.json is missing $($missingItemKeys.Count) official item key(s), including: $(@($missingItemKeys | Select-Object -First 5) -join ' | ')")
            }
            if ($wrongItemKeys.Count -gt 0) {
                $failures.Add("Korean items.json differs from $($wrongItemKeys.Count) official Korean name(s), including: $(@($wrongItemKeys | Select-Object -First 5) -join ' | ')")
            }
            $expectedItemKeySet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
            foreach ($key in $expectedItemKeys) {
                [void]$expectedItemKeySet.Add($key)
            }
            $unexpectedItemKeys = @($actualItemEntries.Keys | Where-Object { -not $expectedItemKeySet.Contains($_) })
            if ($unexpectedItemKeys.Count -gt 0) {
                $failures.Add("Korean items.json contains $($unexpectedItemKeys.Count) item key(s) not proven by the official BaseItemTypes mapping")
            }
        }
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ -ErrorAction Continue }
    Write-Host "FAIL: $($failures.Count) official-term contract error(s)." -ForegroundColor Red
    exit 1
}

Write-Host "PASS: all official PoE1 Korean mapping and locale contracts are traceable and deterministic." -ForegroundColor Green
