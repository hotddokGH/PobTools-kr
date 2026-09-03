# 한국어 유지보수 안내

## clean 브랜치 모델

`ko/main`은 Path of Building 업스트림 소스를 직접 번역해서 보관하는 브랜치가 아니다. 보호 대상 C/C++ 소스 177개는 고정 업스트림 커밋과 동일하게 유지하고, 검토된 한국어 자동화·사전·보고서·배포 입력만 `localization/ko-KR/clean-branch-manifest.json`의 허용 목록으로 보관한다. 실제 소스 오버레이와 생성 데이터는 `.ko-worktrees` 아래의 분리된 detached worktree에만 만든다.

현재 대상은 PoE1이다. `pob-zh-engine/dist/Data/poe1/ko-KR`은 PoE1 런타임 사전이고, `pob-zh-engine/dist/Data/launcher/ko-KR`은 PoE1 배포판의 실행기 UI 사전이다. launcher 사전은 PoE2 게임 데이터가 아니며, 두 트리는 모두 검토된 Git 객체와 해시로 고정된다. `pob-zh-engine/host/data`의 생성 결과는 clean 브랜치에 덮어쓰지 않는다.

## 로컬 검증

저장소 루트의 PowerShell에서 다음 순서로 실행한다. 이 절차는 C++을 빌드하거나 실행하지 않는다.

```powershell
python -m pip install -r localization/ko-KR/requirements-overlay.txt
python -m unittest localization/ko-KR/tests/test_source_overlay.py localization/ko-KR/tests/test_overlay_remediation.py localization/ko-KR/tests/test_machine_fallback_resume.py
node localization/ko-KR/update-upstream.mjs --repository-root . --upstream-ref ba33ed80de67d8301baad930456131d581df6ae1 --workspace .ko-worktrees/validate-ko --report reports/maintenance/ba33ed8-review.json --force-prepare

$engineRoot = (Resolve-Path .ko-worktrees/validate-ko/pob-zh-engine).Path
$reportRoot = (Resolve-Path reports).Path
$retainedAssets = @(
    'dist/Data/launcher/ko-KR/launcher.json',
    'dist/Data/launcher/ko-KR/meta.json',
    'dist/Fonts/NotoSansKR-Variable.ttf',
    'dist/Fonts/OFL-NotoSansKR.txt'
)
foreach ($relativePath in $retainedAssets) {
    $source = Join-Path (Resolve-Path pob-zh-engine).Path $relativePath
    $destination = Join-Path $engineRoot $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}
$env:POBTOOLS_ENGINE_ROOT = $engineRoot
$env:POBTOOLS_REPORT_ROOT = $reportRoot
node --test localization/ko-KR/tests/*.test.mjs
& tests/ko-KR/Test-KoreanLocale.ps1 -EngineRoot $engineRoot
& tests/ko-KR/Test-OfficialTerms.ps1 -EngineRoot $engineRoot -ReportRoot $reportRoot
```

`--force-prepare`는 이미 검토한 커밋도 생략하지 않고 12개 단계를 다시 수행한다. 성공한 고정 커밋 보고서는 `already-processed`, 12/12 성공, 아래 8개 배열이 모두 빈 배열이어야 한다.

- `newStrings`, `suggestedStrings`, `ambiguousStrings`, `officialDataChanges`
- `compatibilityFailures`, `deterministicFailures`, `commandFailures`, `auditFailures`

유지보수 보고서의 checkout·임시 worktree·Node 실행 파일 경로는 각각 `$REPOSITORY_ROOT`, `$WORKSPACE_ROOT`, `$NODE`로 기록된다. 토큰 뒤의 상대 경로와 원래 진단 내용은 보존되므로 다른 checkout에서도 동일한 입력은 동일한 JSON 바이트를 만든다.

## 보고서 판정

- `ready`: 고정 입력과 모든 검증이 통과했고 사람의 추가 검토 항목이 없으며, 아직 `lastReviewedCommit`으로 기록되지 않은 커밋이다.
- `already-processed`: 동일한 무결성 조건을 만족하고 대상 커밋이 이미 `lastReviewedCommit`이다. `--force-prepare`를 사용하면 이 판정이어도 모든 단계를 실행한다.
- `review-required`: 새 문자열, 제안 문자열, 모호한 문자열 또는 공식 PoE1 생성 데이터 변경이 있어 사람의 결정을 기다린다.
- `blocked`: 패치, 결정성, 명령 또는 감사 실패가 하나라도 있다. 오래된 성공 보고서를 유지하지 않고 실패 보고서로 교체한다.

소스 오버레이에서 자동 적용할 수 있는 상태는 `official`, `reviewed`, `intentional`뿐이다. `suggested`와 모호하거나 알 수 없는 상태는 자동 승격하지 않으며 검토 항목 또는 차단 사유로 남긴다.

## 런타임 UI 누락 갱신

실행 중 `translate_misses.log`가 생기면 기존 목록을 버리지 말고 현재 한국어 사전과 중국어 참조 사전의 공백까지 함께 병합한다.

```powershell
node localization/ko-KR/import-runtime-misses.mjs `
  --reference-ui pob-zh-engine/dist/Data/poe1/zh-rTW/ui.json `
  --target-ui pob-zh-engine/dist/Data/poe1/ko-KR/ui.json `
  --reference-root pob-zh-engine/dist/Data/poe1/zh-rTW `
  --pob-data-root C:/path/to/Path-of-Building-Community/Data `
  --include-skill-gem-data `
  C:/path/to/translate_misses.log

C:/path/to/.venv-translation/Scripts/python.exe `
  localization/ko-KR/machine_translate_runtime.py --resume --numeric-markers --batch-size 32

# 숫자 표식 복원에 실패한 항목만 기본 보호 방식으로 재시도
C:/path/to/.venv-translation/Scripts/python.exe `
  localization/ko-KR/machine_translate_runtime.py --resume --batch-size 32

# 공식 용어 표식이 많은 긴 설명문은 실행 서식만 보호해 마지막으로 재시도
C:/path/to/.venv-translation/Scripts/python.exe `
  localization/ko-KR/machine_translate_runtime.py --resume --syntax-only --batch-size 32
```

가져오기는 줄바꿈이 포함된 `MISS|` 레코드를 한 항목으로 보존하고 기존 인벤토리에 새 항목만 추가한다. `--reference-root`와 `--pob-data-root`를 함께 주면 화면에서 잘린 문구를 전체 Lua 설명으로 복원하고, 레벨별 숫자를 `{0}` 형태의 재사용 가능한 템플릿으로 정규화한다. `--include-skill-gem-data`는 실행 중 열어 본 젬에만 의존하지 않고 `Data/Skills`의 모든 설명과 `gem_stat_descriptions.lua`, `skill_stat_descriptions.lua`의 모든 스킬젬 능력치 템플릿을 추가한다. 번역기는 이전 결과를 재사용하며, 내부 보호 표식이나 서식이 깨진 결과는 거부한다. 거부 항목은 `manual/machine-fallback-overrides.json`에서 사람이 문맥과 공식 용어를 확인해 보정한다. 이후 `build-runtime-locale.mjs`와 `audit-display-closure.mjs`를 실행하고, 실행 로그 및 참조 UI 범위가 모두 0 issues인지 확인한다.

## 업스트림 확인 워크플로

`.github/workflows/check-upstream.yml`은 현재 **수동 실행만** 허용한다. GitHub의 Actions 탭에서 `Check Korean upstream maintenance`를 선택해 `Run workflow`를 실행하면 읽기 전용 `analyze` 작업이 `upstream/main`을 검사한다. `blocked`여도 보고서 증거를 먼저 업로드한 뒤 실패하며, `already-processed`이면 제안 브랜치나 PR을 만들지 않는다. `ready`와 `review-required`만 검증된 데이터 전용 번들을 통해 고정 브랜치 `automation/upstream-ko`와 하나의 PR을 갱신할 수 있다.

보고서의 `sourceSummary.reused`는 소스 오버레이가 실제 재사용한 번역 수이다. `newStrings`, `suggestedStrings`, `ambiguousStrings`는 코드별로 PR 본문에 정렬되어 표시된다. 검토할 때는 각 행의 `path`, `function`, `occurrenceIndex`, `line`, `source`를 확인하고 `localization/ko-KR/source-translations.json`의 해당 항목을 고친다. 공식 클라이언트 근거가 있으면 `official`, 사람이 문맥을 확인했으면 `reviewed`, 번역하지 않는 내부 문자열이면 근거와 함께 `intentional`을 사용한다. `suggested`를 그대로 승인 상태로 바꾸지 않는다. 수정 후 위의 로컬 검증 명령과 `--force-prepare`를 다시 실행한다.

자동 제안은 `localization/ko-KR/upstream-state.json`의 `lastReviewedCommit`을 갱신하지 않는다. 상태 전환은 사람이 결과를 검토하고 별도 커밋으로 승인해야 하므로, 그 전에는 같은 업스트림 커밋이 수동 실행에서 다시 감지되는 것이 정상이다.

매일 03:17 UTC에 실행할 cron 식은 워크플로에 설명 주석으로만 남아 있고 활성화되어 있지 않다. 먼저 이 로컬 변경을 별도로 push 승인받고, hosted 수동 실행이 정확히 하나의 PR만 생성·갱신하는지 확인하고, 결과를 사람이 검토한 다음 별도 승인과 커밋으로 schedule을 활성화해야 한다.

## 검토와 배포 원칙

1. 고정 업스트림 커밋으로 `--force-prepare`를 실행한다.
2. 보고서의 경로·함수·원문·근거와 공식 PoE1 식별자를 대조한다.
3. 사람이 승인한 행만 `official`, `reviewed`, `intentional` 중 맞는 상태로 바꾼다. 제안 결과나 기계 번역을 그대로 승인하지 않는다.
4. 호환성 패치가 필요하면 정확한 허용 경로, 패치 SHA-256, 적용 후 파일 SHA-256을 함께 검토한다.
5. 두 번의 런타임 빌더와 두 번의 custom-data 빌더 결과가 각각 동일한지 확인하고, 전체 계약을 다시 실행한다.
6. 검토가 끝난 뒤에만 상태·결정적 보고서·허용 목록을 갱신한다.

검증 산출물과 이후의 미리보기 패키지는 코드 서명되지 않은 비공식 팬 제작물이다. 자동 검증 성공은 배포 승인이나 공식 지원을 뜻하지 않는다. 현재 `validate-ko.yml`은 저장소 쓰기 권한이 없는 검증 정의이며, 이 변경은 로컬 커밋까지만 준비한다. 별도 push 승인 전에는 hosted 실행 결과가 없으므로 이 문서는 GitHub 실행이 green이라고 주장하지 않는다.

`check-upstream.yml`도 Release를 만들거나 실행 파일을 배포하지 않는다. 제안 PR의 JSON·사전·보고서 역시 서명된 배포물이 아니며, 현재 hosted 수동 실행과 PR 생성은 수행하지 않은 상태다.

## 한국어 미리보기 빌드

`.github/workflows/build-ko-preview.yml`은 `ko/main`에서만 수동 실행할 수 있는 읽기 전용 미리보기 빌드다. 실행 이벤트 SHA, checkout HEAD, 원격 `ko/main` SHA가 모두 같을 때만 `upstream-state.json`의 `lastReviewedCommit`을 `.ko-worktrees/release`에 다시 준비한다. 보고서가 `ready` 또는 `already-processed`, 12/12 성공, 8개 검토·실패 배열 0이고 생성 엔진 HEAD가 검토 커밋과 같아야 다음 단계로 간다.

빌드와 설치는 추적 중인 `pob-zh-engine`이 아니라 생성된 `.ko-worktrees/release/pob-zh-engine` 아래에서만 수행한다. 핀 고정된 launcher 사전, 글꼴/OFL, `pob-zh.ini`를 복사하기 전후로 SHA-256을 확인하고, `Release` 및 `POBTOOLS_KOREAN_RELEASE=ON`으로 빌드한다. 네트워크 업데이트 명령은 실행하지 않으며 `--font-coverage-selftest`, `--app-update-selftest`, `NotSigned` 확인이 모두 통과해야 한다.

패키지는 생성 엔진을 명시적인 `AssetRoot`로 사용한다. staging 계약 후 ZIP을 검증된 runner 임시 디렉터리에 풀어 같은 패키지 계약을 다시 실행하고, 매니페스트의 모든 경로·파일 SHA-256·ZIP 바이트 수·ZIP SHA-256을 비교한다. 업로드 대상은 ZIP, `.sha256.json`, `preview-provenance.json`, `PREVIEW-NOTES.md` 네 파일뿐이다.

이 워크플로에는 write 권한, schedule, tag/Release 작업, 서명 비밀이 없다. 로컬 검증은 CMake, vcpkg bootstrap, 생성 EXE 실행을 포함하지 않는다. 별도 push와 hosted 수동 dispatch 승인을 받은 뒤에만 네이티브 빌드 및 두 자체 점검 결과를 증거 문서에 추가한다. 그 후에도 실행기, 설정, 필터 편집기, 아틀라스 플래너, 패시브 도구, 아이템 붙여넣기, 오류 대화상자를 사람이 확인하고 별도 배포 설계를 승인하기 전에는 Release를 만들지 않는다.
