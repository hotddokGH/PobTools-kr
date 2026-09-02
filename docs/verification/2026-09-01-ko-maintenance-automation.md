# PobTools 한국어 유지보수 자동화 검증 기록

이 문서는 로컬에서 실제로 확인한 결과와 아직 확인하지 않은 hosted 결과를 구분한다. 기록 기준일은 2026-09-02(KST)이다.

## 고정 입력

- 검토 업스트림: `ba33ed80de67d8301baad930456131d581df6ae1`
- Task 10 시작 시 한국어 자동화 기준: `eb0314fafc4faa19b3379e2f59f67110c4ecf6fd` (`fix: reject dangling bundle entries`)
- hosted 실행의 한국어 자동화 SHA: 미실행이므로 없음. 워크플로는 실행 시 `${{ github.sha }}`를 별도로 기록한다.
- 공식 PoE 패치: `3.29.3.2`
- 호환성 패치 SHA-256: `2D3963E980C2E48604BA7FA91CDF784AB3E70485FBFEFB51DC5195E25B123959`
- 소스 번역 매핑: 1,302개(`official` 113, `reviewed` 1,189), SHA-256 `E5911E4E7E6243D7A254CF57F3DD9136FA6D7B7E79E40551453F9AB6361B9085`
- 소스 표시 정책 SHA-256: `ACB36BDD60E023FDFCB30EECDFBC2A7D71E91331AEAF6494355AF3F575AF3EB8`
- 런타임 표시 정책 SHA-256: `E59EB0D072D6722AFFBFFA363BC98B8E5DA79ADAEEA80BB3C1537E4BD3F36ED9`
- 런타임 인벤토리: 20,371개, SHA-256 `DCA663AD1936B0372225DBF66E39A1B8C41395112ECFC5C4B873DBAF2274C9EF`
- custom PoE1 출력 매니페스트: 8개 파일, SHA-256 `9F694C3D49DDA1A2523631D4907F65090A55F169E21E44CD97B9C9E354F5FB99`
- 검토 launcher SHA-256: `launcher.json` `83401B058CD4F93029C5C87EE633DCE21D8A006357A1E02C483DD3E67ECCBBB0`, `meta.json` `D7B59E5EB50FAA03877FC401393B18572AB89C7A296125D0D0D8B9751E3D790A`
- 글꼴/OFL/INI SHA-256: `194018E6B2B293A7964F037B25C0249CE1418BC9AB3C971060A03AA57861E252`, `1C05C68C34F9708415AADA51F17E1B0092D2CEA709BF4A94CD38114F9E73D7D9`, `A75345BD3CC9AB480BD55C5B10B35364160EA426D21BFA65C2870E08982E7669`

## 로컬 재현 증거

`update-upstream.mjs --force-prepare`를 같은 입력으로 두 번 실행했다. 두 실행 모두 `already-processed`, 12/12 성공, `newStrings`, `suggestedStrings`, `ambiguousStrings`, `officialDataChanges`, `compatibilityFailures`, `deterministicFailures`, `commandFailures`, `auditFailures`가 각각 0이었다. 생성 엔진 HEAD는 검토 업스트림과 같은 `ba33ed80de67d8301baad930456131d581df6ae1`이었다.

- 두 유지보수 보고서 SHA-256: `3B51D333A844C71EBF226DFEB0553DCC2E2DB71E026AE41BBA1FCC4450818384` (바이트 동일)
- 소스 오버레이: 177개 파일, 표시 리터럴 8,876개, 재사용 1,655회(`official` 140, `reviewed` 1,515, `intentional` 2), issue 0
- 생성 소스 감사: 177개 파일, 표시 리터럴 8,888개, 한국어 표시 리터럴 1,644개, 허용 내부 리터럴 2개, issue 0
- 런타임 폐쇄성: 20,371/20,371 해결, issue 0
- 공식 custom 데이터: `official` 2,013, `manual` 726, `machine` 0, unresolved 0
- 실제 저장소 입력으로 생성한 로컬 provenance 미리보기: 명명 입력 11개, 생성 한국어 데이터 12개 파일, tree SHA-256 `D0EE2951D32E1B56459BEAAA3DA05B89F0B70FA914EBAF936885717586189C95`

## 로컬 테스트

- 출처 증명 집중 테스트: 4개 중 3 pass, 0 fail, 파일 심볼릭 링크 생성 권한 부족으로 1 skip. junction/reparse 계약은 별도 패키지 테스트에서 실행했다.
- 패키지 및 ZIP 픽스처 테스트: 6/6 pass. 두 AssetRoot 선택, 사전 삭제 실패, junction, traversal, 중복 매니페스트, 변조 ZIP, reparse ZIP 항목, 추출 후 전체 해시 비교를 포함한다.
- 미리보기 워크플로 계약: 3/3 pass.
- 집중 통합 계약: 18개 중 17 pass, 0 fail, 동일 파일 심볼릭 링크 권한 skip 1개.
- Python 소스 오버레이·remediation: 87/87 pass.
- 생성 엔진 명시 루트 전체 Node 재실행: 176개 중 174 pass, 0 fail, Windows의 파일 심볼릭 링크 생성 권한 부족으로 2 skip. clean-branch 계약을 포함한 나머지 테스트는 모두 통과했다.
- 생성 엔진 명시 루트 PowerShell 계약: `Test-KoreanLocale.ps1`, `Test-OfficialTerms.ps1` 각각 exit 0.
- PowerShell parser: `Assemble-KoreanPackage.ps1`, `Test-KoreanPackage.ps1`, `Verify-KoreanPackageArchive.ps1` 각각 오류 0.

픽스처는 어떤 업스트림 실행 파일도 실행하지 않는다. 로컬에서는 CMake, vcpkg bootstrap, 생성 `pob-zh.exe`를 실행하지 않았다.

## 워크플로 구성

- runner label: `windows-2025-vs2026`; 관측 image 값은 hosted 실행 시 `ImageOS-ImageVersion`으로 기록한다.
- Actions는 40자리 SHA로 고정: checkout `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-node `820762786026740c76f36085b0efc47a31fe5020`, setup-python `5fda3b95a4ea91299a34e894583c3862153e4b97`, upload-artifact `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`.
- vcpkg toolchain commit: `30ef65cad98f08e7197c9a1656fbd871bcb72f2d`.
- reviewed vcpkg dependency baseline: `3d72d8c930e1b6a1b2432b262c61af7d3287dcd0`.
- vcpkg clone은 과거 기준선의 포트 객체를 빌드 도중 다시 요청하지 않도록 `--no-tags` 완전 클론을 사용한다.
- configure: `cmake -S $engineRoot -B $buildRoot -G "Visual Studio 18 2026" -A x64 -DPOBTOOLS_KOREAN_RELEASE=ON`
- build/install: `cmake --build $buildRoot --config Release`, `cmake --install $buildRoot --config Release --prefix $installRoot`
- 트리거: `workflow_dispatch`만 사용. 권한: `contents: read`만 사용. Release 작업 없음.

## 아직 확인하지 않은 항목

다음 값은 push와 hosted 수동 dispatch가 별도 승인되지 않았으므로 모두 **pending**이다. 성공으로 기록하지 않는다.

- hosted CMake configure/build/install 결과와 실제 runner image
- `pob-zh.exe --font-coverage-selftest` exit
- `pob-zh.exe --app-update-selftest` exit
- Authenticode `NotSigned` 관측 결과
- 실제 배포 ZIP 파일 수, 바이트 수, SHA-256과 추출 후 매니페스트 일치 결과
- 실행기, 설정, 필터 편집기, 아틀라스 플래너, 패시브 도구, 아이템 붙여넣기, 오류 대화상자 수동 smoke 결과

위 항목은 실제 hosted 실행 또는 사람의 수동 확인 뒤에만 이 문서를 갱신한다. 소스 공개 여부를 신뢰 근거로 대체하지 않는다.
