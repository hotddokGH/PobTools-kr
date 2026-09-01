# PobTools PoE1 Complete Korean Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a maintainable, source-based PobTools v1.1.0 Korean release whose reachable PoE1 launcher, Path of Building, and PobTools tool surfaces contain no unresolved display text.

**Architecture:** Keep English identities and saved data unchanged, and translate only at the existing PobTools display boundary. Merge current-patch official Korean mappings first, reviewed PoB-only UI second, and an explicit literal allowlist last; audit both JSON dictionaries and C++ display literals before building and packaging.

**Tech Stack:** C++17, CMake, Visual Studio 18 2026, PowerShell 7, Node.js ESM and `node:test`, JSON, existing PobTools translation engine.

**Spec:** `docs/superpowers/specs/2026-09-01-pobtools-ko-complete-localization-design.md`

## Global Constraints

- Translate PoE1 only; do not add or modify PoE2 locale content.
- Use official Korean client patch `3.29.3.2` as the authority for game terminology.
- Preserve `PobTools-1.1.0` byte-for-byte; perform all source work in sibling directory `PobTools-ko-source`.
- Do not use Traditional or Simplified Chinese dictionary values as Korean translation source text.
- Keep internal English identities, build storage, parsers, calculation data, and trade API values unchanged.
- Keep `UpdateTranslations=0`; do not enable a Korean automatic update channel without a Korean repository and signing key.
- Preserve printf tokens, numbered placeholders, newlines, color tags, keyboard labels, URLs, and executable names.
- Package only runtime files, Noto Sans KR, its OFL notice, product notices, and user documentation.
- The public gate requires zero unresolved reachable display entries, zero Chinese display literals, and zero broken format signatures.

---

### Task 1: Establish the permanent source baseline and import the verified preview

**Files:**
- Create repository directory: `../PobTools-ko-source`
- Create branch: `ko/complete-localization`
- Create: `PobTools-ko-source/reports/baseline/original-distribution.sha256.json`
- Create: `PobTools-ko-source/localization/ko-KR/README.md`
- Import: `PobTools-ko-source/pob-zh-engine/dist/Data/launcher/ko-KR/*`
- Import: `PobTools-ko-source/pob-zh-engine/dist/Data/poe1/ko-KR/*`
- Import: `PobTools-ko-source/pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf`
- Import: `PobTools-ko-source/pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt`
- Import: `PobTools-ko-source/localization/ko-KR/official-terms/*`
- Import: `PobTools-ko-source/reports/official-terms/*`
- Import: `PobTools-ko-source/tests/ko-KR/Test-KoreanLocale.ps1`
- Import: `PobTools-ko-source/tests/ko-KR/Test-OfficialTerms.ps1`

**Interfaces:**
- Consumes: upstream tag `v1.1.0` at commit `baf07d41d2df524d4330a58b411826339c93fac1`; verified preview directory `../PobTools-ko-test`; preserved distribution `../PobTools-1.1.0`.
- Produces: Git-tracked Korean source baseline and SHA-256 manifest consumed by every later task.

- [x] **Step 1: Hash the untouched distribution and verify the current preview tests**

Run from `PobTools-ko-test`:

```powershell
$koOriginal = Resolve-Path '..\PobTools-1.1.0'
$koFiles = Get-ChildItem -LiteralPath $koOriginal -Recurse -File | Sort-Object FullName
$koRows = foreach ($koFile in $koFiles) {
    [ordered]@{
        path = $koFile.FullName.Substring($koOriginal.Path.Length + 1).Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $koFile.FullName -Algorithm SHA256).Hash
    }
}
$koRows | ConvertTo-Json -Depth 3
pwsh -NoProfile -File .\tests\Test-KoreanLocale.ps1
pwsh -NoProfile -File .\tests\Test-OfficialTerms.ps1
```

Expected: both tests print `PASS`; the JSON contains one record for every original file.

- [x] **Step 2: Create the dedicated source repository and branch**

```powershell
$koParent = Resolve-Path '..'
$koSource = Join-Path $koParent 'PobTools-ko-source'
git clone --branch v1.1.0 --single-branch https://github.com/Hsiung-Shao/PobTools-zh.git $koSource
git -C $koSource switch -c ko/complete-localization
git -C $koSource rev-parse HEAD
```

Expected: HEAD is `baf07d41d2df524d4330a58b411826339c93fac1` and branch is `ko/complete-localization`.

- [x] **Step 3: Import only the verified Korean assets and development evidence**

Use `Copy-Item -LiteralPath` for files and explicit source/destination directories. Do not copy `translate_misses.log`, `PobTools/cache`, personal INI state other than the release template, `node_modules`, or `MalgunGothic-TestOnly.ttf`; retain `package.json` and `package-lock.json` so `npm ci` reconstructs development dependencies.

Create `localization/ko-KR/README.md` with these exact invariants:

```markdown
# Korean localization sources

- Runtime target: `pob-zh-engine/dist/Data/{launcher,poe1}/ko-KR`
- Official terminology patch: `3.29.3.2`
- Game terms: official English/Korean stable-ID or structural joins only
- PoB-only UI: reviewed manual Korean text
- Chinese dictionaries: key inventory only, never translation source
- Public runtime configuration: `Game=poe1`, `Locale=ko-KR`, `UpdateTranslations=0`
```

- [x] **Step 4: Save the baseline hash manifest**

Write `reports/baseline/original-distribution.sha256.json` as:

```json
{
  "source": "../PobTools-1.1.0",
  "algorithm": "SHA256",
  "files": [
    { "path": "relative/path", "sha256": "UPPERCASE_HEX" }
  ]
}
```

The file list must be ordinally sorted by `/`-normalized relative path.

- [x] **Step 5: Run imported contracts from the source layout**

Modify the two imported PowerShell tests so `$runtimeRoot` resolves to `pob-zh-engine/dist` and `$reportRoot` resolves to repository `reports/official-terms`. Run:

```powershell
pwsh -NoProfile -File .\tests\ko-KR\Test-KoreanLocale.ps1
pwsh -NoProfile -File .\tests\ko-KR\Test-OfficialTerms.ps1
```

Expected: both print `PASS` from `PobTools-ko-source`.

- [x] **Step 6: Commit the source baseline**

```powershell
git add pob-zh-engine/dist/Data/launcher/ko-KR pob-zh-engine/dist/Data/poe1/ko-KR pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt localization reports tests
git commit -m "chore: establish Korean localization baseline"
```

---

### Task 2: Add a deterministic display-closure audit

**Files:**
- Create: `localization/ko-KR/lib/format-signature.mjs`
- Create: `localization/ko-KR/lib/locale-audit.mjs`
- Create: `localization/ko-KR/audit-display-closure.mjs`
- Create: `localization/ko-KR/display-policy.json`
- Create: `localization/ko-KR/tests/locale-audit.test.mjs`
- Create locally at runtime: `reports/display-closure/locale-audit.json` (ignored because unresolved payloads are large)
- Create: `reports/display-closure/locale-audit-summary.json`

**Interfaces:**
- Consumes: runtime dictionary roots `pob-zh-engine/dist/Data/poe1/{zh-rTW,ko-KR}` and `display-policy.json`.
- Produces: `formatSignature(text) -> string[]`; `auditLocale({referenceRoot,targetRoot,policy}) -> AuditReport`; process exit `1` when `issues.length > 0`.

- [x] **Step 1: Write failing unit tests for format and locale closure**

Create `localization/ko-KR/tests/locale-audit.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSignature } from '../lib/format-signature.mjs';
import { auditEntries } from '../lib/locale-audit.mjs';

test('formatSignature preserves printf, numbered placeholders, newlines and colour tags', () => {
  assert.deepEqual(
    formatSignature('Gain {0}% of %s\n^xFF00FFDamage'),
    ['LF', 'PRINTF:%s', 'SLOT:{0}', 'TAG:^xFF00FF'],
  );
});

test('auditEntries rejects unresolved English and Chinese but permits documented literals', () => {
  const report = auditEntries({
    dictionary: 'ui',
    reference: { Build: '組建', DPS: '每秒傷害', Notes: '備註' },
    target: { Build: 'Build', DPS: 'DPS', Notes: '備註' },
    policy: { literalAllowlist: { ui: { DPS: 'standard acronym' } }, excluded: {} },
  });
  assert.deepEqual(report.issues.map((issue) => issue.code), ['UNRESOLVED_ENGLISH']);
});

test('auditEntries rejects a damaged placeholder signature', () => {
  const report = auditEntries({
    dictionary: 'ui',
    reference: { 'Level {0}': '等級 {0}' },
    target: { 'Level {0}': '레벨' },
    policy: { literalAllowlist: {}, excluded: {} },
  });
  assert.equal(report.issues[0].code, 'FORMAT_MISMATCH');
});
```

- [x] **Step 2: Run the tests and verify RED**

```powershell
node --test .\localization\ko-KR\tests\locale-audit.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `format-signature.mjs` or `locale-audit.mjs`.

- [x] **Step 3: Implement format extraction and entry auditing**

`format-signature.mjs` must export:

```js
export function formatSignature(text) {
  const tokens = [];
  for (const match of text.matchAll(/%(?:[-+0 #]*\d*(?:\.\d+)?)?[A-Za-z]/g)) tokens.push(`PRINTF:${match[0]}`);
  for (const match of text.matchAll(/\{\d+\}/g)) tokens.push(`SLOT:${match[0]}`);
  for (const match of text.matchAll(/\^(?:x[0-9A-Fa-f]{6}|\d)/g)) tokens.push(`TAG:${match[0]}`);
  for (let index = 0; index < (text.match(/\n/g)?.length ?? 0); index += 1) tokens.push('LF');
  return tokens.sort();
}
```

`locale-audit.mjs` must export `auditEntries` and `auditLocale`. Issue codes are exactly:

```text
MISSING_KEY
EMPTY_VALUE
CHINESE_DISPLAY
UNRESOLVED_ENGLISH
FORMAT_MISMATCH
UNEXPLAINED_EXCLUSION
UNEXPLAINED_LITERAL
```

Treat Han code points as Chinese display only when the target value contains `\p{Script=Han}`. Treat exact English identity as unresolved unless `literalAllowlist[dictionary][key]` is a non-empty reason or `excluded[dictionary][key]` is a non-empty reason. Do not reject Korean values that legitimately contain ASCII tokens alongside Hangul.

- [x] **Step 4: Run unit tests and verify GREEN**

```powershell
node --test .\localization\ko-KR\tests\locale-audit.test.mjs
```

Expected: 5 tests, 5 pass, 0 fail, including the Chinese-target and compact-summary regression cases added during implementation.

- [x] **Step 5: Add the real CLI and a minimal policy**

`audit-display-closure.mjs` must:

```js
const report = auditLocale({
  referenceRoot: resolve('pob-zh-engine/dist/Data/poe1/zh-rTW'),
  targetRoot: resolve('pob-zh-engine/dist/Data/poe1/ko-KR'),
  policy: JSON.parse(readFileSync(resolve('localization/ko-KR/display-policy.json'), 'utf8')),
});
mkdirSync(resolve('reports/display-closure'), { recursive: true });
writeFileSync(resolve('reports/display-closure/locale-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`display closure: ${report.resolved}/${report.total}; issues=${report.issues.length}`);
process.exitCode = report.issues.length === 0 ? 0 : 1;
```

Start `display-policy.json` with empty per-dictionary maps and documented product literals only:

```json
{
  "literalAllowlist": {
    "ui": {
      "Path of Building": "upstream product name",
      "PoB": "standard product abbreviation",
      "DPS": "standard game-community acronym"
    }
  },
  "excluded": {}
}
```

- [x] **Step 6: Run the real audit and verify the expected RED baseline**

```powershell
node .\localization\ko-KR\audit-display-closure.mjs
```

Expected: exit `1`; local `reports/display-closure/locale-audit.json` lists unresolved current dictionary entries and tracked `locale-audit-summary.json` records compact counts. This failure is the gate later translation tasks must close.

- [x] **Step 7: Commit the audit gate**

```powershell
git add localization/ko-KR reports/display-closure
git commit -m "test: add Korean display closure gate"
```

---

### Task 3: Consolidate official mappings into a deterministic locale merger

**Files:**
- Create: `localization/ko-KR/lib/merge-layers.mjs`
- Create: `localization/ko-KR/build-runtime-locale.mjs`
- Create: `localization/ko-KR/manual/pob-ui.json`
- Create: `localization/ko-KR/manual/dynamic-patterns.json`
- Create: `localization/ko-KR/tests/merge-layers.test.mjs`
- Modify: `localization/ko-KR/official-terms/*.mjs`
- Modify: `localization/ko-KR/official-terms/*.ps1`
- Regenerate: `pob-zh-engine/dist/Data/poe1/ko-KR/*.json`
- Create: `reports/display-closure/provenance.json`

**Interfaces:**
- Consumes: exact official mapping reports, normalized official stat templates, reviewed manual UI, reference English keys, and `display-policy.json`.
- Produces: `mergeLayers({reference,officialExact,officialPatterns,manual,literals}) -> {entries,provenance,conflicts}` and eight deterministic runtime dictionaries.

- [x] **Step 1: Write failing precedence and conflict tests**

Create `merge-layers.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayers } from '../lib/merge-layers.mjs';

test('official exact terms override manual UI wording', () => {
  const result = mergeLayers({
    dictionary: 'gems',
    reference: { Arc: true },
    officialExact: { Arc: { value: '연쇄 번개', source: 'ActiveSkills/Arc' } },
    officialPatterns: {},
    manual: { Arc: '아크' },
    literals: {},
  });
  assert.equal(result.entries.Arc, '연쇄 번개');
  assert.equal(result.provenance.Arc.layer, 'official-exact');
});

test('a conflicting official identity is not applied', () => {
  assert.throws(() => mergeLayers({
    dictionary: 'items',
    reference: { Example: true },
    officialExact: { Example: { conflict: ['예시', '견본'] } },
    officialPatterns: {}, manual: {}, literals: {},
  }), /official conflict: items\/Example/);
});

test('manual text may fill PoB-only UI when no official row exists', () => {
  const result = mergeLayers({
    dictionary: 'ui', reference: { 'Full DPS': true }, officialExact: {}, officialPatterns: {},
    manual: { 'Full DPS': '전체 DPS' }, literals: {},
  });
  assert.equal(result.entries['Full DPS'], '전체 DPS');
  assert.equal(result.provenance['Full DPS'].layer, 'manual-pob-ui');
});
```

- [x] **Step 2: Run the merge tests and verify RED**

```powershell
node --test .\localization\ko-KR\tests\merge-layers.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `merge-layers.mjs`.

- [x] **Step 3: Implement strict layer precedence**

Implement this exact precedence in `mergeLayers`:

```text
official-exact
official-structural-pattern
manual-pob-ui
intentional-literal
unresolved
```

Require every selected value to be non-empty and every provenance record to contain `layer` and `source`. Throw on official conflicts, conflicting same-layer values, or format signature mismatch.

- [x] **Step 4: Run merge tests and verify GREEN**

```powershell
node --test .\localization\ko-KR\tests\merge-layers.test.mjs
```

Expected: 3 tests, 3 pass, 0 fail.

- [x] **Step 5: Refactor existing official scripts to the source layout**

Replace hard-coded distribution-root assumptions with these two roots:

```text
repository root = three parents above localization/ko-KR/official-terms
runtime root    = <repository>/pob-zh-engine/dist
report root     = <repository>/reports/official-terms
```

Keep all pinned hashes, tool version `15.2.0`, patch `3.29.3.2`, stable-ID joins, and conflict exclusions unchanged. Run the current official contracts after moving the scripts.

- [x] **Step 6: Implement structural pattern matching for official stat text**

Store each entry in `dynamic-patterns.json` as:

```json
{
  "source": "{0}% increased maximum Life",
  "target": "최대 생명력 {0}% 증가",
  "identity": "official stat-id set and handler signature",
  "patch": "3.29.3.2"
}
```

Normalize only decimal numbers, signed numbers, ranges, numbered placeholders, color tags, and line breaks. A pattern applies only when the normalized English text and official structural identity both match. Reject patterns whose source and target format signatures differ.

- [x] **Step 7: Build all eight dictionaries twice and prove determinism**

```powershell
node .\localization\ko-KR\build-runtime-locale.mjs
$koFirst = Get-ChildItem '.\pob-zh-engine\dist\Data\poe1\ko-KR\*.json' | Sort-Object Name | Get-FileHash -Algorithm SHA256
node .\localization\ko-KR\build-runtime-locale.mjs
$koSecond = Get-ChildItem '.\pob-zh-engine\dist\Data\poe1\ko-KR\*.json' | Sort-Object Name | Get-FileHash -Algorithm SHA256
Compare-Object $koFirst.Hash $koSecond.Hash
```

Expected: `Compare-Object` emits no rows; official and locale tests pass.

- [x] **Step 8: Commit the deterministic builder**

```powershell
git add localization/ko-KR pob-zh-engine/dist/Data/poe1/ko-KR reports/official-terms reports/display-closure/provenance.json tests/ko-KR
git commit -m "feat: build Korean locale from verified layers"
```

---

### Task 4: Close PoB-only UI and current runtime dictionary gaps

**Files:**
- Create: `localization/ko-KR/reference/PathOfBuilding-kor.json`
- Create: `localization/ko-KR/reference/NOTICE.md`
- Modify: `localization/ko-KR/manual/pob-ui.json`
- Modify: `localization/ko-KR/manual/dynamic-patterns.json`
- Modify: `localization/ko-KR/display-policy.json`
- Regenerate: `pob-zh-engine/dist/Data/poe1/ko-KR/*.json`
- Regenerate: `reports/display-closure/locale-audit.json`

**Interfaces:**
- Consumes: unresolved rows emitted by Task 2, official precedence from Task 3, and MIT reference commit `4b4129ef80818f38a221e51ac4cee17cb680b94b`.
- Produces: zero-issue runtime dictionary closure and a reviewed provenance record for every non-official display value.

**Reachability evidence:** The current runtime capture from `../PobTools-1.1.0/translate_misses.log`
contains 20,371 unique display strings and is pinned by SHA-256
`D2DB8A3DFA05F9E614014783BE412523274C71A09C063CA2B92CF952FCBAE6AB`.
It is the blocking closure inventory. The 111,806-key `zh-rTW` inventory spans older
upstream versions and remains visible as a non-blocking historical comparison in the
summary report; its Chinese values are never used as Korean source text.

- [x] **Step 1: Pin and document the external PoB-only UI reference**

Create `reference/PathOfBuilding-kor.json`:

```json
{
  "repository": "https://github.com/antonio-kim-77/PathOfBuilding-kor",
  "commit": "4b4129ef80818f38a221e51ac4cee17cb680b94b",
  "tag": "v2.60.0-kor-a6",
  "license": "MIT",
  "allowedUse": "PoB-only UI wording reference; game terminology is replaced by official patch mappings"
}
```

Copy the upstream MIT license notice into `reference/NOTICE.md` and add attribution to repository `NOTICE.md`.

- [x] **Step 2: Generate the first unresolved report after official expansion**

```powershell
node .\localization\ko-KR\build-runtime-locale.mjs
node .\localization\ko-KR\audit-display-closure.mjs
```

Expected: exit `1`; each issue includes dictionary, English key, issue code, and current provenance state.

- [x] **Step 3: Translate unresolved current UI by domain**

Process `ui`, `passives`, `gems`, `items`, `uniques`, `monsters`, `stats`, and `tags` in that order. For each issue:

```text
If an official exact or structural mapping exists: fix the join or pattern layer.
If it is PoB-only visible UI: add reviewed Korean to manual/pob-ui.json.
If it is a dynamic visible template: add a source/target/identity entry to dynamic-patterns.json.
If it is a product name, acronym, file name, URL, or keyboard label: add a non-empty reason to literalAllowlist.
If source inspection proves it unreachable in current PoB: add file, source location, and reason to excluded.
Otherwise: leave it unresolved and keep the audit red.
```

Do not add a literal or exclusion merely to reduce the issue count. Every manual Korean entry must preserve `formatSignature(key)`.

- [x] **Step 4: Run closure after each dictionary domain**

```powershell
node .\localization\ko-KR\build-runtime-locale.mjs
node .\localization\ko-KR\audit-display-closure.mjs
pwsh -NoProfile -File .\tests\ko-KR\Test-KoreanLocale.ps1
pwsh -NoProfile -File .\tests\ko-KR\Test-OfficialTerms.ps1
```

Expected after the final domain: `issues=0`; both PowerShell tests print `PASS`.

- [x] **Step 5: Verify no Korean game term was sourced from the UI reference**

Add an assertion to `Test-OfficialTerms.ps1`: every provenance row in dictionaries `tags`, `items`, `gems`, `stats`, `passives`, `uniques`, and `monsters` whose English key exists in an accepted official report must have layer `official-exact` or `official-structural-pattern`.

Run:

```powershell
pwsh -NoProfile -File .\tests\ko-KR\Test-OfficialTerms.ps1
```

Expected: PASS with zero provenance precedence violations.

- [x] **Step 6: Commit runtime display closure**

```powershell
git add localization/ko-KR pob-zh-engine/dist/Data/poe1/ko-KR reports/display-closure reports/official-terms NOTICE.md tests/ko-KR
git commit -m "feat: complete Korean PoE1 runtime dictionaries"
```

---

### Task 5: Translate hardcoded PobTools surfaces and disable unsafe upstream updates

**Files:**
- Create: `localization/ko-KR/lib/source-display-audit.mjs`
- Create: `localization/ko-KR/audit-source-display.mjs`
- Create: `localization/ko-KR/source-display-policy.json`
- Create: `localization/ko-KR/tests/source-display-audit.test.mjs`
- Modify: `pob-zh-engine/host/*.cpp`
- Modify: `pob-zh-engine/host/*.h`
- Modify when reported as display-bearing: `pob-zh-engine/ui_*.cpp`
- Modify when reported as display-bearing: `pob-zh-engine/ui_*.h`
- Modify: `pob-zh-engine/CMakeLists.txt`
- Modify: `pob-zh-engine/dist/pob-zh.ini`
- Create at runtime: `reports/display-closure/source-audit.json`

**Interfaces:**
- Consumes: C++ UTF-8 string literals in `host`, Korean release compile option, and documented internal-Chinese exceptions.
- Produces: `scanSourceDisplay({engineRoot,policy}) -> SourceAuditReport`; CMake option `POBTOOLS_KOREAN_RELEASE`; Korean launcher/tool strings; remote update checks disabled in Korean builds.

- [ ] **Step 1: Write failing source-literal audit tests**

Create `source-display-audit.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSourceText } from '../lib/source-display-audit.mjs';

test('visible ImGui Chinese literal is rejected', () => {
  const report = auditSourceText('ImGui::Button(u8"設定");', { internalLiteralAllowlist: [] });
  assert.equal(report.issues[0].code, 'CHINESE_SOURCE_DISPLAY');
});

test('Korean ImGui literal and internal parser fixture are accepted', () => {
  assert.equal(auditSourceText('ImGui::Button(u8"설정");', { internalLiteralAllowlist: [] }).issues.length, 0);
  assert.equal(auditSourceText('const char* fixture = u8"稀有度";', {
    internalLiteralAllowlist: [{ sha256: 'fixture-hash', reason: 'reverse parser fixture' }],
  }).issues.length, 0);
});
```

The real implementation computes literal hashes; the fixture test must use the hash returned by exported `literalSha256('稀有度')` rather than the illustrative string `fixture-hash`.

- [ ] **Step 2: Run source audit tests and verify RED**

```powershell
node --test .\localization\ko-KR\tests\source-display-audit.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement source string classification**

Scan `.cpp` and `.h` files under `pob-zh-engine/host` plus root-level `pob-zh-engine/ui_*.cpp` and `pob-zh-engine/ui_*.h`. Treat literals passed to ImGui, launcher labels, status messages, errors, dialogs, tooltips, menu items, window titles, and user-facing log summaries as display strings. Permit Chinese only when `source-display-policy.json` contains the literal SHA-256 and a non-empty internal parser/data reason.

The report must contain:

```json
{
  "filesScanned": 0,
  "displayLiterals": 0,
  "koreanDisplayLiterals": 0,
  "allowedInternalLiterals": 0,
  "issues": []
}
```

- [ ] **Step 4: Verify GREEN on fixtures and RED on the real source**

```powershell
node --test .\localization\ko-KR\tests\source-display-audit.test.mjs
node .\localization\ko-KR\audit-source-display.mjs
```

Expected: unit tests pass; real audit exits `1` and inventories hardcoded Chinese display literals.

- [ ] **Step 5: Translate hardcoded displays file by file**

Translate every display issue from the real report. Preserve ImGui `##id` suffixes, `%` tokens, newlines, accelerators, URLs, control keys, and string concatenation boundaries. Keep Chinese reverse-parser fixtures in `translate/translation_manager.cpp` outside the display scan and document each allowed host-side internal literal by hash.

Use official Korean names for PoE mechanics shown by atlas, filter, regex, timeless-jewel, paste, item-card, and passive-tree tools. Use natural Korean for actions and explanations. Do not change algorithmic branches, IDs, serialized field names, or URL paths.

- [ ] **Step 6: Add the Korean release compile option with a behavior-first updater selftest**

Extend the existing app-update selftest with a Korean-release case that calls `RequestCheck(CheckReason::UserAsked)`, `StartAppUpdate()`, and `StartTranslationUpdate()` on an initialized updater and asserts that no command reaches the worker, no HTTP fetch hook is invoked, and the public status reports the Korean unavailable message. Build the selftest with `POBTOOLS_KOREAN_RELEASE=ON` and run it first.

Expected RED: the fetch hook is invoked or a command reaches the worker because the Korean compile branch does not exist yet.

Then add:

```cmake
option(POBTOOLS_KOREAN_RELEASE "Build the public Korean release" OFF)
if(POBTOOLS_KOREAN_RELEASE)
    target_compile_definitions(pob-zh PRIVATE POBTOOLS_KOREAN_RELEASE=1)
endif()
```

Add `AppUpdater::RemoteUpdatesEnabled() const` returning `false` under `POBTOOLS_KOREAN_RELEASE` and `true` otherwise. In the Korean branch, `RequestCheck`, `StartAppUpdate`, and `StartTranslationUpdate` must return a Korean `이 한국어 시험판에서는 원격 업데이트를 사용할 수 없습니다` status before any command is queued or HTTP client is created. Extend the existing app-update selftest so a Korean build asserts `RemoteUpdatesEnabled() == false` and observes an empty command queue after each public request method. Translation dictionaries remain locally editable and `UpdateTranslations=0` in the release INI. Default upstream builds retain existing behavior.

- [ ] **Step 7: Run source closure and static contracts**

```powershell
node .\localization\ko-KR\audit-source-display.mjs
pwsh -NoProfile -File .\tests\ko-KR\Test-KoreanLocale.ps1
```

Expected: source issues `0`; Korean locale contract passes.

- [ ] **Step 8: Commit Korean source surfaces**

```powershell
git add localization/ko-KR pob-zh-engine/host pob-zh-engine/CMakeLists.txt pob-zh-engine/dist/pob-zh.ini reports/display-closure tests/ko-KR
git commit -m "feat: localize PobTools hardcoded surfaces"
```

---

### Task 6: Build, runtime-smoke, and package the public Korean release

**Files:**
- Create build directory: `PobTools-ko-source/pob-zh-engine/build-ko`
- Create install directory: `PobTools-ko-source/pob-zh-engine/dist-ko`
- Create: `tests/ko-KR/Test-KoreanPackage.ps1`
- Create: `docs/verification/2026-09-01-ko-KR-complete.md`
- Create: `pob-zh-engine/dist/PobTools-Korean-1.1.0-preview.zip`

**Interfaces:**
- Consumes: zero-issue JSON and source closure reports, source tree, official mappings, Noto Sans KR, and upstream PoB runtime folder.
- Produces: fresh installed runtime, verification evidence, and allowlisted public ZIP.

- [ ] **Step 1: Write the failing package contract**

Create `Test-KoreanPackage.ps1` with parameters `-PackageRoot` and `-BaselineManifest`. It must fail unless all of these are true:

```text
pob-zh.exe exists and is larger than 1 MiB
engine/SimpleGraphic.dll exists
Data/launcher/ko-KR/launcher.json exists
all eight Data/poe1/ko-KR dictionaries exist
Fonts/NotoSansKR-Variable.ttf and Fonts/OFL-NotoSansKR.txt exist
pob-zh.ini contains Game=poe1, Locale=ko-KR, UpdateTranslations=0
tools, reports, tests, node_modules, cache, logs and MalgunGothic-TestOnly.ttf are absent
every packaged JSON parses as UTF-8
the original distribution still matches original-distribution.sha256.json
```

- [ ] **Step 2: Run the package test and verify RED**

```powershell
pwsh -NoProfile -File .\tests\ko-KR\Test-KoreanPackage.ps1 -PackageRoot .\pob-zh-engine\dist-ko -BaselineManifest .\reports\baseline\original-distribution.sha256.json
```

Expected: FAIL because `dist-ko` does not yet exist.

- [ ] **Step 3: Configure, build, and install the Korean source**

```powershell
cmake -B .\pob-zh-engine\build-ko -S .\pob-zh-engine -G "Visual Studio 18 2026" -DPOBTOOLS_KOREAN_RELEASE=ON
cmake --build .\pob-zh-engine\build-ko --config Release
cmake --install .\pob-zh-engine\build-ko --config Release --prefix .\pob-zh-engine\dist-ko
```

Expected: all commands exit `0`.

- [ ] **Step 4: Assemble runtime-only Korean assets**

Copy the verified `ko-KR` dictionaries, Noto Sans KR, OFL notice, `NOTICE.md`, user documentation, and a release INI into `dist-ko`. Copy the clean `Path of Building Community` runtime from the preserved distribution without modifying its files.

- [ ] **Step 5: Run the full automated verification set**

```powershell
node --test .\localization\ko-KR\tests
node .\localization\ko-KR\audit-display-closure.mjs
node .\localization\ko-KR\audit-source-display.mjs
pwsh -NoProfile -File .\tests\ko-KR\Test-KoreanLocale.ps1
pwsh -NoProfile -File .\tests\ko-KR\Test-OfficialTerms.ps1
.\pob-zh-engine\dist-ko\pob-zh.exe --font-coverage-selftest
pwsh -NoProfile -File .\tests\ko-KR\Test-KoreanPackage.ps1 -PackageRoot .\pob-zh-engine\dist-ko -BaselineManifest .\reports\baseline\original-distribution.sha256.json
```

Expected: every command exits `0`; both closure reports contain zero issues.

- [ ] **Step 6: Run the PoE1 smoke scenarios and collect only new misses**

Start with an empty `dist-ko/translate_misses.log`, launch the launcher and engine, and exercise the scenarios in the design spec. Confirm Korean launcher, tabs, settings, skill selection, item editing, passive search, calculations, notes, party, errors and dialogs. Close all processes before reading the log.

If the normalized miss set is non-empty, add the missing official, structural, manual, or literal classification to the correct layer, regenerate, rebuild if source changed, and repeat the full verification set. The final log must have zero unresolved normalized display misses.

- [ ] **Step 7: Write the final verification record**

`docs/verification/2026-09-01-ko-KR-complete.md` must record:

```text
source commit
official patch
dictionary counts and hashes
closure report totals
source display totals
build commands and exit codes
font test result
runtime scenario result
normalized miss count
package file count and SHA-256
original distribution integrity result
known intentional English literals with reasons
```

- [ ] **Step 8: Create and re-test the ZIP**

```powershell
$koZip = '.\pob-zh-engine\dist\PobTools-Korean-1.1.0-preview.zip'
Compress-Archive -Path '.\pob-zh-engine\dist-ko\*' -DestinationPath $koZip -CompressionLevel Optimal -Force
$koExtract = Join-Path ([System.IO.Path]::GetTempPath()) ('pobtools-ko-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $koExtract | Out-Null
Expand-Archive -LiteralPath $koZip -DestinationPath $koExtract
pwsh -NoProfile -File .\tests\ko-KR\Test-KoreanPackage.ps1 -PackageRoot $koExtract -BaselineManifest .\reports\baseline\original-distribution.sha256.json
Get-FileHash -LiteralPath $koZip -Algorithm SHA256
```

Expected: extracted package contract passes and ZIP SHA-256 is recorded in the verification note.

- [ ] **Step 9: Commit final verification and package metadata**

Do not commit the binary ZIP unless the repository release policy explicitly tracks release artifacts. Commit source, scripts, dictionaries, notices, tests, and verification evidence:

```powershell
git add localization pob-zh-engine/host pob-zh-engine/CMakeLists.txt pob-zh-engine/dist/Data/launcher/ko-KR pob-zh-engine/dist/Data/poe1/ko-KR pob-zh-engine/dist/Fonts/NotoSansKR-Variable.ttf pob-zh-engine/dist/Fonts/OFL-NotoSansKR.txt reports tests docs NOTICE.md
git commit -m "release: verify complete PoE1 Korean preview"
git status --short
```

Expected: clean worktree after the commit; local ZIP remains available under `pob-zh-engine/dist` if ignored.
