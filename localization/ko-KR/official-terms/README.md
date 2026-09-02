# Official PoE1 Korean term probe

This development-only probe exports the same `BaseItemTypes` table in English and Korean from official Path of Exile patch data, then joins rows by the table's stable `Id` field.

The runtime Korean localization does not depend on this tool or its npm packages. Generated reports keep the patch number and tool version so every accepted term can be traced to its source.

## Pinned inputs

- Local Korean client patch: `3.29.3.2`, recorded by `C:\Daum Games\Path of Exile\logs\KakaoClient.txt` on 2026-08-31.
- Official patch data version used by the probe: `3.29.3.2`.
- Exporter: `pathofexile-dat@15.2.0`, MIT license.
- Languages: `English`, `Korean`.
- Table: `BaseItemTypes`.
- Columns: `Id`, `Name`.

## Commands

From this directory:

```powershell
npm ci
npm exec pathofexile-dat
pwsh -NoProfile -File .\build-map.ps1
pwsh -NoProfile -File .\write-items-locale.ps1
pwsh -NoProfile -File .\build-named-table-maps.ps1
pwsh -NoProfile -File .\write-named-locales.ps1
node .\build-stat-map.mjs
node .\write-stats-locale.mjs
node .\write-client-ui-locale.mjs
node .\build-unique-map.mjs
node .\write-uniques-locale.mjs
node .\build-mod-name-map.mjs
node .\write-tags-locale.mjs
```

From the repository root:

```powershell
pwsh -NoProfile -File .\tests\ko-KR\Test-OfficialTerms.ps1
```

Do not replace conflicts or unmatched rows with guessed translations.

`../manual/pob-ui.json` contains separately reviewed PoB-only interface text. Its external wording reference is pinned in the file and in `NOTICE.md`; official PoE terminology always takes priority and is corrected against the patch reports before use.
