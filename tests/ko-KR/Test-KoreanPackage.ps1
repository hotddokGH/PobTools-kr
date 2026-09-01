param([Parameter(Mandatory)][string]$PackageRoot)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PackageRoot)
$failures = [Collections.Generic.List[string]]::new()

# A clean checkout deliberately has no package directory.  Report the public
# contract failure deterministically, rather than allowing recursive discovery
# below to throw for a missing root.
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    $failures.Add('missing pob-zh.exe')
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

function Require-File([string]$relative, [long]$minimum = 1) {
    $path = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $failures.Add("missing $relative"); return }
    if ((Get-Item -LiteralPath $path).Length -lt $minimum) { $failures.Add("too small $relative") }
}

Require-File 'pob-zh.exe' 1MB
Require-File 'engine/SimpleGraphic.dll' 1
Require-File 'Data/launcher/ko-KR/launcher.json' 1
foreach ($name in 'tags','items','gems','ui','stats','passives','uniques','monsters') {
    Require-File "Data/poe1/ko-KR/$name.json" 1
}
Require-File 'Fonts/NotoSansKR-Variable.ttf' 1MB
Require-File 'Fonts/OFL-NotoSansKR.txt' 1
Require-File 'pob-zh.ini' 1
Require-File 'LICENSE' 1
Require-File 'NOTICE.md' 1
foreach ($forbidden in 'Data/poe2','Path of Building Community','PobTools','tools','reports','tests','node_modules','cache','logs','translate_misses.log','MalgunGothic-TestOnly.ttf') {
    if (Test-Path -LiteralPath (Join-Path $root $forbidden)) { $failures.Add("forbidden $forbidden") }
}
Get-ChildItem -LiteralPath $root -Recurse -Filter '*.json' | ForEach-Object {
    $jsonPath = $_.FullName
    try {
        $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
        $strictUtf8.GetString([IO.File]::ReadAllBytes($jsonPath)) | ConvertFrom-Json -AsHashtable | Out-Null
    }
    catch { $failures.Add("invalid UTF-8 JSON $($jsonPath.Substring($root.Length))") }
}
$ini = Get-Content -LiteralPath (Join-Path $root 'pob-zh.ini') -Raw
foreach ($required in 'Game=poe1','Locale=ko-KR','UpdateTranslations=0','Font=NotoSansKR-Variable.ttf') {
    if ($ini -notmatch "(?m)^$([regex]::Escape($required))\r?$") { $failures.Add("pob-zh.ini lacks $required") }
}
if ($failures.Count) { $failures | ForEach-Object { Write-Error $_ }; exit 1 }
Write-Host 'PASS: Korean package contract is valid.'
