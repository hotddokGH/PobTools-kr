# PobTools-ko Maintenance Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GitHub-hosted maintenance pipeline that converts a pinned PobTools-zh upstream commit into a tested PoE1 Korean preview while requiring the maintainer to review only new or ambiguous strings.

**Architecture:** Keep upstream C++ clean, apply a small behavioral compatibility patch and then a reviewed JSON source-string overlay inside a temporary worktree, regenerate official PoE1 data, and build on a pinned Windows runner. Separate read-only validation, upstream detection/maintenance PR creation, and explicitly approved preview packaging so a failed update can never replace the previous release.

**Tech Stack:** Python 3.12, `tree-sitter` 0.26.0, `tree-sitter-cpp` 0.23.4, Node.js 22 ESM and `node:test`, PowerShell 7, C++17, CMake 4, Visual Studio 18 2026, vcpkg manifest mode, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-01-pobtools-ko-maintenance-automation-design.md`

## Global Constraints

- PoE1 only; do not add or publish PoE2 Korean dictionaries.
- `origin` is `https://github.com/hotddokGH/PobTools-kr.git`; `upstream` is `https://github.com/Hsiung-Shao/PobTools-zh.git`.
- The reproduction baseline is upstream commit `baf07d41d2df524d4330a58b411826339c93fac1`.
- The first real update target is `ba33ed80de67d8301baad930456131d581df6ae1`.
- Generated Korean C++ files exist only under an ignored temporary workspace and are never committed to `ko/main`.
- Official PoE1 Korean terminology keeps the pinned manifest, hashes, stable-ID joins, and deterministic output contracts already stored under `localization/ko-KR`.
- Machine output is suggestion-only; only statuses `official`, `reviewed`, and `intentional` may pass the release gate.
- The compatibility patch contains behavioral changes only, never display-only translations.
- A failed mapping, signature, patch, build, self-test, or package contract produces a report and no preview ZIP.
- GitHub-hosted builds use `windows-2025-vs2026`, not the moving `windows-latest` label.
- Third-party Actions are pinned to immutable commit SHAs.
- Preview EXEs and ZIPs are unsigned; publish SHA-256 hashes and never add `.pfx`, `.p12`, `.pem`, or private keys to the repository.
- Do not push to `upstream`; automation may write only to `hotddokGH/PobTools-kr`.

---

## File Structure

### Source overlay

- `localization/ko-KR/lib/source_overlay.py`: tree-sitter C++ extraction, mapping validation, transactional application, and reports.
- `localization/ko-KR/source-translations.json`: canonical reviewed/official/intentional C++ display mapping.
- `localization/ko-KR/source-translation-suggestions.json`: non-releasable machine suggestions.
- `localization/ko-KR/requirements-overlay.txt`: pinned lightweight parser dependencies only.
- `localization/ko-KR/tests/test_source_overlay.py`: parser, context, signature, status, and transactional-write tests.
- `localization/ko-KR/migrate-source-translations.py`: one-time conversion from the current legacy maps and localized source.

### Compatibility and update orchestration

- `localization/ko-KR/compat/pobtools-ko.patch`: behavioral Korean-release changes applied after checkout.
- `localization/ko-KR/compat/manifest.json`: patch base, required paths, and SHA-256.
- `localization/ko-KR/lib/upstream-maintenance.mjs`: ref resolution, worktree preparation, patching, report classification, and state comparison.
- `localization/ko-KR/update-upstream.mjs`: CLI around the maintenance library.
- `localization/ko-KR/upstream-state.json`: last reviewed upstream commit and official PoE patch.
- `localization/ko-KR/lib/maintenance-bundle.mjs`: allowlisted maintenance artifact creation and verification.
- `localization/ko-KR/tests/upstream-maintenance.test.mjs`: miniature-repository update and failure-report tests.
- `localization/ko-KR/tests/compat-patch.test.mjs`: patch manifest and baseline reproduction contract.

### Build and package

- `localization/ko-KR/Assemble-KoreanPackage.ps1`: allowlisted staging assembly and SHA-256 manifest generation.
- `localization/ko-KR/write-build-provenance.mjs`: trusted build provenance record generation.
- `tests/ko-KR/Test-KoreanPackage.ps1`: executable, DLL, locale, font, JSON, configuration, and forbidden-path contract.
- `docs/ko-KR/INSTALL.md`: Korean install and unsigned-build instructions.
- `docs/ko-KR/PREVIEW-NOTES.md`: first-preview limitations and manual smoke-test status.
- `docs/ko-KR/MAINTENANCE.md`: review queue and manual workflow instructions.

### GitHub Actions

- `.github/workflows/validate-ko.yml`: read-only tests and deterministic data validation.
- `.github/workflows/check-upstream.yml`: scheduled/manual analysis and maintenance PR update.
- `.github/workflows/build-ko-preview.yml`: explicitly invoked Windows build, package test, ZIP, and hashes.
- `localization/ko-KR/tests/workflow-contract.test.mjs`: pinned Actions, permissions, branch, and no-Release policy.

---

### Task 1: Prove the Current Korean Branch Can Build and Package on GitHub

**Files:**
- Create: `tests/ko-KR/Test-KoreanPackage.ps1`
- Create: `localization/ko-KR/Assemble-KoreanPackage.ps1`
- Create: `.github/workflows/build-ko-preview.yml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: CMake install prefix, tracked `pob-zh-engine/dist/Data/*/ko-KR`, Korean fonts, `pob-zh.ini`, and repository notices.
- Produces: `pwsh -File tests/ko-KR/Test-KoreanPackage.ps1 -PackageRoot pob-zh-engine/dist-ko` exit status; `PobTools-Korean-preview.zip`; `PobTools-Korean-preview.zip.sha256.json`.

- [ ] **Step 1: Write the failing package contract**

Create `Test-KoreanPackage.ps1` with mandatory `-PackageRoot` and checks for the exact public shape:

```powershell
param([Parameter(Mandatory)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PackageRoot)
$failures = [Collections.Generic.List[string]]::new()
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
foreach ($forbidden in 'tools','reports','tests','node_modules','cache','logs','translate_misses.log','MalgunGothic-TestOnly.ttf') {
    if (Test-Path -LiteralPath (Join-Path $root $forbidden)) { $failures.Add("forbidden $forbidden") }
}
Get-ChildItem -LiteralPath $root -Recurse -Filter '*.json' | ForEach-Object {
    try {
        $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
        $strictUtf8.GetString([IO.File]::ReadAllBytes($_.FullName)) | ConvertFrom-Json | Out-Null
    }
    catch { $failures.Add("invalid UTF-8 JSON $($_.FullName.Substring($root.Length))") }
}
$ini = Get-Content -LiteralPath (Join-Path $root 'pob-zh.ini') -Raw
foreach ($required in 'Game=poe1','Locale=ko-KR','UpdateTranslations=0','Font=NotoSansKR-Variable.ttf') {
    if ($ini -notmatch "(?m)^$([regex]::Escape($required))\r?$") { $failures.Add("pob-zh.ini lacks $required") }
}
if ($failures.Count) { $failures | ForEach-Object { Write-Error $_ }; exit 1 }
Write-Host 'PASS: Korean package contract is valid.'
```

- [ ] **Step 2: Run the package contract and verify RED**

Run:

```powershell
pwsh -NoProfile -File tests/ko-KR/Test-KoreanPackage.ps1 -PackageRoot pob-zh-engine/dist-ko
```

Expected: exit `1` with `missing pob-zh.exe` because a clean `dist-ko` does not exist.

- [ ] **Step 3: Write the minimal allowlisted package assembler**

Create `Assemble-KoreanPackage.ps1` with parameters `-InstallRoot`, `-OutputRoot`, and `-ZipPath`. It must remove only the exact output directory after validating that it is below the repository, copy the CMake install tree, remove non-Korean locale folders, overlay Korean assets, and emit sorted hashes:

```powershell
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
if (-not (Test-Path -LiteralPath $install -PathType Container)) {
    throw "InstallRoot does not exist: $install"
}
if (-not $output.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must stay inside repository: $output"
}
if (-not $zip.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "ZipPath must stay inside repository: $zip"
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
```

- [ ] **Step 4: Add the first manual-only Windows workflow**

Create `build-ko-preview.yml` with `workflow_dispatch`, `permissions: contents: read`, `runs-on: windows-2025-vs2026`, and these pinned Actions:

```yaml
name: Build Korean preview
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  build:
    runs-on: windows-2025-vs2026
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          lfs: true
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '22'
      - name: Bootstrap pinned vcpkg
        shell: pwsh
        run: |
          git clone --filter=blob:none https://github.com/microsoft/vcpkg pob-zh-engine/vcpkg
          git -C pob-zh-engine/vcpkg checkout 3d72d8c930e1b6a1b2432b262c61af7d3287dcd0
          & pob-zh-engine/vcpkg/bootstrap-vcpkg.bat -disableMetrics
      - name: Configure, build, and install
        shell: pwsh
        run: |
          cmake -S pob-zh-engine -B pob-zh-engine/build-ko -G "Visual Studio 18 2026" -A x64 -DPOBTOOLS_KOREAN_RELEASE=ON
          cmake --build pob-zh-engine/build-ko --config Release
          cmake --install pob-zh-engine/build-ko --config Release --prefix pob-zh-engine/install-ko
      - name: Assemble and test
        shell: pwsh
        run: |
          pwsh -NoProfile -File localization/ko-KR/Assemble-KoreanPackage.ps1 -InstallRoot pob-zh-engine/install-ko -OutputRoot pob-zh-engine/dist-ko -ZipPath pob-zh-engine/PobTools-Korean-preview.zip
          pwsh -NoProfile -File tests/ko-KR/Test-KoreanPackage.ps1 -PackageRoot pob-zh-engine/dist-ko
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: PobTools-Korean-preview
          path: |
            pob-zh-engine/PobTools-Korean-preview.zip
            pob-zh-engine/PobTools-Korean-preview.zip.sha256.json
```

- [ ] **Step 5: Validate workflow syntax and commit**

Run:

```powershell
node --test localization/ko-KR/tests/*.test.mjs
pwsh -NoProfile -File tests/ko-KR/Test-KoreanLocale.ps1
git diff --check
git add .gitignore tests/ko-KR/Test-KoreanPackage.ps1 localization/ko-KR/Assemble-KoreanPackage.ps1 .github/workflows/build-ko-preview.yml
git commit -m "ci: build Korean preview on Windows"
git push
```

Expected: local contracts pass and GitHub shows a manually runnable `Build Korean preview` workflow. This first workflow deliberately builds the directly translated branch only as a compiler/package diagnostic. Run it once and retain its failing/successful log as evidence for Task 6; do not publish the artifact as a Release. Task 10 replaces its source input with clean-upstream generation before the artifact is considered distributable.

---

### Task 2: Implement the Transactional C++ Source Overlay

**Files:**
- Create: `localization/ko-KR/requirements-overlay.txt`
- Create: `localization/ko-KR/lib/source_overlay.py`
- Create: `localization/ko-KR/tests/test_source_overlay.py`
- Modify: `localization/ko-KR/lib/source-display-audit.mjs`
- Modify: `localization/ko-KR/audit-source-display.mjs`

**Interfaces:**
- Consumes: C++ source root, canonical mapping document, and `source-display-policy.json`.
- Produces: `scan_cpp_literals(path: Path, text: bytes) -> list[Literal]`, `format_signature(value: str) -> tuple[str, ...]`, `apply_overlay(source_root: Path, mapping_path: Path, policy_path: Path, report_path: Path) -> dict`, and CLI modes `audit` and `apply`.

- [ ] **Step 1: Pin the lightweight parser dependencies**

Create `requirements-overlay.txt`:

```text
tree-sitter==0.26.0
tree-sitter-cpp==0.23.4
```

- [ ] **Step 2: Write failing parser and transactional tests**

Create `test_source_overlay.py` using `unittest` and temporary directories. Cover regular, wide, UTF-8, and raw literals, comments, function context, status rejection, signature mismatch, and no partial writes:

```python
class SourceOverlayTests(unittest.TestCase):
    def test_scans_prefixes_raw_strings_and_function_context(self):
        source = 'void Draw(){ ImGui::Text(u8"設定 %d\\n"); auto x = LR"tag(更新)tag"; }'
        rows = scan_cpp_literals(Path('host/ui.cpp'), source.encode('utf-8'))
        self.assertEqual([row.decoded for row in rows], ['設定 %d\n', '更新'])
        self.assertEqual({row.function for row in rows}, {'Draw'})

    def test_apply_is_transactional_when_any_row_is_unreviewed(self):
        self.write('host/ui.cpp', 'void Draw(){ ImGui::Text(u8"設定"); ImGui::Text(u8"更新"); }')
        mapping = self.mapping({'設定': self.entry('설정', 'reviewed'), '更新': self.entry('업데이트', 'suggested')})
        before = self.read('host/ui.cpp')
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report['issues'][0]['code'], 'SUGGESTION_ONLY')
        self.assertEqual(self.read('host/ui.cpp'), before)

    def test_context_override_wins_and_preserves_signature(self):
        mapping = self.mapping(
            {'開啟 %s': self.entry('%s 열기', 'reviewed')},
            contexts=[{'path':'host/a.cpp','function':'DrawAtlas','source':'開啟 %s','target':'아틀라스 %s 열기','status':'reviewed','provenance':'manual-context','formatSignature':['%s']}],
        )
        self.write('host/a.cpp', 'void DrawAtlas(){ ImGui::Text(u8"開啟 %s", name); }')
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report['issues'], [])
        self.assertIn('아틀라스 %s 열기', self.read('host/a.cpp'))
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
python localization/ko-KR/tests/test_source_overlay.py
```

Expected: fail with `ModuleNotFoundError` for `source_overlay`.

- [ ] **Step 4: Implement extraction and mapping validation**

Use `tree_sitter.Parser(Language(tree_sitter_cpp.language()))`. Define immutable records and accepted statuses exactly:

```python
ACCEPTED_STATUSES = frozenset({'official', 'reviewed', 'intentional'})

@dataclass(frozen=True)
class Literal:
    path: str
    start: int
    end: int
    decoded: str
    prefix: str
    function: str
    line: int

def format_signature(value: str) -> tuple[str, ...]:
    tokens = re.findall(r'%(?:[-+0 #]*\d*(?:\.\d+)?[hlLzjt]*[diuoxXfFeEgGaAcspn%])|\{\d+\}|\^x[0-9A-Fa-f]{6}', value)
    tokens.extend('<NL>' for _ in range(value.count('\n')))
    return tuple(sorted(tokens))
```

Traverse `string_literal`, `raw_string_literal`, and concatenated-string nodes; retain byte offsets and the nearest `function_definition` declarator text. Decode C++ escapes with a dedicated decoder that supports `\\`, `\"`, `\n`, `\r`, `\t`, `\xNN`, `\uNNNN`, and `\UNNNNNNNN`; reject unknown escape forms with `UNSUPPORTED_ESCAPE` instead of guessing.

- [ ] **Step 5: Implement transactional overlay application**

Resolve contextual rows before globals. First scan every file and build a replacement plan; write nothing when any blocking issue exists. When clean, apply replacements in descending byte-offset order and preserve the source file's original newline bytes. The report shape is:

```json
{
  "filesScanned": 0,
  "displayLiterals": 0,
  "reused": 0,
  "official": 0,
  "reviewed": 0,
  "intentional": 0,
  "issues": [
    {"code":"MISSING_MAPPING","path":"host/a.cpp","function":"Draw","line":4,"source":"新增"}
  ]
}
```

Return the report and make the CLI exit `1` when `issues` is non-empty.

- [ ] **Step 6: Make the source audit reuse the overlay inventory contract**

Extend `source-display-audit.mjs` to accept an optional generated overlay report and fail when its `issues` array is non-empty. Add explicit CLI arguments to `audit-source-display.mjs`: `--engine-root`, `--overlay-report`, and `--report`; resolve all three without deriving the target engine from the script location. Do not make Node execute or import upstream C++; it reads source and JSON only.

- [ ] **Step 7: Run tests and commit**

Run:

```powershell
python -m pip install -r localization/ko-KR/requirements-overlay.txt
python localization/ko-KR/tests/test_source_overlay.py
node --test localization/ko-KR/tests/source-display-audit.test.mjs
git diff --check
git add localization/ko-KR/requirements-overlay.txt localization/ko-KR/lib/source_overlay.py localization/ko-KR/tests/test_source_overlay.py localization/ko-KR/lib/source-display-audit.mjs localization/ko-KR/audit-source-display.mjs
git commit -m "feat: add transactional Korean source overlay"
```

Expected: all Python and Node tests pass.

---

### Task 3: Migrate the Current Source Translations into the Canonical Map

**Files:**
- Create: `localization/ko-KR/migrate-source-translations.py`
- Create: `localization/ko-KR/source-translations.json`
- Create: `localization/ko-KR/source-translation-suggestions.json`
- Create: `localization/ko-KR/tests/test_source_migration.py`
- Modify: `localization/ko-KR/machine_translate_source_literals.py`
- Modify: `localization/ko-KR/reference/MACHINE-TRANSLATION-NOTICE.md`

**Interfaces:**
- Consumes: legacy `manual/source-literal-translations.json`, reviewed overrides, current Korean source, and upstream baseline source at `baf07d41d2df524d4330a58b411826339c93fac1`.
- Produces: canonical schema version `1`, sorted exact entries and contextual rows, suggestions kept outside the accepted map, and a migration report with `official`, `reviewed`, `suggested`, `ambiguous`, and `unmapped` counts.

- [ ] **Step 1: Write failing migration tests**

Cover precedence and provenance:

```python
def test_reviewed_override_beats_machine_suggestion(self):
    result = migrate(
        legacy={'entries': {'設定': '환경 설정'}},
        overrides={'entries': {'設定': '설정'}},
        official={},
    )
    self.assertEqual(result.accepted['entries']['設定']['target'], '설정')
    self.assertEqual(result.accepted['entries']['設定']['status'], 'reviewed')
    self.assertEqual(result.suggestions['entries']['設定']['target'], '환경 설정')

def test_machine_only_row_never_enters_accepted_map(self):
    result = migrate(legacy={'entries': {'新增': '새 추가'}}, overrides={'entries': {}}, official={})
    self.assertNotIn('新增', result.accepted['entries'])
    self.assertEqual(result.suggestions['entries']['新增']['status'], 'suggested')
```

- [ ] **Step 2: Run tests and verify RED**

Run `python localization/ko-KR/tests/test_source_migration.py`.

Expected: fail because `migrate_source_translations` does not exist.

- [ ] **Step 3: Implement deterministic migration**

Use this exact acceptance order:

```text
official runtime identity -> status official
reviewed override -> status reviewed
current localized source aligned to the pinned upstream literal -> status reviewed, provenance current-ko-baseline
machine-only legacy row -> suggestion file only
collision or failed structural alignment -> migration report issue
```

For current-source alignment, compare literals by relative path, nearest function, decoded upstream source, and occurrence index inside that function. Require upstream Han text and current Hangul text with identical format signatures. Do not infer a row when more than one current candidate matches.

- [ ] **Step 4: Convert the machine script to suggestion-only output**

Keep `generate` and `retry` for optional local assistance, but change their output path to `source-translation-suggestions.json`. Remove `apply` and `restore` modes from the ML script; the lightweight overlay owns all source writes. Add a guard that refuses to write `source-translations.json`.

- [ ] **Step 5: Generate and validate the canonical map**

Run:

```powershell
python localization/ko-KR/migrate-source-translations.py `
  --upstream-ref baf07d41d2df524d4330a58b411826339c93fac1 `
  --localized-root pob-zh-engine `
  --output localization/ko-KR/source-translations.json `
  --suggestions localization/ko-KR/source-translation-suggestions.json `
  --report reports/maintenance/source-migration.json
```

Expected: deterministic sorted JSON, zero ambiguous/unmapped rows for source literals that are already Korean in the current release, and no `suggested` status in `source-translations.json`.

- [ ] **Step 6: Prove repeatability and commit**

Hash both output files, run migration again, and compare hashes:

```powershell
$first = Get-FileHash localization/ko-KR/source-translations.json,localization/ko-KR/source-translation-suggestions.json
python localization/ko-KR/migrate-source-translations.py --upstream-ref baf07d41d2df524d4330a58b411826339c93fac1 --localized-root pob-zh-engine --output localization/ko-KR/source-translations.json --suggestions localization/ko-KR/source-translation-suggestions.json --report reports/maintenance/source-migration.json
$second = Get-FileHash localization/ko-KR/source-translations.json,localization/ko-KR/source-translation-suggestions.json
if (Compare-Object $first.Hash $second.Hash) { throw 'source migration is not deterministic' }
python localization/ko-KR/tests/test_source_migration.py
git diff --check
git add localization/ko-KR/migrate-source-translations.py localization/ko-KR/source-translations.json localization/ko-KR/source-translation-suggestions.json localization/ko-KR/tests/test_source_migration.py localization/ko-KR/machine_translate_source_literals.py localization/ko-KR/reference/MACHINE-TRANSLATION-NOTICE.md reports/maintenance/source-migration.json
git commit -m "feat: migrate source translations to reviewed data"
```

---

### Task 4: Isolate and Reproduce the Behavioral Compatibility Patch

**Files:**
- Create: `localization/ko-KR/compat/pobtools-ko.patch`
- Create: `localization/ko-KR/compat/manifest.json`
- Create: `localization/ko-KR/tests/compat-patch.test.mjs`
- Modify: `localization/ko-KR/tests/korean-update-contract.test.mjs`
- Modify: `localization/ko-KR/tests/filter-i18n-contract.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: clean baseline worktree, canonical source map, Korean data outputs, and current branch behavioral changes.
- Produces: a patch with no display-only literal replacements; `applyCompatibilityPatch({worktree, patchPath, expectedSha256}) -> result` contract for Task 5.

- [ ] **Step 1: Write the failing patch contract**

The Node test must verify:

```js
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const changedPaths = (patch) => [...patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]);
const addedDisplayLiterals = (patch) => patch.split(/\r?\n/u)
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .flatMap((line) => [...line.matchAll(/(?:u8|L|u|U)?"([^"\\]*(?:\\.[^"\\]*)*)"/gu)])
  .map((match) => match[1])
  .filter((value) => /[\p{Script=Han}가-힣]/u.test(value));
const mapping = readJson('localization/ko-KR/source-translations.json');
const acceptedDisplayLiterals = new Set([
  ...Object.keys(mapping.entries),
  ...mapping.contexts.map((row) => row.source),
  ...Object.values(mapping.entries).map((row) => row.target),
  ...mapping.contexts.map((row) => row.target),
]);

test('compatibility patch is pinned, path-limited, and uses only reviewed display literals', () => {
  const manifest = readJson('localization/ko-KR/compat/manifest.json');
  assert.match(manifest.baseCommit, /^[0-9a-f]{40}$/u);
  assert.equal(sha256(readFileSync(patchPath)), manifest.sha256);
  const patch = readFileSync(patchPath, 'utf8');
  assert.deepEqual(changedPaths(patch).sort(), manifest.allowedPaths.sort());
  for (const literal of addedDisplayLiterals(patch)) {
    assert.equal(acceptedDisplayLiterals.has(literal), true, `patch literal is not owned by reviewed overlay: ${literal}`);
  }
  assert.deepEqual(manifest.requiredContracts.sort(), [
    'korean-atlas-path', 'korean-filter-maps', 'korean-item-prefixes',
    'korean-release-cmake', 'korean-update-disable',
  ]);
});
```

- [ ] **Step 2: Run the contract and verify RED**

Run `node --test localization/ko-KR/tests/compat-patch.test.mjs`.

Expected: fail because the manifest and patch do not exist.

- [ ] **Step 3: Generate a clean baseline workspace**

Use an ignored `.ko-worktrees/baseline` directory. Resolve it and reject it unless it is a strict child of the repository's `.ko-worktrees` directory. Create it from the pinned baseline with `git worktree add --detach .ko-worktrees/baseline baf07d41d2df524d4330a58b411826339c93fac1`. Confirm `git -C .ko-worktrees/baseline status --porcelain` is empty before editing.

- [ ] **Step 4: Build the behavioral patch**

Port only the five behavioral contracts from the current branch into the clean baseline: the CMake release define, updater shutdown, Korean Atlas data path, Korean filter-map selection, and Korean Replica/prefix parsing. Keep upstream-language display literals in every new or structurally changed line; add each such literal as a source row in `source-translations.json` so the later overlay owns the Korean text. Touch only these six files: `pob-zh-engine/CMakeLists.txt`, `pob-zh-engine/host/app_update.cpp`, `pob-zh-engine/host/app_update.h`, `pob-zh-engine/host/atlas_update.cpp`, `pob-zh-engine/host/filter_i18n.cpp`, and `pob-zh-engine/host/filter_item_import.cpp`.

Set `$patchPath = Join-Path (git rev-parse --show-toplevel) 'localization/ko-KR/compat/pobtools-ko.patch'` and `$paths` to that exact six-item array, then run `git -C .ko-worktrees/baseline diff --binary "--output=$patchPath" -- $paths`. Reject any changed path outside the list. If an added display literal is neither an accepted source nor target in `source-translations.json`, add it to the canonical map and regenerate.

Create `manifest.json` from code, not by hand: set `version` to `1`, `baseCommit` to `baf07d41d2df524d4330a58b411826339c93fac1`, `sha256` to `(Get-FileHash -Algorithm SHA256 localization/ko-KR/compat/pobtools-ko.patch).Hash`, `allowedPaths` to the six sorted paths above, and `requiredContracts` to the five sorted contract names shown in Step 1. Serialize with stable key order and UTF-8 without BOM.

- [ ] **Step 5: Reproduce the baseline from clean upstream**

Recreate a clean baseline worktree, apply the compatibility patch with `git apply --check` followed by `git apply --3way`, then apply the source overlay transactionally. Copy/regenerate Korean data. Make both static behavior tests resolve the engine from `process.env.POBTOOLS_ENGINE_ROOT ?? join(repositoryRoot, 'pob-zh-engine')`, then run:

```powershell
node localization/ko-KR/audit-source-display.mjs --engine-root .ko-worktrees/baseline/pob-zh-engine
$env:POBTOOLS_ENGINE_ROOT = (Resolve-Path '.ko-worktrees/baseline/pob-zh-engine').Path
node --test localization/ko-KR/tests/korean-update-contract.test.mjs localization/ko-KR/tests/filter-i18n-contract.test.mjs
Remove-Item Env:POBTOOLS_ENGINE_ROOT
```

Expected: source issues `0`, overlay issues `0`, all five compatibility contracts present.

- [ ] **Step 6: Commit the patch and reproduction evidence**

```powershell
node --test localization/ko-KR/tests/compat-patch.test.mjs
git diff --check
git add .gitignore localization/ko-KR/compat localization/ko-KR/tests/compat-patch.test.mjs localization/ko-KR/tests/korean-update-contract.test.mjs localization/ko-KR/tests/filter-i18n-contract.test.mjs reports/maintenance/baseline-reproduction.json
git commit -m "feat: isolate Korean compatibility patch"
```

---

### Task 5: Implement the Upstream Maintenance Orchestrator

**Files:**
- Create: `localization/ko-KR/lib/upstream-maintenance.mjs`
- Create: `localization/ko-KR/update-upstream.mjs`
- Create: `localization/ko-KR/upstream-state.json`
- Create: `localization/ko-KR/tests/upstream-maintenance.test.mjs`
- Modify: `localization/ko-KR/build-runtime-locale.mjs`
- Modify: `localization/ko-KR/build-custom-poe1-data.mjs`
- Modify: `localization/ko-KR/audit-display-closure.mjs`
- Modify: `localization/ko-KR/audit-source-display.mjs`

**Interfaces:**
- Consumes: `--upstream-ref`, `--workspace`, optional `--force-prepare`, repository root, canonical mapping, compatibility manifest, policy, and official data builders.
- Produces: `prepareMaintenanceRun({repositoryRoot, upstreamRef, workspaceRoot, forcePrepare}) -> {commit, workspace, report}`, `applyCompatibilityPatch(...)`, `classifyMaintenanceReport(...)`, CLI exit `0` for ready/already-processed and `2` for review-required, and deterministic `reports/maintenance/upstream-update.json`.

- [ ] **Step 1: Write failing miniature-repository tests**

Use temporary Git repositories with two commits. Test unchanged reuse, one new Han literal, a failed compatibility hunk, and already-processed state:

```js
test('new upstream literal becomes one review row and exit class review-required', async () => {
  const fixture = await makeUpstreamFixture({ second: 'ImGui::Text(u8"新增");' });
  const result = await prepareMaintenanceRun({
    repositoryRoot: fixture.koRoot,
    upstreamRef: fixture.secondCommit,
    workspaceRoot: fixture.workspace,
  });
  assert.equal(result.report.classification, 'review-required');
  assert.deepEqual(result.report.newStrings.map((row) => row.source), ['新增']);
  assert.equal(result.report.compatibilityFailures.length, 0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run `node --test localization/ko-KR/tests/upstream-maintenance.test.mjs`.

Expected: fail with `ERR_MODULE_NOT_FOUND` for `upstream-maintenance.mjs`.

- [ ] **Step 3: Implement safe worktree preparation**

Resolve the commit with `git rev-parse --verify "${upstreamRef}^{commit}"`. Compute `allowedRoot = resolve(repositoryRoot, '.ko-worktrees')` and `workspace = resolve(workspaceRoot)`; reject equality with `allowedRoot` and reject any value that does not start with `allowedRoot + sep`. Reject an existing symbolic link/junction at the workspace and require its real parent to equal `realpath(allowedRoot)`. Only after those checks, remove a registered existing workspace with `git worktree remove --force workspace` using `execFile` argument arrays, then create it with `git worktree add --detach workspace commit`. Record the resolved commit before changing files. With `forcePrepare: true`, perform these steps even when the commit equals `state.lastReviewedCommit`; otherwise an already-processed run may return without preparing a workspace.

- [ ] **Step 4: Implement patch, overlay, and data phases**

First modify `build-runtime-locale.mjs`, `build-custom-poe1-data.mjs`, `audit-display-closure.mjs`, and `audit-source-display.mjs` so each accepts an explicit `--engine-root`; builders also accept `--report-root`. Mapping inputs continue to resolve from the trusted Korean checkout, while generated files are written only below the supplied engine/report roots.

Run phases in this fixed order and capture command, exit code, and bounded stderr:

```text
compatibility patch check/apply
reviewed source overlay audit/apply
runtime locale build twice/hash compare
custom PoE1 data build twice/hash compare
runtime display audit
generated source display audit
static Korean behavior contracts
```

Do not run upstream-provided scripts while the workflow has write permissions. All invoked scripts come from the checked-out Korean automation branch and receive the temporary upstream path as an explicit argument.

- [ ] **Step 5: Implement deterministic report classification**

Use these classes:

```text
ready              no issues and commit differs from state
already-processed  commit equals state.lastReviewedCommit
review-required    missing/suggested/ambiguous strings or official-data changes
blocked            patch, deterministic generation, audit, or command failure
```

Sort every row by `path`, `function`, `line`, then `source`. Do not include wall-clock timestamps; GitHub run metadata is recorded outside the deterministic report.

- [ ] **Step 6: Add the CLI and exit codes**

Support:

```powershell
node localization/ko-KR/update-upstream.mjs `
  --upstream-ref upstream/main `
  --workspace .ko-worktrees/update `
  --report reports/maintenance/upstream-update.json `
  --force-prepare
```

Exit `0` for `ready` and `already-processed`, `2` for `review-required`, and `1` for `blocked` or malformed input.

- [ ] **Step 7: Run tests and commit**

```powershell
node --test localization/ko-KR/tests/upstream-maintenance.test.mjs
node --test localization/ko-KR/tests/*.test.mjs
git diff --check
git add localization/ko-KR/lib/upstream-maintenance.mjs localization/ko-KR/update-upstream.mjs localization/ko-KR/upstream-state.json localization/ko-KR/tests/upstream-maintenance.test.mjs localization/ko-KR/build-runtime-locale.mjs localization/ko-KR/build-custom-poe1-data.mjs localization/ko-KR/audit-display-closure.mjs localization/ko-KR/audit-source-display.mjs
git commit -m "feat: analyze PobTools upstream updates"
```

---

### Task 6: Process the First Real Upstream Update

**Files:**
- Modify: `localization/ko-KR/source-translations.json`
- Modify: `localization/ko-KR/compat/pobtools-ko.patch`
- Modify: `localization/ko-KR/compat/manifest.json`
- Modify: `localization/ko-KR/upstream-state.json`
- Create: `reports/maintenance/ba33ed8-review.json`

**Interfaces:**
- Consumes: the orchestrator from Task 5 and upstream commit `ba33ed80de67d8301baad930456131d581df6ae1`.
- Produces: a reviewed mapping/patch set that converts `ba33ed8` with zero issues and records it as the new reviewed commit.

- [ ] **Step 1: Run the update and capture the expected review or blocked result**

```powershell
node localization/ko-KR/update-upstream.mjs --upstream-ref ba33ed80de67d8301baad930456131d581df6ae1 --workspace .ko-worktrees/ba33ed8 --report reports/maintenance/ba33ed8-review.json
```

Expected on the first run: exit `2` if the two upstream commits add/change visible strings, or exit `1` with named compatibility hunks if behavior moved. A clean exit is also valid if the upstream changes are data-only and already mapped.

- [ ] **Step 2: Review every new or changed row**

For each row, use official PoE Korean identity when one exists; otherwise write natural Korean into the canonical map with `status: reviewed`, exact provenance, and the computed format signature. Do not copy a machine suggestion without reviewing the source, target, placeholders, and context.

- [ ] **Step 3: Refresh only failed compatibility hunks**

Rebase the hunk against `ba33ed8`, keep behavior identical to the five contracts, regenerate the patch SHA, and update `manifest.baseCommit` to the new reviewed commit only after the patch applies cleanly.

- [ ] **Step 4: Re-run until ready**

Run the orchestrator twice. Expected: both runs produce identical report hashes and classification `ready` with zero new strings and zero compatibility failures.

- [ ] **Step 5: Update state and commit**

Set:

```json
{
  "lastReviewedCommit": "ba33ed80de67d8301baad930456131d581df6ae1",
  "officialPoePatch": "3.29.3.2"
}
```

Then run all locale/source contracts and commit:

```powershell
git add localization/ko-KR/source-translations.json localization/ko-KR/compat localization/ko-KR/upstream-state.json reports/maintenance/ba33ed8-review.json
git commit -m "chore: review upstream ba33ed8 for Korean release"
```

---

### Task 7: Create the Clean `ko/main` Branch Without Generated C++

**Files:**
- Carry from automation branch: `localization/ko-KR/**`, `tests/ko-KR/**`, `.github/workflows/**`, Korean runtime dictionaries/fonts/config, reports, notices, Korean docs, and the two automation design/plan documents.
- Exclude: directly translated `pob-zh-engine/host/*.cpp`, `*.h`, generated Korean host data that the custom builder recreates, and local build directories.

**Interfaces:**
- Consumes: reviewed upstream commit from Task 6 and all committed automation/data assets.
- Produces: `ko/main` based on `origin/main`, with upstream source clean and a successful temporary-worktree reproduction.

- [ ] **Step 1: Create an isolated clean worktree**

Use `superpowers:using-git-worktrees` at execution time. Create `ko/main` from `origin/main` in a verified path under the workspace. Confirm the worktree is clean before copying any asset.

- [ ] **Step 2: Copy the exact automation allowlist**

Use a manifest-driven copy command, not a broad directory copy. The manifest must list each retained top-level path and reject `pob-zh-engine/host/*.cpp` and `*.h`. Include Korean data and fonts that are source inputs to packaging.

- [ ] **Step 3: Verify upstream source identity before committing**

For every tracked `pob-zh-engine/host/*.cpp`, `*.h`, root `ui_*.cpp`, and `ui_*.h`, compare the blob ID with `ba33ed80de67d8301baad930456131d581df6ae1`. Expected: no differences. Allow only the compatibility patch artifact, not applied source.

- [ ] **Step 4: Reproduce Korean source in a temporary worktree**

Run `update-upstream.mjs` against the branch's pinned state. Expected: `ready`, source display issues `0`, and no modified generated C++ in the `ko/main` worktree itself.

- [ ] **Step 5: Commit and push the clean branch**

```powershell
git add --all
git diff --cached --check
git commit -m "feat: establish data-driven Korean maintenance branch"
git push -u origin ko/main
```

Keep `ko/complete-localization` as the historical direct-source branch until the first `ko/main` preview passes runtime smoke testing.

- [ ] **Step 6: Make `ko/main` the fork's default branch**

After the pushed branch is green, change only `hotddokGH/PobTools-kr`'s default branch from `main` to `ko/main` and verify the repository reports `default_branch: ko/main`. Keep `main` as the clean upstream mirror. This is required because GitHub runs scheduled workflows only from the default branch; do not enable the daily schedule before this setting is verified.

---

### Task 8: Add the Read-only Validation Workflow

**Files:**
- Create: `.github/workflows/validate-ko.yml`
- Create: `localization/ko-KR/tests/workflow-contract.test.mjs`
- Modify: `docs/ko-KR/MAINTENANCE.md`

**Interfaces:**
- Consumes: pushes and pull requests targeting `ko/main`.
- Produces: unit-test status, deterministic reports, and uploaded validation artifacts without repository write permission.

- [ ] **Step 1: Write a workflow contract test**

Create a Node test that parses workflow text and asserts:

```js
assert.match(text, /permissions:\s*\n\s*contents: read/u);
assert.match(text, /runs-on: (?:ubuntu-24\.04|windows-2025-vs2026)/u);
assert.doesNotMatch(text, /pull-requests: write|contents: write/u);
assert.match(text, /node --test localization\/ko-KR\/tests\/\*\.test\.mjs/u);
assert.match(text, /Test-KoreanLocale\.ps1/u);
assert.match(text, /Test-OfficialTerms\.ps1/u);
for (const use of text.matchAll(/uses:\s*([^\s]+)/gu)) {
  assert.match(use[1], /^[^@]+@[0-9a-f]{40}$/u, `floating Action ref: ${use[1]}`);
}
assert.doesNotMatch(text, /gh release|softprops\/action-gh-release/u);
```

- [ ] **Step 2: Run the contract and verify RED**

Expected: fail because `validate-ko.yml` does not exist.

- [ ] **Step 3: Create the workflow**

Use checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-node `820762786026740c76f36085b0efc47a31fe5020`, setup-python `5fda3b95a4ea91299a34e894583c3862153e4b97`, and upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`. Install `localization/ko-KR/requirements-overlay.txt`, run Python overlay tests, all Node tests, both PowerShell contracts, both deterministic builders twice with explicit target roots, and compare hashes. Upload only reports and test logs.

- [ ] **Step 4: Prove least privilege and commit**

Run the workflow contract locally, inspect YAML permissions, commit, push `ko/main`, and verify one green pull-request or manual run.

---

### Task 9: Add Scheduled Upstream Detection and Maintenance PRs

**Files:**
- Create: `.github/workflows/check-upstream.yml`
- Create: `localization/ko-KR/render-maintenance-pr.mjs`
- Create: `localization/ko-KR/lib/maintenance-bundle.mjs`
- Create: `localization/ko-KR/tests/maintenance-pr.test.mjs`
- Create: `localization/ko-KR/tests/maintenance-bundle.test.mjs`
- Modify: `localization/ko-KR/tests/workflow-contract.test.mjs`
- Modify: `docs/ko-KR/MAINTENANCE.md`

**Interfaces:**
- Consumes: daily schedule or manual dispatch, `upstream/main`, deterministic maintenance report.
- Produces: one branch named `automation/upstream-ko`, one updated PR, and report artifacts; never a Release.

- [ ] **Step 1: Write failing PR-rendering tests**

Given a fixture report, require a Korean Markdown body with upstream range, reused count, review rows grouped by code, compatibility failures, and exact next commands. Snapshot the complete expected body so formatting changes are reviewed.

- [ ] **Step 2: Run tests and verify RED**

Expected: `ERR_MODULE_NOT_FOUND` for `render-maintenance-pr.mjs`.

- [ ] **Step 3: Implement deterministic PR rendering**

Export `renderMaintenancePr(report) -> {title, body, labels}`. Validate the commit as 40 lowercase hex characters, escape Markdown/control characters in upstream-provided strings, and never interpolate report values into a shell command. Do not include current time. Construct the title as ``chore: review upstream ${report.upstreamCommit.slice(0, 7)} for Korean release``; labels are `localization` and `upstream-sync` when those labels exist. Pass the rendered body to `gh pr create/edit` through `--body-file`.

- [ ] **Step 4: Create the scheduled workflow with split permissions**

Use a read-only `analyze` job to add/fetch `https://github.com/Hsiung-Shao/PobTools-zh.git` as `upstream` and run `update-upstream.mjs`. Reuse the exact pinned checkout, setup-node, and setup-python SHAs from Task 8. Capture exit `0`, `1`, or `2` into a step output instead of letting exit `2` stop artifact upload; after upload, fail the job only for exit `1`. Upload the deterministic report and a maintenance bundle with `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`.

The bundle contains only these repository-relative paths: `reports/maintenance/upstream-update.json`, `localization/ko-KR/source-translation-suggestions.json`, `pob-zh-engine/dist/Data/launcher/ko-KR/**`, `pob-zh-engine/dist/Data/poe1/ko-KR/**`, `reports/display-closure/**`, and `reports/official-terms/**`. `maintenance-bundle.mjs` writes and verifies a sorted SHA-256 manifest, rejects `..`, absolute paths, symlinks, and every path outside that allowlist, and copies files without executing them.

A second `propose` job uses `contents: write` and `pull-requests: write`, downloads the bundle with `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`, verifies it with the trusted checked-out Korean script, copies only validated files, renders trusted text, updates only `automation/upstream-ko`, and calls the preinstalled `gh` CLI using `${{ github.token }}`.

Use:

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: '17 3 * * *'
concurrency:
  group: pobtools-ko-upstream-maintenance
  cancel-in-progress: false
```

The write job must never compile or execute code from the upstream worktree. Add tests proving traversal, symlink, unlisted-path, and hash-mismatch bundles are rejected before any repository file is written.

Extend `workflow-contract.test.mjs` to require separate `analyze` and `propose` permissions, pinned Action SHAs, captured exit `2`, the fixed branch `automation/upstream-ko`, and absence of any Release command or event.

- [ ] **Step 5: Test manual dispatch before enabling schedule**

Push the workflow with the schedule temporarily commented out, run it manually, confirm it opens or updates exactly one PR, then enable the schedule in a separate commit. GitHub forks may require enabling the workflow from the Actions tab once.

- [ ] **Step 6: Commit documentation and workflow**

Document how to interpret `ready`, `review-required`, and `blocked`, how to edit JSON review rows, and how to rerun validation. Commit and push.

---

### Task 10: Convert Preview Build to Clean-Upstream Generation and Complete the First Artifact

**Files:**
- Modify: `.github/workflows/build-ko-preview.yml`
- Modify: `localization/ko-KR/Assemble-KoreanPackage.ps1`
- Create: `localization/ko-KR/write-build-provenance.mjs`
- Create: `localization/ko-KR/tests/build-provenance.test.mjs`
- Modify: `tests/ko-KR/Test-KoreanPackage.ps1`
- Create: `docs/verification/2026-09-01-ko-maintenance-automation.md`
- Create: `docs/ko-KR/INSTALL.md`
- Create: `docs/ko-KR/PREVIEW-NOTES.md`
- Modify: `docs/ko-KR/MAINTENANCE.md`

**Interfaces:**
- Consumes: reviewed upstream state, clean `ko/main`, compatibility patch, canonical source map, and Korean assets.
- Produces: tested unsigned preview ZIP, SHA-256 manifest, provenance report, and human-readable verification record.

- [ ] **Step 1: Make build input the generated temporary worktree**

Change `build-ko-preview.yml` so it runs `update-upstream.mjs --force-prepare` for `upstream-state.json:lastReviewedCommit`, builds `.ko-worktrees/release/pob-zh-engine`, and never builds tracked upstream source directly. Abort unless classification is `ready` or `already-processed` with zero issues and the prepared worktree commit exactly equals `lastReviewedCommit`.

Implement `write-build-provenance.mjs` with a fixture-tested schema containing upstream SHA, Korean automation SHA, official PoE patch, compatibility patch SHA, mapping/data hashes, runner image, workflow run ID/attempt, build configuration, and unsigned status. Generate `reports/build/preview-provenance.json`; upload it beside the ZIP and hash manifest. Do not derive trusted SHAs from the generated upstream tree.

- [ ] **Step 2: Add executable self-tests before packaging**

Run:

```powershell
& .ko-worktrees/release/pob-zh-engine/install-ko/pob-zh.exe --font-coverage-selftest
if ($LASTEXITCODE -ne 0) { throw 'font coverage self-test failed' }
& .ko-worktrees/release/pob-zh-engine/install-ko/pob-zh.exe --app-update-selftest
if ($LASTEXITCODE -ne 0) { throw 'offline updater self-test failed' }
$signature = Get-AuthenticodeSignature -LiteralPath '.ko-worktrees/release/pob-zh-engine/install-ko/pob-zh.exe'
if ($signature.Status -ne 'NotSigned') { throw "unexpected Authenticode status: $($signature.Status)" }
```

Require both known offline tests to exit `0`. The static `korean-update-contract.test.mjs` remains the contract that `POBTOOLS_KOREAN_RELEASE` disables the worker and every updater entry point; do not invoke network-facing `--update-source`, `--app-update`, or `--app-update-check` in preview CI.

- [ ] **Step 3: Retest the extracted ZIP**

Set `$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)` and `$extract = [IO.Path]::GetFullPath((Join-Path $runnerTemp 'pobtools-ko-package'))`. Reject equality with `$runnerTemp` and any value not starting with `$runnerTemp + [IO.Path]::DirectorySeparatorChar`; only then remove an existing `$extract`. Expand the ZIP there, run `Test-KoreanPackage.ps1 -PackageRoot $extract`, compare its sorted file hashes with `manifest.files`, and verify `manifest.archive.sha256` and `manifest.archive.bytes` against the ZIP before deleting only that validated `$extract`.

- [ ] **Step 4: Write Korean install and security documentation**

State that PobTools does not bundle Path of Building Community, show the sibling-folder layout, explain `Locale=ko-KR`, and provide the unsigned SmartScreen procedure without claiming the file is trusted merely because it is open source. Tell users to compare the published SHA-256 before running. Write first-preview limitations and smoke-test status in `PREVIEW-NOTES.md`.

Modify the assembler to copy these documents into the package as `INSTALL-KO.md` and `PREVIEW-NOTES-KO.md`; modify the package contract to require both files. The workflow uploads the ZIP, hash manifest, provenance JSON, and preview notes as one artifact and still has no Release permission.

- [ ] **Step 5: Run the full verification set**

```powershell
python localization/ko-KR/tests/test_source_overlay.py
python localization/ko-KR/tests/test_source_migration.py
node --test localization/ko-KR/tests/*.test.mjs
node localization/ko-KR/audit-display-closure.mjs
node localization/ko-KR/audit-source-display.mjs --engine-root .ko-worktrees/release/pob-zh-engine
pwsh -NoProfile -File tests/ko-KR/Test-KoreanLocale.ps1
pwsh -NoProfile -File tests/ko-KR/Test-OfficialTerms.ps1
$packageRoot = Join-Path $env:RUNNER_TEMP 'pobtools-ko-package'
pwsh -NoProfile -File tests/ko-KR/Test-KoreanPackage.ps1 -PackageRoot $packageRoot
```

Expected: every command exits `0`; runtime closure remains `20,371/20,371` or a larger fully resolved inventory, generated source issues remain `0`, and the extracted ZIP manifest matches.

- [ ] **Step 6: Record evidence and commit**

The verification document records upstream SHA, Korean automation SHA, official PoE patch, dictionary hashes/counts, overlay reuse/new counts, compatibility patch SHA, runner image, CMake commands, test exits, ZIP file count/hash, unsigned status, and known intentional literals.

Commit source, workflows, tests, mappings, docs, and evidence. Do not commit the binary ZIP.

- [ ] **Step 7: Keep release publication manual**

Upload the successful artifact from the workflow for user inspection. Do not create a GitHub Release until the launcher, settings, filter editor, atlas planner, passive tools, item paste, and error dialogs have been manually smoke-tested. After approval, add a separate protected release job in a new design rather than silently expanding this workflow's permissions.

---

## Final Verification Checklist

- [ ] `origin/main` and `upstream/main` remain identical at the reviewed upstream commit.
- [ ] `ko/main` contains no generated Korean C++ source files.
- [ ] Applying the canonical map and compatibility patch to the pinned upstream commit produces zero source-display issues.
- [ ] Machine suggestions cannot pass the accepted-status gate.
- [ ] Daily upstream detection creates or updates one maintenance PR and never a Release.
- [ ] Pull-request validation has read-only permissions.
- [ ] Build workflow uses a pinned Windows image and pinned Action SHAs.
- [ ] A failed update leaves the previous artifact and release untouched.
- [ ] Extracted ZIP passes the same package contract as the staging directory.
- [ ] User can download and visually test an unsigned Korean preview without installing Visual Studio locally.
