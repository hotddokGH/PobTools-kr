import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMaintenancePr } from '../render-maintenance-pr.mjs';

const commit = 'abcdef0123456789abcdef0123456789abcdef01';

function fixtureReport(overrides = {}) {
  return {
    schemaVersion: 1,
    commit,
    upstreamRef: 'upstream/main',
    classification: 'review-required',
    sourceSummary: {
      filesScanned: 12,
      displayLiterals: 20,
      reused: 7,
      official: 5,
      reviewed: 1,
      intentional: 1,
    },
    newStrings: [
      { code: 'MISSING_MAPPING', path: 'z/view.cpp', function: 'Draw', occurrenceIndex: 1, line: 9, source: '新增' },
      { code: 'MISSING_MAPPING', path: 'a/view.cpp', function: 'Open', occurrenceIndex: 1, line: 4, source: '新規' },
    ],
    suggestedStrings: [
      { code: 'SUGGESTED', path: 'b/view.cpp', function: 'Draw', occurrenceIndex: 1, line: 2, source: '建議', status: 'suggested' },
    ],
    ambiguousStrings: [
      { code: 'AMBIGUOUS', path: 'c/view.cpp', function: 'Draw', occurrenceIndex: 2, line: 3, source: '模糊', status: 'ambiguous' },
    ],
    officialDataChanges: [{ path: 'pob-zh-engine/host/data/atlas_maps_poe1.json' }],
    compatibilityFailures: [{ path: 'compat.patch', detail: 'hunk mismatch' }],
    deterministicFailures: [{ path: 'runtime', phase: 'runtime-locale-build', detail: 'hash mismatch' }],
    commandFailures: [{ path: 'builder.mjs', phase: 'custom-poe1-data-build', detail: 'exit 1' }],
    auditFailures: [{ code: 'UNEXPECTED_HAN', path: 'host/view.cpp', phase: 'source-audit', detail: 'remaining text' }],
    phases: [],
    ...overrides,
  };
}

test('renders the complete deterministic Korean maintenance PR snapshot', () => {
  assert.deepEqual(renderMaintenancePr(fixtureReport()), {
    title: 'chore: review upstream abcdef0 for Korean release',
    labels: ['localization', 'upstream-sync'],
    body: `## 업스트림 점검

- 업스트림 범위: upstream/main → \`${commit}\`
- 판정: \`review-required\`
- 재사용된 번역: 7개

## 사람 검토 필요

### \`AMBIGUOUS\` (1개)

| 경로 | 함수 | 줄 | 원문 |
| --- | --- | ---: | --- |
| c/view.cpp | Draw | 3 | 模糊 |

### \`MISSING_MAPPING\` (2개)

| 경로 | 함수 | 줄 | 원문 |
| --- | --- | ---: | --- |
| a/view.cpp | Open | 4 | 新規 |
| z/view.cpp | Draw | 9 | 新增 |

### \`OFFICIAL_DATA_CHANGE\` (1개)

| 경로 | 함수 | 줄 | 원문 |
| --- | --- | ---: | --- |
| pob-zh-engine/host/data/atlas_maps_poe1.json |  |  |  |

### \`SUGGESTED\` (1개)

| 경로 | 함수 | 줄 | 원문 |
| --- | --- | ---: | --- |
| b/view.cpp | Draw | 2 | 建議 |

## 차단 진단

### 호환성 실패 (1개)

- compat.patch — hunk mismatch

### 결정성 실패 (1개)

- runtime — hash mismatch (단계: runtime-locale-build)

### 명령 실패 (1개)

- builder.mjs — exit 1 (단계: custom-poe1-data-build)

### 감사 실패 (1개)

- host/view.cpp — remaining text (단계: source-audit, 코드: UNEXPECTED_HAN)

## 다음 명령

\`\`\`powershell
node localization/ko-KR/update-upstream.mjs --repository-root . --upstream-ref '<검토할-커밋>' --workspace .ko-worktrees/upstream-review --report reports/maintenance/upstream-update.json --force-prepare
node --test localization/ko-KR/tests/*.test.mjs
& tests/ko-KR/Test-KoreanLocale.ps1 -EngineRoot '<생성-엔진-경로>'
& tests/ko-KR/Test-OfficialTerms.ps1 -EngineRoot '<생성-엔진-경로>' -ReportRoot reports
\`\`\`
`,
  });
});

test('sorts review rows and escapes Markdown and HTML without emitting executable content', () => {
  const malicious = fixtureReport({
    upstreamRef: 'evil<script>|*`$()\\ref',
    newStrings: [{
      code: 'MISSING_MAPPING',
      path: 'x|<img>.cpp',
      function: '*run*',
      occurrenceIndex: 1,
      line: 1,
      source: '`$(Remove-Item *)`',
    }],
    suggestedStrings: [],
    ambiguousStrings: [],
    officialDataChanges: [],
    compatibilityFailures: [],
    deterministicFailures: [],
    commandFailures: [],
    auditFailures: [],
  });
  const rendered = renderMaintenancePr(malicious);
  assert.match(rendered.body, /evil&lt;script&gt;\\\|\\\*\\`\$\(\)\\\\ref/u);
  assert.match(rendered.body, /x\\\|&lt;img&gt;\.cpp \| \\\*run\\\*/u);
  assert.match(rendered.body, /\\`\$\(Remove-Item \\\*\)\\`/u);
  assert.equal(rendered.body.includes('<script>'), false);
  assert.equal(rendered.body.includes('node localization/ko-KR/update-upstream.mjs --repository-root . --upstream-ref evil'), false);
});

test('rejects malformed reports, controls, unknown top-level fields, and unsafe classifications', () => {
  for (const report of [
    fixtureReport({ commit: 'ABCDEF' }),
    fixtureReport({ classification: 'ready\nwrite' }),
    fixtureReport({ upstreamRef: 'upstream/main\u0000bad' }),
    fixtureReport({ phases: [{ name: 'phase', command: ['bad\ncommand'], exitCode: 0, stderr: '' }] }),
    fixtureReport({ sourceSummary: { filesScanned: 1, displayLiterals: 1, reused: -1, official: 0, reviewed: 0, intentional: 0 } }),
    { ...fixtureReport(), unexpected: true },
  ]) assert.throws(() => renderMaintenancePr(report), { name: 'Error' });
});
