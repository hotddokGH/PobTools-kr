$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$rootPath = Join-Path $repoRoot 'pob-zh-engine\dist'
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

function Assert-Metadata {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$RequireLoadOrder
    )

    $metadata = Read-JsonFile -Path $Path
    if ($null -eq $metadata) {
        return $null
    }

    if ($metadata['locale'] -ne 'ko-KR') {
        $script:failures.Add("$Path must declare locale ko-KR")
    }
    if ($metadata['display_name'] -ne '한국어') {
        $script:failures.Add("$Path must declare display_name 한국어")
    }
    if ($RequireLoadOrder -and @($metadata['load_order']).Count -eq 0) {
        $script:failures.Add("$Path must declare a non-empty load_order")
    }

    return $metadata
}

function Assert-Translations {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Expected
    )

    $dictionary = Read-JsonFile -Path $Path
    if ($null -eq $dictionary) {
        return
    }

    $entries = $dictionary['entries']
    if ($entries -isnot [hashtable]) {
        $script:failures.Add("$Path must contain an entries object")
        return
    }

    foreach ($key in $Expected.Keys) {
        if (-not $entries.ContainsKey($key)) {
            $script:failures.Add("Missing English lookup key '$key' in $Path")
        }
        elseif ($entries[$key] -ne $Expected[$key]) {
            $script:failures.Add("Unexpected translation for '$key' in $Path")
        }
    }

    $hasHangul = $entries.Values | Where-Object { $_ -is [string] -and $_ -match '[가-힣]' } | Select-Object -First 1
    if ($null -eq $hasHangul) {
        $script:failures.Add("$Path must contain at least one Hangul translation")
    }
}

function Get-FormatTokens {
    param([Parameter(Mandatory)][string]$Text)

    $tokens = [System.Collections.Generic.List[string]]::new()
    foreach ($match in [regex]::Matches($Text, '%(?:[-+0 #]*\d*(?:\.\d+)?)?[A-Za-z]')) {
        $tokens.Add($match.Value)
    }
    for ($index = 0; $index -lt ([regex]::Matches($Text, "`n").Count); $index++) {
        $tokens.Add('<LF>')
    }
    return @($tokens | Sort-Object)
}

function Assert-CompleteLauncherDictionary {
    param(
        [Parameter(Mandatory)][string]$ReferencePath,
        [Parameter(Mandatory)][string]$KoreanPath
    )

    $reference = Read-JsonFile -Path $ReferencePath
    $korean = Read-JsonFile -Path $KoreanPath
    if ($null -eq $reference -or $null -eq $korean) {
        return
    }

    $referenceEntries = $reference['entries']
    $koreanEntries = $korean['entries']
    if ($referenceEntries -isnot [hashtable] -or $koreanEntries -isnot [hashtable]) {
        $script:failures.Add('Launcher reference and Korean dictionaries must contain entries objects')
        return
    }

    if ($referenceEntries.Keys.Count -ne 109) {
        $script:failures.Add("Launcher reference must contain 109 entries, found $($referenceEntries.Keys.Count)")
    }

    $missingKeys = @($referenceEntries.Keys | Where-Object { -not $koreanEntries.ContainsKey($_) })
    $extraKeys = @($koreanEntries.Keys | Where-Object { -not $referenceEntries.ContainsKey($_) })
    if ($missingKeys.Count -gt 0) {
        $script:failures.Add("Korean launcher is missing $($missingKeys.Count) reference key(s): $($missingKeys -join ' | ')")
    }
    if ($extraKeys.Count -gt 0) {
        $script:failures.Add("Korean launcher has $($extraKeys.Count) unexpected key(s): $($extraKeys -join ' | ')")
    }

    foreach ($key in $referenceEntries.Keys) {
        if (-not $koreanEntries.ContainsKey($key)) {
            continue
        }

        $value = $koreanEntries[$key]
        if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
            $script:failures.Add("Korean launcher value is empty for key '$key'")
            continue
        }
        if ($value -match '[\p{IsCJKUnifiedIdeographs}]') {
            $script:failures.Add("Korean launcher value contains a CJK ideograph for key '$key'")
        }

        $sourceTokens = @(Get-FormatTokens -Text $key)
        $targetTokens = @(Get-FormatTokens -Text $value)
        if (($sourceTokens -join '|') -ne ($targetTokens -join '|')) {
            $script:failures.Add("Format token mismatch for launcher key '$key': source=[$($sourceTokens -join ', ')] target=[$($targetTokens -join ', ')]")
        }
    }
}

$launcherRoot = Join-Path $rootPath 'Data\launcher\ko-KR'
$poe1Root = Join-Path $rootPath 'Data\poe1\ko-KR'

$launcherMetadata = Assert-Metadata -Path (Join-Path $launcherRoot 'meta.json')
$poe1Metadata = Assert-Metadata -Path (Join-Path $poe1Root 'meta.json') -RequireLoadOrder

if ($null -ne $launcherMetadata) {
    Assert-Translations -Path (Join-Path $launcherRoot 'launcher.json') -Expected @{
        'Path of Building Launcher' = 'Path of Building 실행기'
        'Interface language' = '인터페이스 언어'
        'Game version' = '게임 버전'
        'Path of Exile 1' = 'Path of Exile 1'
        'Detected' = '감지됨'
        'Not found' = '찾을 수 없음'
        'Launch' = '실행'
        'Tools' = '도구'
        'About' = '정보'
        'Close' = '닫기'
        'Font' = '글꼴'
        'Check for updates' = '업데이트 확인'
    }

    Assert-CompleteLauncherDictionary `
        -ReferencePath (Join-Path $rootPath 'Data\launcher\zh-rTW\launcher.json') `
        -KoreanPath (Join-Path $launcherRoot 'launcher.json')
}

if ($null -ne $poe1Metadata) {
    foreach ($dictionaryName in @($poe1Metadata['load_order'])) {
        $dictionaryPath = Join-Path $poe1Root $dictionaryName
        $dictionary = Read-JsonFile -Path $dictionaryPath
        if ($null -ne $dictionary -and $dictionary['entries'] -isnot [hashtable]) {
            $failures.Add("$dictionaryPath must contain an entries object")
        }
    }

    Assert-Translations -Path (Join-Path $poe1Root 'ui.json') -Expected @{
        'Build' = '빌드'
        'Tree' = '패시브 트리'
        'Skills' = '스킬'
        'Items' = '아이템'
        'Calcs' = '계산'
        'Notes' = '메모'
        'Configuration' = '설정'
        'Party' = '파티'
        'Import/Export Build' = '빌드 가져오기/내보내기'
        'Save' = '저장'
        'Open' = '열기'
        'New' = '새로 만들기'
        'Exit' = '종료'
    }
}

$iniPath = Join-Path $rootPath 'pob-zh.ini'
if (-not (Test-Path -LiteralPath $iniPath -PathType Leaf)) {
    $failures.Add("Missing file: $iniPath")
}
else {
    $iniText = Get-Content -LiteralPath $iniPath -Raw -Encoding UTF8
    if ($iniText -notmatch '(?m)^Game=poe1\r?$') {
        $failures.Add("$iniPath must select Game=poe1")
    }
    if ($iniText -notmatch '(?m)^Locale=ko-KR\r?$') {
        $failures.Add("$iniPath must select Locale=ko-KR")
    }
    if ($iniText -notmatch '(?m)^UpdateTranslations=0\r?$') {
        $failures.Add("$iniPath must disable remote translation replacement")
    }

    $fontMatch = [regex]::Match($iniText, '(?m)^Font=([^\r\n]+)\r?$')
    if (-not $fontMatch.Success) {
        $failures.Add("$iniPath must configure a font")
    }
    else {
        $fontPath = Join-Path (Join-Path $rootPath 'Fonts') $fontMatch.Groups[1].Value
        if (-not (Test-Path -LiteralPath $fontPath -PathType Leaf)) {
            $failures.Add("Configured font does not exist: $fontPath")
        }
        if ($fontMatch.Groups[1].Value -ne 'NotoSansKR-Variable.ttf') {
            $failures.Add("$iniPath must use the redistributable NotoSansKR-Variable.ttf font")
        }
        $fontLicensePath = Join-Path (Join-Path $rootPath 'Fonts') 'OFL-NotoSansKR.txt'
        if (-not (Test-Path -LiteralPath $fontLicensePath -PathType Leaf)) {
            $failures.Add("Missing Noto Sans KR license: $fontLicensePath")
        }
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ -ErrorAction Continue }
    Write-Host "FAIL: $($failures.Count) Korean locale contract error(s)." -ForegroundColor Red
    exit 1
}

Write-Host 'PASS: Korean locale contract is valid.' -ForegroundColor Green
