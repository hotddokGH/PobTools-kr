# PobTools-ko Overlay Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PoE1 Korean source overlay reproduce the exact pinned upstream source with zero translation and display-audit issues without expanding the six-file behavioral compatibility patch.

**Architecture:** Upgrade the accepted mapping to an occurrence-qualified schema-v2 contract, extend both source scanners to understand semantic C++ string expressions, and apply concatenated translations component-by-component. A pinned remediation asset then records every reviewed baseline decision and the two exact internal fixtures; deterministic regeneration closes the baseline before the original Task 4 resumes.

**Tech Stack:** Python 3, tree-sitter C++, Node.js test runner, PowerShell, Git worktrees, deterministic JSON and SHA-256 manifests.

**Spec:** `docs/superpowers/specs/2026-09-01-pobtools-ko-overlay-remediation-design.md`

## Global Constraints

- PoE1 only.
- Upstream source is exactly `baf07d41d2df524d4330a58b411826339c93fac1`.
- Reviewed Korean evidence is exactly `ba33ed80de67d8301baad930456131d581df6ae1`.
- Accepted statuses remain exactly `official`, `reviewed`, and `intentional`; `suggested` never satisfies the overlay.
- The overlay remains transactional: any mapping, policy, parse, escape, signature, or replacement issue means zero source writes.
- Compatibility patch ownership remains exactly the six paths and five behavioral contracts already specified by Task 4 of `2026-09-01-pobtools-ko-maintenance-automation.md`.
- Never execute code fetched from upstream. Git object reads and detached worktrees are data inputs only.
- Preserve the existing uncommitted Task 4 test-first changes in `.gitignore`, `compat-patch.test.mjs`, `korean-update-contract.test.mjs`, and `filter-i18n-contract.test.mjs`; remediation commits must not stage them.
- No new whole-file source-display exclusion may be added for any of the 68 preflight blockers.

---

### Task 1: Upgrade the Canonical Map to Occurrence-Qualified Schema Version 2

**Files:**
- Modify: `localization/ko-KR/lib/source_overlay.py`
- Modify: `localization/ko-KR/migrate-source-translations.py`
- Modify: `localization/ko-KR/tests/test_source_overlay.py`
- Modify: `localization/ko-KR/tests/test_source_migration.py`
- Modify: `localization/ko-KR/source-translations.json`
- Modify: `localization/ko-KR/source-translation-suggestions.json`
- Modify: `reports/maintenance/source-migration.json`

**Interfaces:**
- Consumes: schema-v1 exact entries and the pinned upstream/current literal inventories.
- Produces: schema-v2 maps; `Literal.occurrence_index`; contextual resolution by `(path, function, source, occurrenceIndex)`; deterministic migration rows whose contextual identities always include `occurrenceIndex`.

- [ ] **Step 1: Write failing consumer tests for schema v2 and occurrence identity**

Add focused cases to `test_source_overlay.py` that prove:

```python
def test_schema_v1_is_rejected_after_v2_cutover(self):
    # A well-shaped schemaVersion 1 document reports INVALID_MAPPING_DOCUMENT.

def test_context_requires_nonnegative_occurrence_index(self):
    # Missing, bool, string, and negative occurrenceIndex values report INVALID_CONTEXT_ENTRY.

def test_repeated_source_literals_resolve_by_function_occurrence_index(self):
    # Two identical source values in one function receive two distinct reviewed targets.
    # Both replacements are correct and no global row is used.

def test_duplicate_context_consumer_key_blocks_all_writes(self):
    # Duplicate path/function/source/index rows report INVALID_CONTEXT_ENTRY and preserve bytes.
```

The repeated-source fixture must include at least one unrelated literal between the two identical values so the index definition is proven to count every complete literal expression in byte order.

- [ ] **Step 2: Run the focused consumer tests and verify RED**

Run:

```powershell
python localization/ko-KR/tests/test_source_overlay.py
```

Expected: the new tests fail because the consumer still requires schema version 1 and ignores occurrence indexes.

- [ ] **Step 3: Add deterministic occurrence indexes to the scanner and resolver**

Extend `Literal` with `occurrence_index: int`. After scanning, sort complete literal expressions by byte start within each `(path, function)` group and assign zero-based indexes. File-scope expressions use the empty function name.

Change mapping validation to require `schemaVersion == 2`. Require every context row to contain an integer `occurrenceIndex >= 0`; reject `bool`. Reject duplicate keys before scanning. Resolve a context only when all four identity fields match, then fall back to the global decoded-source entry.

Include `occurrenceIndex` in every literal-derived issue so remediation reports remain auditable.

- [ ] **Step 4: Run consumer tests and verify GREEN**

Run:

```powershell
python localization/ko-KR/tests/test_source_overlay.py
```

Expected: all consumer tests pass, including old byte-offset, CRLF, raw collision, invalid schema, and zero-write tests.

- [ ] **Step 5: Write failing migration tests for schema-v2 output**

Add cases to `test_source_migration.py` that assert:

```python
self.assertEqual(result.accepted["schemaVersion"], 2)
self.assertEqual(result.suggestions["schemaVersion"], 2)
self.assertEqual(result.accepted["contexts"][0]["occurrenceIndex"], expected_index)
```

Cover automatically aligned contexts, manual reviewed contexts, same-source contexts at different indexes, stable sorting by path/function/source/index/target, and rejection of a contextual identity that cannot be validated against the pinned inventories.

- [ ] **Step 6: Run migration tests and verify RED**

Run:

```powershell
python localization/ko-KR/tests/test_source_migration.py
```

Expected: failures show schema version 1 and missing emitted occurrence indexes.

- [ ] **Step 7: Update the migration producer and deterministic outputs**

Emit schema version 2 for accepted and suggestion documents. Carry the already validated upstream expression index through every contextual row, including automatically aligned rows. Sort contexts by:

```python
(row["path"], row["function"], row["source"], row["occurrenceIndex"], row["target"])
```

Do not weaken any official-manifest, Traditional Chinese dictionary, Korean target, manual-context, status, or encoding validation introduced by Task 3.

- [ ] **Step 8: Regenerate twice and prove deterministic schema-v2 artifacts**

Run the pinned migration twice with the existing explicit paths:

```powershell
python localization/ko-KR/migrate-source-translations.py `
  --upstream-ref baf07d41d2df524d4330a58b411826339c93fac1 `
  --localized-root pob-zh-engine `
  --output localization/ko-KR/source-translations.json `
  --suggestions localization/ko-KR/source-translation-suggestions.json `
  --report reports/maintenance/source-migration.json
```

At this intermediate task the command may retain the documented stop/review exit `1`, but both runs must produce identical bytes and must not introduce accepted `suggested` rows. Compare SHA-256 for all three artifacts.

- [ ] **Step 9: Run the complete focused contracts**

Run:

```powershell
python localization/ko-KR/tests/test_source_migration.py
python localization/ko-KR/tests/test_source_overlay.py
node --test localization/ko-KR/tests/*.test.mjs
& .\tests\ko-KR\Test-OfficialTerms.ps1
python -m py_compile localization/ko-KR/lib/source_overlay.py localization/ko-KR/migrate-source-translations.py
git diff --check
```

Expected: all tests pass; the official contract exits `0`; tracked Task 4 test-first edits remain unstaged.

- [ ] **Step 10: Commit only Task 1 files**

```powershell
git add -- localization/ko-KR/lib/source_overlay.py localization/ko-KR/migrate-source-translations.py localization/ko-KR/tests/test_source_overlay.py localization/ko-KR/tests/test_source_migration.py localization/ko-KR/source-translations.json localization/ko-KR/source-translation-suggestions.json reports/maintenance/source-migration.json
git diff --cached --check
git commit -m "feat: qualify Korean source mappings by occurrence"
```

---

### Task 2: Preserve Concatenated Components, Support Exact NUL, and Pin Internal Fixtures

**Files:**
- Modify: `localization/ko-KR/lib/source_overlay.py`
- Modify: `localization/ko-KR/lib/source-display-audit.mjs`
- Modify: `localization/ko-KR/tests/test_source_overlay.py`
- Modify: `localization/ko-KR/tests/source-display-audit.test.mjs`
- Modify: `localization/ko-KR/tests/test_source_migration.py`
- Modify: `localization/ko-KR/migrate-source-translations.py`

**Interfaces:**
- Consumes: Task 1 schema-v2 `Literal` identities.
- Produces: ordered `Literal.components`; optional reviewed mapping-row `components`; component-preserving replacement plans; exact `\0` decoding/encoding with `<NUL>` signatures; strict policy identity `{path, sha256, reason}` shared by Python and Node.

- [ ] **Step 1: Write failing scanner and replacement tests**

Add tests that require the scanner to expose ordered component spans and decoded values for:

```cpp
u8"設定" /* keep */ u8"更新"
u8"設定" L"更新"
R"tag(設定)tag" "更新"
```

Add apply tests whose mapping rows contain:

```json
"components": [
  { "source": "設定", "target": "설정" },
  { "source": "更新", "target": "업데이트" }
]
```

Assert token replacements are correct while the comment, whitespace, prefixes, raw delimiters, and CRLF bytes are unchanged. Add blocking tests for wrong component count/order/source, concatenated row without `components`, joined target mismatch, component encoding failure, component raw-delimiter collision, and any issue causing zero writes across all files.

- [ ] **Step 2: Write failing exact-NUL tests**

Cover:

```python
self.assertIn("<NUL>", format_signature("필터\0모든 파일\0\0"))
```

Require a reviewed wide-string table containing two labels and a terminal double NUL to round-trip semantically. Require `\1`, `\00`, `\07`, and `\0` followed by `[0-7]` to report `UNSUPPORTED_ESCAPE` with zero writes. Retain long-hex rejection.

- [ ] **Step 3: Run Python tests and verify RED**

```powershell
python localization/ko-KR/tests/test_source_overlay.py
```

Expected: concatenations still report `UNSAFE_CONCATENATED_LITERAL`, and exact NUL is unsupported.

- [ ] **Step 4: Implement component-preserving plans and exact NUL semantics**

Introduce an immutable component record with `start`, `end`, `decoded`, `prefix`, raw/regular kind, and line. A complete `Literal` retains its whole expression span plus its ordered components.

Validate component plans before source planning:

```text
len(mapping.components) == len(literal.components)
mapping.components[i].source == literal.components[i].decoded
join(component.source) == literal.decoded
join(component.target) == mapping.target
format_signature(mapping.target) == format_signature(literal.decoded)
```

Plan one replacement per component token. Never replace the enclosing concatenation span. Preserve every byte between components.

Decode only the exact unextended `\0` form to U+0000. Add `<NUL>` to `format_signature`. Encode NUL back to `\0` only when the following character cannot extend it; otherwise report `UNSAFE_NUL_ENCODING` and block.

- [ ] **Step 5: Run Python tests and verify GREEN**

```powershell
python localization/ko-KR/tests/test_source_overlay.py
```

Expected: all component/NUL tests and all prior safety tests pass.

- [ ] **Step 6: Write failing path-plus-expression-hash policy tests in Python and Node**

Use one synthetic concatenated JSON fixture and prove:

- exact normalized file path plus SHA-256 of the decoded complete expression is allowed;
- the same decoded value in a different file is rejected;
- wrong hash, missing/blank reason, missing/non-string path/hash, malformed hash, duplicate identity, and non-object policy rows block;
- a user-facing concatenation in the same file with a different hash is rejected.

Update Node tests to require semantic scanning of adjacent regular/raw C++ literals separated only by whitespace or comments. Prefixes do not change decoded identity. The JavaScript decoder supports the same simple/hex/Unicode/NUL allowlist and rejects unsupported escape forms deterministically.

- [ ] **Step 7: Run the policy tests and verify RED**

```powershell
python localization/ko-KR/tests/test_source_overlay.py
node --test localization/ko-KR/tests/source-display-audit.test.mjs
```

Expected: current hash-only Python/Node policy accepts the wrong path and Node does not hash a complete concatenated expression.

- [ ] **Step 8: Implement the shared strict policy semantics**

Validate every `internalLiteralAllowlist` row before source scanning. Use the exact identity `(normalized path, uppercase decoded-expression SHA-256)`. Reject duplicates and malformed rows. In Python, allowed expressions are counted as `intentional`; in Node, `auditSourceText`/`scanSourceDisplay` skips only the matching semantic expression in the matching file.

Do not add the real fixture decisions to `source-display-policy.json` yet; Task 3 owns reviewed data.

- [ ] **Step 9: Teach the migration producer to emit validated component plans**

Add migration tests for a pinned upstream concatenation whose Korean reference has the same component structure. Emit `components` only when every component aligns uniquely and the joined signatures match. Any split/merge/reorder that lacks an explicit reviewed component decision remains a blocking migration issue.

Manual remediation component rows must be validated against exact upstream component sources and exact current/reference targets before acceptance.

- [ ] **Step 10: Run complete tests and commit only Task 2 files**

```powershell
python localization/ko-KR/tests/test_source_overlay.py
python localization/ko-KR/tests/test_source_migration.py
node --test localization/ko-KR/tests/*.test.mjs
python -m py_compile localization/ko-KR/lib/source_overlay.py localization/ko-KR/migrate-source-translations.py
git diff --check
git add -- localization/ko-KR/lib/source_overlay.py localization/ko-KR/lib/source-display-audit.mjs localization/ko-KR/tests/test_source_overlay.py localization/ko-KR/tests/source-display-audit.test.mjs localization/ko-KR/tests/test_source_migration.py localization/ko-KR/migrate-source-translations.py
git diff --cached --check
git commit -m "feat: preserve structured Korean source literals"
```

---

### Task 3: Review Every Baseline Blocker and Prove Zero-Issue Reproduction

**Files:**
- Create: `localization/ko-KR/manual/source-overlay-remediation.json`
- Create: `localization/ko-KR/tests/test_overlay_remediation.py`
- Create: `reports/maintenance/baseline-overlay-blockers.json`
- Create: `reports/maintenance/baseline-overlay-reproduction.json`
- Create: `reports/maintenance/baseline-source-reproduction.json`
- Create: `reports/maintenance/baseline-overlay-reproduction-manifest.json`
- Modify: `localization/ko-KR/migrate-source-translations.py`
- Modify: `localization/ko-KR/tests/test_source_migration.py`
- Modify: `localization/ko-KR/source-display-policy.json`
- Modify: `localization/ko-KR/source-translations.json`
- Modify: `localization/ko-KR/source-translation-suggestions.json`
- Modify: `reports/maintenance/source-migration.json`

**Interfaces:**
- Consumes: exact blocker inventory from upstream `baf07d41...`, Korean evidence from `ba33ed80...`, Task 2 schema-v2/component/NUL/policy contracts, and pinned official PoE1 evidence.
- Produces: a complete explicit reviewed remediation asset; two path-and-hash fixture decisions; deterministic canonical artifacts with zero migration blockers; a clean upstream overlay and source audit with zero issues.

- [ ] **Step 1: Capture the exact pre-remediation blocker report deterministically**

Use the existing clean `.ko-worktrees/baseline` only for read-only audit. Resolve both the repository `.ko-worktrees` directory and baseline target; reject unless the target is a strict child and Git reports exact detached HEAD `baf07d41d2df524d4330a58b411826339c93fac1` with empty porcelain status.

Run schema-v2 overlay audit without applying writes and save the stable report as `reports/maintenance/baseline-overlay-blockers.json`. Assert its identities reconcile to the known preflight classes after Tasks 1–2: unresolved reviewed rows, user-facing component plans, exact NUL tables, and the two internal JSON expressions. Any unexplained new class blocks this task.

- [ ] **Step 2: Write failing remediation-coverage tests**

Create `test_overlay_remediation.py` with tests that load the blocker report and require exactly one decision for every unique consumer identity. The decision document must pin both commits and use this shape:

```json
{
  "schemaVersion": 1,
  "upstreamCommit": "baf07d41d2df524d4330a58b411826339c93fac1",
  "localizedCommit": "ba33ed80de67d8301baad930456131d581df6ae1",
  "entries": [],
  "contexts": [],
  "internalFixtures": []
}
```

Each reviewed entry/context includes exact source, target, format signature, provenance `manual-reviewed-remediation`, evidence path/function/upstream occurrence index, source SHA-256, and localized evidence SHA-256. Concatenated decisions include exact ordered components. Fixture decisions include only path, decoded-expression SHA-256, and nonblank reason.

Tests must reject missing/extra blocker decisions, duplicate consumer identities, suggested status, commit drift, invented path/function/index/source, target not supported by reviewed Korean evidence unless explicitly marked manual UI reflow, signature drift, and a fixture decision outside the two `host/atlas_diff.cpp` expression identities.

- [ ] **Step 3: Run remediation tests and verify RED**

```powershell
python localization/ko-KR/tests/test_overlay_remediation.py
```

Expected: fail because `source-overlay-remediation.json` does not exist.

- [ ] **Step 4: Review and record every user-facing decision**

Populate the remediation asset by inspecting each exact upstream expression together with its corresponding Korean reference function and the official PoE1 identity map. Rules:

- ordinary one-to-one values use the reviewed Korean reference target;
- repeated source values use indexed contexts;
- split/merge/reordered expressions receive explicit Korean wording that reads correctly in the upstream expression order;
- the changelog target is reflowed without changing newline/format token counts;
- `PoeDB` and language labels are treated as visible UI and receive reviewed Korean targets;
- the two Windows filter tables preserve wildcard bytes and terminal double NUL through explicit reviewed mappings;
- all fourteen user-facing concatenated expressions receive exact component plans;
- only the two reviewed `host/atlas_diff.cpp` JSON expressions enter `internalFixtures`.

Do not copy a machine suggestion into an accepted decision. If no reviewed/official/current evidence supports a target, stop and record the exact identity in the task report instead of inventing it.

- [ ] **Step 5: Validate decisions against both pinned Git inventories**

Extend the migration producer to read `source-overlay-remediation.json` from its fixed locale-relative path. Before promotion, validate every decision against `git show`/tree-sitter inventories for both pinned commits and against the trusted official evidence loader. The producer must reject file traversal, missing functions, wrong indexes, component mismatches, target evidence mismatches, duplicates, non-Hangul visible targets, invalid signatures, and any unconsumed remediation row.

Merge valid rows at the existing precedence point for explicit reviewed overrides. Fixture decisions do not enter `source-translations.json`; copy them deterministically to `source-display-policy.json` only after their exact blocker identities validate.

- [ ] **Step 6: Run remediation and migration tests until GREEN**

```powershell
python localization/ko-KR/tests/test_overlay_remediation.py
python localization/ko-KR/tests/test_source_migration.py
```

Expected: all tests pass; migration report has `ambiguous == 0`, `unmapped == 0`, no blocking issue category, accepted statuses are only official/reviewed/intentional, and suggestions remain external.

- [ ] **Step 7: Regenerate canonical assets twice and compare hashes**

Run the pinned migration twice using the explicit command from Task 1. Both invocations must exit `0`. Hash and compare:

- `localization/ko-KR/source-translations.json`
- `localization/ko-KR/source-translation-suggestions.json`
- `reports/maintenance/source-migration.json`
- `localization/ko-KR/source-display-policy.json`

The accepted document must remain schema version 2 and contain no `suggested` row.

- [ ] **Step 8: Reproduce from a separate clean detached worktree**

Use `.ko-worktrees/overlay-remediation`, never the Task 4 baseline. Resolve the intended path and require it to be a strict child of the repository `.ko-worktrees` directory. If already registered, verify its exact resolved path before `git worktree remove --force`; then add a fresh detached worktree at the pinned upstream commit.

Run:

```powershell
python localization/ko-KR/lib/source_overlay.py apply `
  --source-root .ko-worktrees/overlay-remediation/pob-zh-engine `
  --mapping localization/ko-KR/source-translations.json `
  --policy localization/ko-KR/source-display-policy.json `
  --report reports/maintenance/baseline-overlay-reproduction.json

node localization/ko-KR/audit-source-display.mjs `
  --engine-root .ko-worktrees/overlay-remediation/pob-zh-engine `
  --overlay-report reports/maintenance/baseline-overlay-reproduction.json `
  --report reports/maintenance/baseline-source-reproduction.json
```

Expected: both commands exit `0`; overlay issues `0`; source-display issues `0`; only the two exact internal JSON expressions are counted intentional; no machine marker, Traditional Chinese display, or unresolved overlay issue remains.

- [ ] **Step 9: Prove determinism and clean reproduction**

Remove and recreate only the exact verified remediation worktree, rerun Step 8, and compare the overlay-report and source-report hashes with their first-run hashes. Generate `baseline-overlay-reproduction-manifest.json` with stable key order and these exact fields: `schemaVersion: 1`, `upstreamCommit`, uppercase SHA-256 for the accepted map, policy, overlay report, and source report, the two sorted `{path, sha256}` intentional identities, and the two issue counts. Require both issue counts to be zero. The manifest may not contain timestamps or machine-specific absolute paths.

- [ ] **Step 10: Run all gates and commit Task 3 files**

```powershell
python localization/ko-KR/tests/test_overlay_remediation.py
python localization/ko-KR/tests/test_source_migration.py
python localization/ko-KR/tests/test_source_overlay.py
node --test localization/ko-KR/tests/*.test.mjs
& .\tests\ko-KR\Test-OfficialTerms.ps1
python -m py_compile localization/ko-KR/lib/source_overlay.py localization/ko-KR/migrate-source-translations.py localization/ko-KR/tests/test_overlay_remediation.py
git diff --check
```

Stage only the Task 3 files listed above; verify the existing Task 4 test-first edits remain unstaged. Commit:

```powershell
git commit -m "feat: close Korean baseline source overlay"
```

After independent review and controller verification, return to Task 4 of `docs/superpowers/plans/2026-09-01-pobtools-ko-maintenance-automation.md`. Apply the six-path compatibility patch before this overlay, then require the same zero-issue gates.

---
