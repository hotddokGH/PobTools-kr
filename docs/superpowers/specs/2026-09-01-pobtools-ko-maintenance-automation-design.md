# PobTools-ko Maintenance Automation Design

**Date:** 2026-09-01

**Status:** Proposed for user review

**Upstream:** `Hsiung-Shao/PobTools-zh`

**Korean fork:** `hotddokGH/PobTools-kr`

## Decision

Maintain Korean translation as data and reproducible transformations, not as a
permanent hand-edited copy of every upstream C++ file. Each release build starts
from a pinned upstream commit, applies a small Korean compatibility patch, applies
reviewed string mappings to a temporary source tree, regenerates official PoE1
data, verifies the result, and produces an unsigned preview ZIP.

The maintainer's normal work is limited to reviewing newly added or changed
strings. C++ work is exceptional and required only when upstream changes behavior
or structure in a way that breaks the compatibility patch or build.

## Goals

- Detect new commits and releases from `Hsiung-Shao/PobTools-zh` automatically.
- Reuse every unchanged Korean translation without editing C++ files again.
- Keep PoE1 game terminology tied to pinned official Korean client data.
- Produce a short review queue containing only new, changed, ambiguous, or
  unverified strings.
- Build and test the Windows executable on GitHub-hosted Windows runners, so a
  local Visual Studio installation is not required for routine releases.
- Never publish a release when translations, format placeholders, compatibility
  patches, compilation, or package contracts fail.
- Preserve the exact upstream commit and all translation provenance in every
  build report.

## Non-goals

- PoE2 localization is not included in the first automation version.
- The workflow will not automatically publish machine-generated Korean text.
- The workflow will not create or purchase a code-signing identity.
- The workflow cannot guarantee that upstream architectural changes will never
  require a human C++ fix.
- The workflow will not modify or push to the upstream Chinese repository.

## Repository and Branch Model

The local and hosted repository use these remotes:

```text
origin   https://github.com/hotddokGH/PobTools-kr.git
upstream https://github.com/Hsiung-Shao/PobTools-zh.git
```

`origin/main` mirrors `upstream/main` without Korean source edits. The Korean
automation, mappings, tests, and workflow live on `ko/main`. Generated patched
C++ sources are created only inside an ignored build workspace and are never
committed to `ko/main`.

Each automation run records an immutable upstream commit SHA. A release is
therefore reproducible even if `upstream/main` changes later.

## Translation Data Model

### Runtime dictionaries

The existing deterministic `ko-KR` runtime generator remains responsible for
PoB UI dictionaries and official game terms. Precedence remains:

```text
official exact term
official structural pattern
reviewed PoB-only Korean
documented intentional literal
unresolved
```

Machine output may be stored as a suggestion, but it is never accepted into a
release dictionary without review.

### Native C++ display strings

Native source translations move to a JSON mapping with two lookup levels:

1. A global exact mapping keyed by the decoded upstream source literal. This
   survives line movement and file reorganization.
2. A contextual override keyed by source literal plus a stable file/function
   context. This handles the rare case where identical Chinese text needs
   different Korean wording.

Every accepted entry records:

```json
{
  "source": "upstream Chinese text",
  "target": "reviewed Korean text",
  "status": "reviewed",
  "provenance": "manual-pobtools-ui",
  "formatSignature": "printf/placeholders/newlines/colour tags"
}
```

The source transformer parses C++ string literals, decodes them, resolves the
mapping, verifies the format signature, and replaces only the literal payload in
the temporary source tree. Prefixes such as `u8` and `L`, escaping, raw strings,
and surrounding code remain intact.

New strings are written to a deterministic pending report. Suggestions may be
generated for convenience, but pending rows block release until their status is
changed to `reviewed`, `official`, or `intentional`.

### Korean compatibility patch

Translation alone cannot implement Korean-specific behavior. A small, explicit
compatibility patch remains for behavior such as:

- selecting Korean atlas data paths;
- recognizing official Korean item prefixes and the Replica suffix;
- preventing Chinese filter maps from loading in the Korean locale;
- disabling Chinese translation/self-update endpoints in Korean release builds;
- enabling `POBTOOLS_KOREAN_RELEASE` in CMake.

This patch is separate from display translations. It is applied with a
three-way/context-aware patch operation and has focused contract tests. Any
failed hunk blocks the build and creates a maintenance report naming the affected
file. The long-term goal is to upstream generic locale support so this patch
shrinks rather than grows.

## Automated Update Flow

Three workflows divide responsibilities.

### 1. Validate Korean data

Triggered for every push and pull request on `ko/main`:

1. Run Node unit tests.
2. Build runtime and custom PoE1 data twice and compare hashes.
3. Run official-term, display-closure, source-mapping, and package-schema tests.
4. Upload reports as workflow artifacts.

This workflow does not need write permission or release secrets.

### 2. Check upstream

Triggered manually and on a daily schedule:

1. Fetch `upstream/main` and resolve its commit SHA.
2. Stop successfully if that SHA was already processed.
3. Create a temporary worktree at the new SHA.
4. Apply the Korean compatibility patch.
5. Extract all display strings and apply reviewed JSON mappings.
6. Refresh pinned official PoE1 mappings when the configured client patch
   changes.
7. Produce `new`, `changed`, `ambiguous`, and `compatibility-failure` reports.
8. Open or update one maintenance pull request in `origin`.

The pull request clearly distinguishes automatic data changes from rows that
need human review. It never edits an existing release directly.

### 3. Build preview

Triggered manually after the maintenance pull request is reviewed, and on a tag:

1. Recreate the temporary patched source from the recorded upstream SHA.
2. Run all validation gates again.
3. Configure and build with the pinned GitHub Windows runner image and
   `POBTOOLS_KOREAN_RELEASE=ON`.
4. Install into a clean staging directory.
5. Assemble only allowlisted runtime files, Korean data, fonts, notices, and
   configuration.
6. Run executable self-tests and the package contract.
7. Create an unsigned ZIP, SHA-256 manifest, provenance report, and release
   notes.
8. Upload them as workflow artifacts. Publishing a GitHub Release remains a
   separate explicit approval step at first.

## Release Gates

A preview artifact is created only when all of these conditions are true:

- no unresolved or unreviewed visible string exists;
- no Chinese display literal remains in the generated Korean source;
- all printf, placeholder, newline, and colour-tag signatures match;
- official PoE1 data hashes and identities match the pinned manifest;
- the Korean compatibility patch applies completely;
- all unit and PowerShell contracts pass;
- the C++ build and install succeed;
- executable font coverage and runtime self-tests pass;
- the package allowlist and UTF-8 JSON checks pass;
- the original upstream distribution integrity check passes where applicable.

Machine suggestions, partial patch application, or a failed build always produce
a report, never a release.

## Maintainer Experience

For a routine upstream update, the maintainer receives one pull request with a
summary similar to:

```text
Upstream: baf07d4 -> ba33ed8
Reused source translations: 1,684
New strings requiring review: 7
Official PoE1 term changes: 3
Compatibility patch failures: 0
Build: blocked until 7 rows are reviewed
```

The maintainer edits only the pending Korean JSON rows, marks them reviewed, and
merges the pull request. The build workflow then produces the candidate ZIP.

If upstream changes only game data already covered by official identities, the
workflow may need no translation edits at all. If upstream rewrites a native
tool, the report may request a compatibility patch update; this is the expected
exception rather than the normal path.

## Security, Licensing, and Signing

- Workflows pin third-party Actions to immutable commit SHAs before release use.
- The upstream-check workflow has the minimum repository permission needed to
  open or update its maintenance branch.
- Build jobs do not receive signing secrets.
- Machine-generated suggestions retain model and license provenance. Content
  whose license is unsuitable for the intended distribution is not promoted
  automatically.
- Initial ZIPs are explicitly labeled unsigned and include SHA-256 hashes.
- Code signing, if adopted later, runs in a separate protected workflow after
  all build gates and manual approval.

## Migration from the Current Branch

1. Preserve the current Korean dictionaries, official mappings, reports, and
   tests as the baseline.
2. Extract the final Korean C++ literal payloads into the new reviewed/pending
   mapping format while preserving the original Chinese keys.
3. Separate behavioral changes into the minimal compatibility patch.
4. Prove that applying the mapping and compatibility patch to the pinned v1.1.0
   upstream commit reproduces the current zero-issue source audit.
5. Test the first real update against current `upstream/main` (`ba33ed8`) and
   inspect the generated review queue.
6. Create `ko/main` only after reproduction and upstream-update tests pass.
7. Add GitHub workflows in disabled/manual-only mode, validate them, then enable
   the schedule.

## Success Criteria

The design is successful when:

- a clean upstream checkout can be converted into the Korean source without
  committing generated C++ files;
- unchanged translations survive an upstream update automatically;
- only genuinely new or ambiguous strings require manual review;
- `ba33ed8` can be processed end to end on GitHub Actions;
- a tested Korean preview ZIP can be produced without Visual Studio installed on
  the maintainer's PC;
- a failed update leaves the previous release untouched and produces a precise,
  actionable report.
