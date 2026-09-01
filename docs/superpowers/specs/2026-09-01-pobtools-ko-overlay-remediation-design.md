# PobTools-ko Overlay Remediation Design

## Status

Approved in chat on 2026-09-01 after the Task 4 baseline preflight proved that the original compatibility-patch plan could not satisfy its zero-issue reproduction gate.

## Goal

Make the Korean source overlay expressive enough to reproduce the pinned PoE1 baseline safely and deterministically, while keeping the compatibility patch limited to its original six behavioral files and keeping every machine-only translation outside the accepted map.

## Evidence That Requires the Change

The exact detached upstream baseline is `baf07d41d2df524d4330a58b411826339c93fac1`. The reviewed Korean reference snapshot is the automation-start commit `2997715df0d6257192107d799a9f414b54e6c02b`, whose `pob-zh-engine` tree is `6c113669065ed84d160fb186ce3dfa2701e839cb`. That engine tree is byte-identical through the remediation-plan commit; the earlier candidate `ba33ed80de67d8301baad930456131d581df6ae1` is explicitly rejected because its engine source is not the completed Korean snapshot.

Task 4 preflight found 68 blocking overlay occurrences:

- 50 `MISSING_MAPPING` occurrences covering 38 unique source identities;
- 16 `UNSAFE_CONCATENATED_LITERAL` occurrences;
- 2 `UNSUPPORTED_ESCAPE` occurrences caused by Windows filter strings containing `\0`.

Only seven occurrences are in the six compatibility-patch paths. Sixty-one are outside that allowlist. Expanding the behavioral patch to those files, embedding Korean display replacements in it, or excluding the affected display files would violate the approved maintenance boundary.

## Chosen Approach

Reopen the translation producer and consumer, then resume the unchanged Task 4 boundary:

1. Introduce a versioned occurrence-qualified mapping schema.
2. Rewrite concatenated literals component by component without touching their trivia or prefixes.
3. Support only the exact C++ NUL escape form needed by the two reviewed Windows filter tables.
4. Add explicit reviewed rows for user-facing unresolved identities.
5. Allow only two confirmed diagnostic JSON fixtures through a path-and-hash-bound internal-literal policy.
6. Regenerate and validate the canonical assets, then rerun Task 4 with the original six-file patch allowlist.

## Rejected Approaches

### Expand the compatibility patch

This would add more than twenty source files and mix Korean display text with behavioral changes. It would make every upstream update a large textual rebase and defeat the data-driven maintenance goal.

### Suppress all affected files or all concatenations

Most affected values are user-facing. Whole-file or category-wide exclusions would hide untranslated release content and make the zero-issue audit meaningless.

### Infer Korean fragments from changed expression order

Several baseline expressions were split, merged, or reordered in the localized snapshot. Ordinal or proximity inference already produced demonstrably wrong mappings. Every accepted remediation row must be explicit and auditable.

## Canonical Mapping Schema Version 2

`localization/ko-KR/source-translations.json` becomes schema version `2`:

```json
{
  "schemaVersion": 2,
  "entries": {
    "設定": {
      "target": "설정",
      "status": "reviewed",
      "provenance": "current-ko-baseline",
      "formatSignature": []
    }
  },
  "contexts": [
    {
      "path": "host/example.cpp",
      "function": "Draw",
      "source": "設定",
      "occurrenceIndex": 7,
      "target": "설정",
      "status": "reviewed",
      "provenance": "manual-reviewed-remediation",
      "formatSignature": []
    }
  ]
}
```

`occurrenceIndex` is a required non-negative integer on every contextual row. It is the zero-based index of the complete string-literal expression among all scanned string-literal expressions in the same nearest function, ordered by source byte offset. File-scope literals use the empty function name and are indexed in file source order.

The consumer key is `(path, function, source, occurrenceIndex)`. A matching contextual row wins over a global entry. No contextual row may omit the index, and duplicate consumer keys block the complete run.

The migration producer must validate every contextual identity against both pinned inventories before emitting it. The overlay consumer also validates the field types and duplicate keys before scanning or writing source files.

## Concatenated-Literal Model

The scanner represents one C++ concatenated expression as one semantic `Literal` plus ordered components:

```text
Literal
  path, function, occurrenceIndex, start, end, decoded, line
  components[]
    start, end, decoded, prefix, raw, line
```

For a concatenated mapping, the accepted row additionally contains `components`:

```json
{
  "target": "설정 업데이트",
  "status": "reviewed",
  "provenance": "current-ko-baseline",
  "formatSignature": [],
  "components": [
    { "source": "設定 ", "target": "설정 " },
    { "source": "更新", "target": "업데이트" }
  ]
}
```

The following invariants are mandatory:

- component count and order exactly match the scanned source expression;
- concatenated component sources equal the row source;
- concatenated component targets equal the row target;
- the whole source and target have identical format signatures;
- each component retains its original prefix and raw/regular representation;
- only the token byte spans are replaced, preserving comments, whitespace, line continuations, and other interstitial trivia byte-for-byte;
- source newline style is retained;
- a raw-delimiter collision, invalid segment, encoding failure, or signature mismatch blocks all writes.

Mixed-prefix concatenations are allowed only because each original component keeps its own prefix. The implementation must never flatten a concatenation into one literal.

Rows without `components` remain valid only for non-concatenated literals. A concatenated display literal without a matching reviewed component plan reports `MISSING_COMPONENT_MAPPING` and blocks the transaction.

## Exact NUL Escape Contract

The decoder adds support for `\0` only when it is not followed by another octal digit. It decodes to one U+0000 character. The format signature includes one `<NUL>` token for every decoded NUL so source and target table structure must match.

The encoder writes a NUL as `\0` only when the next emitted character cannot extend the octal escape. Any other octal form, including `\1`, `\00`, `\07`, or `\0` immediately followed by `[0-7]`, remains unsupported and blocks the transaction. Long hexadecimal escape rejection remains unchanged.

The two reviewed Windows filter-table mappings must preserve the original prefix, NUL count, terminal double NUL, and all non-display wildcard bytes.

## Reviewed Remediation Data

The 38 unique missing identities are reviewed individually against:

- upstream source from `baf07d41d2df524d4330a58b411826339c93fac1`;
- Korean reference source from commit `2997715df0d6257192107d799a9f414b54e6c02b`, with exact engine tree `6c113669065ed84d160fb186ce3dfa2701e839cb`;
- official PoE1 identities already validated by the pinned official manifests and hashes.

Each accepted row records `manual-reviewed-remediation` or the existing official provenance. Repeated sources use schema-v2 contextual rows. Split, merged, and reordered expressions receive explicit Korean wording appropriate to the baseline expression order; no ordinal fallback is permitted.

The changelog remains user-facing and cannot be excluded. Its reviewed Korean target must preserve the baseline newline count and other format-signature tokens. User-facing brand and language labels receive explicit reviewed targets even when the old localized snapshot contained no Hangul.

Machine-generated values stay only in `source-translation-suggestions.json` with status `suggested` and can never satisfy an overlay row.

## Internal Fixture Policy

The two confirmed JSON regression fixtures in `host/atlas_diff.cpp` are non-display test data. They may be allowlisted only with all of:

```json
[
  {
    "path": "host/atlas_diff.cpp",
    "sha256": "1A2ED60F14281831146207077202F262ABB8309174390CA0936DD65C0555D02C",
    "reason": "non-display atlas diff JSON regression fixture at RunAtlasDiffSelfTest line 488"
  },
  {
    "path": "host/atlas_diff.cpp",
    "sha256": "547E964D403E6AD927F15CC0D02021ABFEEE8B3D711DB3E7EF6D2666003F3BBF",
    "reason": "non-display atlas diff JSON regression fixture at RunAtlasDiffSelfTest line 501"
  }
]
```

Both the Python overlay and Node display audit match the normalized relative path and decoded-value SHA-256. A hash match in another file is not sufficient. Malformed, duplicate, pathless, hashless, or reasonless policy rows block validation. No new whole-file exclusion is permitted for the remediation identities.

## Transaction and Report Semantics

The overlay remains all-or-nothing across the complete source root. It first validates the mapping and policy, then scans and plans every replacement, then writes only if the final issue list is empty.

Every issue report includes the normalized path, nearest function, occurrence index, line, decoded source, and stable code. Concatenation issues also include the component index and source. Unsupported escapes include the exact source token and escape. Reports and replacement ordering remain deterministic.

## Component Boundaries

### Overlay consumer

`localization/ko-KR/lib/source_overlay.py` owns schema-v2 validation, occurrence indexing, component-preserving replacements, exact `\0` semantics, policy matching, and transactional writes.

### Migration producer

`localization/ko-KR/migrate-source-translations.py` owns pinned-inventory validation, explicit reviewed remediation rows, component plans, schema-v2 output, provenance, and deterministic reports.

### Display audit

`localization/ko-KR/lib/source-display-audit.mjs` owns post-overlay Han/Hangul closure and path-plus-hash fixture policy enforcement. It does not promote or infer translations.

### Compatibility patch

Task 4 remains responsible only for the five behavioral contracts across its exact six allowed paths. It is applied before the schema-v2 overlay and contains no display-only Korean replacement.

## Verification Gates

The remediation is complete only when all of the following pass:

1. Unit tests cover occurrence-qualified contexts, duplicate keys, repeated sources, non-concatenated backward behavior, regular/raw/mixed-prefix concatenations, interstitial comments, CRLF, raw-delimiter collision, malformed component plans, exact `\0`, rejected octal forms, and zero-write failure behavior.
2. Migration tests prove schema-v2 determinism, pinned identity validation, explicit remediation provenance, no suggested acceptance, and byte-identical regeneration.
3. Policy tests prove path-plus-hash matching and fail-closed malformed/duplicate rows in both Python and Node.
4. The exact baseline overlay reports zero issues and writes no Han display literals except the two path-and-hash-bound internal fixtures.
5. The source-display audit reports zero issues when consuming the zero-issue overlay report.
6. The five static behavioral contracts pass against the reproduced baseline through explicit `POBTOOLS_ENGINE_ROOT`.
7. The regenerated canonical mapping, suggestions, migration report, overlay report, and reproduction report are deterministic across two runs.
8. Only after gates 1–7 pass may Task 4 generate the original six-path patch and manifest.

## Maintenance Outcome

Future upstream updates remain data-driven: ordinary UI changes become reviewed mapping rows, repeated strings use stable occurrence-qualified contexts, and concatenated literals remain structurally intact. Behavioral drift stays isolated in the small compatibility patch. Any new unsupported C++ form or unresolved translation fails closed with a deterministic review report rather than silently entering a public build.
