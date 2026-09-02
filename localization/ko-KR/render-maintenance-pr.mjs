import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT_KEYS = [
  'ambiguousStrings', 'auditFailures', 'classification', 'commandFailures', 'commit',
  'compatibilityFailures', 'deterministicFailures', 'newStrings', 'officialDataChanges',
  'phases', 'schemaVersion', 'sourceSummary', 'suggestedStrings', 'upstreamRef',
];
const SUMMARY_KEYS = ['displayLiterals', 'filesScanned', 'intentional', 'official', 'reviewed', 'reused'];
const CLASSIFICATIONS = new Set(['ready', 'review-required', 'already-processed', 'blocked']);
const REVIEW_CODES = {
  newStrings: new Set(['MISSING_MAPPING', 'MISSING_COMPONENT_MAPPING']),
  suggestedStrings: new Set(['SUGGESTION_ONLY', 'SUGGESTED']),
  ambiguousStrings: new Set(['AMBIGUOUS']),
};

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has an unexpected structure`);
  }
}

function assertSafeString(value, label, { empty = true } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0)) throw new Error(`${label} must be a string`);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`${label} contains control characters`);
  return value;
}

function assertRows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const [index, row] of value.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label}[${index}] must be an object`);
    for (const [key, nested] of Object.entries(row)) {
      if (typeof nested === 'string') assertSafeString(nested, `${label}[${index}].${key}`);
      else if (key === 'line' || key === 'occurrenceIndex') {
        if (!Number.isSafeInteger(nested) || nested < 0) throw new Error(`${label}[${index}].${key} must be a non-negative integer`);
      }
    }
  }
}

function assertNoUnsafeStrings(value, label = 'maintenance report') {
  if (typeof value === 'string') {
    assertSafeString(value, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoUnsafeStrings(nested, `${label}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) assertNoUnsafeStrings(nested, `${label}.${key}`);
  }
}

export function validateMaintenanceReport(report) {
  assertExactKeys(report, REPORT_KEYS, 'maintenance report');
  assertNoUnsafeStrings(report);
  if (report.schemaVersion !== 1) throw new Error('maintenance report schemaVersion must be 1');
  if (!/^[0-9a-f]{40}$/u.test(report.commit)) throw new Error('maintenance report commit must be 40 lowercase hexadecimal characters');
  assertSafeString(report.upstreamRef, 'maintenance report upstreamRef', { empty: false });
  if (!CLASSIFICATIONS.has(report.classification)) throw new Error('maintenance report classification is invalid');
  assertExactKeys(report.sourceSummary, SUMMARY_KEYS, 'maintenance report sourceSummary');
  for (const key of SUMMARY_KEYS) {
    if (!Number.isSafeInteger(report.sourceSummary[key]) || report.sourceSummary[key] < 0) {
      throw new Error(`maintenance report sourceSummary.${key} must be a non-negative safe integer`);
    }
  }
  for (const [key, codes] of Object.entries(REVIEW_CODES)) {
    assertRows(report[key], key);
    for (const [index, row] of report[key].entries()) {
      if (!codes.has(row.code)) throw new Error(`${key}[${index}].code is invalid`);
      assertSafeString(row.path, `${key}[${index}].path`, { empty: false });
      assertSafeString(row.function, `${key}[${index}].function`);
      assertSafeString(row.source, `${key}[${index}].source`);
      if (!Number.isSafeInteger(row.line) || row.line < 0) throw new Error(`${key}[${index}].line must be a non-negative safe integer`);
    }
  }
  for (const key of ['officialDataChanges', 'compatibilityFailures', 'deterministicFailures', 'commandFailures', 'auditFailures', 'phases']) {
    assertRows(report[key], key);
  }
  for (const [index, row] of report.officialDataChanges.entries()) {
    assertSafeString(row.path, `officialDataChanges[${index}].path`, { empty: false });
  }
  return report;
}

function markdown(value) {
  return assertSafeString(String(value), 'rendered value')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replace(/([`*[\]{}|])/gu, '\\$1');
}

function compareRows(left, right) {
  for (const key of ['code', 'path', 'function']) {
    const compared = String(left[key] ?? '').localeCompare(String(right[key] ?? ''), 'en');
    if (compared !== 0) return compared;
  }
  const occurrence = Number(left.occurrenceIndex ?? 0) - Number(right.occurrenceIndex ?? 0);
  if (occurrence !== 0) return occurrence;
  const line = Number(left.line ?? 0) - Number(right.line ?? 0);
  if (line !== 0) return line;
  return String(left.source ?? '').localeCompare(String(right.source ?? ''), 'en');
}

function reviewGroups(report) {
  const rows = [
    ...report.newStrings,
    ...report.suggestedStrings,
    ...report.ambiguousStrings,
    ...report.officialDataChanges.map((row) => ({ ...row, code: 'OFFICIAL_DATA_CHANGE' })),
  ].sort(compareRows);
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.code)) groups.set(row.code, []);
    groups.get(row.code).push(row);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
}

function failureSection(title, rows) {
  const sorted = [...rows].sort(compareRows);
  const output = [`### ${title} (${sorted.length}개)`, ''];
  if (sorted.length === 0) return [...output, '- 없음', ''];
  for (const row of sorted) {
    const suffix = [
      row.phase ? `단계: ${markdown(row.phase)}` : '',
      row.code ? `코드: ${markdown(row.code)}` : '',
    ].filter(Boolean);
    output.push(`- ${markdown(row.path ?? '')} — ${markdown(row.detail ?? '')}${suffix.length ? ` (${suffix.join(', ')})` : ''}`);
  }
  output.push('');
  return output;
}

export function renderMaintenancePr(input) {
  const report = validateMaintenanceReport(input);
  const lines = [
    '## 업스트림 점검', '',
    `- 업스트림 범위: ${markdown(report.upstreamRef)} → \`${report.commit}\``,
    `- 판정: \`${report.classification}\``,
    `- 재사용된 번역: ${report.sourceSummary.reused}개`, '',
    '## 사람 검토 필요', '',
  ];
  const groups = reviewGroups(report);
  if (groups.length === 0) lines.push('- 없음', '');
  for (const [code, rows] of groups) {
    lines.push(`### \`${code}\` (${rows.length}개)`, '', '| 경로 | 함수 | 발생 | 줄 | 원문 |', '| --- | --- | ---: | ---: | --- |');
    for (const row of rows) {
      lines.push(`| ${markdown(row.path ?? '')} | ${markdown(row.function ?? '')} | ${row.occurrenceIndex ?? ''} | ${row.line ?? ''} | ${markdown(row.source ?? '')} |`);
    }
    lines.push('');
  }
  lines.push(
    '## 차단 진단', '',
    ...failureSection('호환성 실패', report.compatibilityFailures),
    ...failureSection('결정성 실패', report.deterministicFailures),
    ...failureSection('명령 실패', report.commandFailures),
    ...failureSection('감사 실패', report.auditFailures),
    '## 다음 명령', '', '```powershell',
    "node localization/ko-KR/update-upstream.mjs --repository-root . --upstream-ref '<검토할-커밋>' --workspace .ko-worktrees/upstream-review --report reports/maintenance/upstream-update.json --force-prepare",
    'node --test localization/ko-KR/tests/*.test.mjs',
    "& tests/ko-KR/Test-KoreanLocale.ps1 -EngineRoot '<생성-엔진-경로>'",
    "& tests/ko-KR/Test-OfficialTerms.ps1 -EngineRoot '<생성-엔진-경로>' -ReportRoot reports",
    '```',
  );
  return {
    title: `chore: review upstream ${report.commit.slice(0, 7)} for Korean release`,
    body: `${lines.join('\n')}\n`,
    labels: ['localization', 'upstream-sync'],
  };
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('renderer arguments must be --name value pairs');
    if (values.has(key)) throw new Error(`duplicate renderer argument: ${key}`);
    values.set(key, value);
  }
  for (const key of ['--report', '--title-file', '--body-file', '--labels-file', '--metadata-file']) {
    if (!values.has(key)) throw new Error(`missing renderer argument: ${key}`);
  }
  return values;
}

function main() {
  const values = parseArguments(process.argv.slice(2));
  const report = JSON.parse(readFileSync(resolve(values.get('--report')), 'utf8'));
  const rendered = renderMaintenancePr(report);
  writeFileSync(resolve(values.get('--title-file')), `${rendered.title}\n`, 'utf8');
  writeFileSync(resolve(values.get('--body-file')), rendered.body, 'utf8');
  writeFileSync(resolve(values.get('--labels-file')), `${rendered.labels.join('\n')}\n`, 'utf8');
  writeFileSync(resolve(values.get('--metadata-file')), `${JSON.stringify({ commit: report.commit, classification: report.classification })}\n`, 'utf8');
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
