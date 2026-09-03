import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSignature } from '../lib/format-signature.mjs';
import { auditEntries, auditRuntimeEntries, summarizeAudit } from '../lib/locale-audit.mjs';

test('formatSignature preserves printf, numbered placeholders, newlines and colour tags', () => {
  assert.deepEqual(
    formatSignature('Gain {}% and {:+d}% plus {0}% and {1:+d}% of %s\n^xFF00FFDamage'),
    ['LF', 'PRINTF:%s', 'SLOT:{0}', 'SLOT:{1:+d}', 'SLOT:{:+d}', 'SLOT:{}', 'TAG:^xFF00FF'],
  );
});

test('auditEntries rejects unresolved English but permits documented literals', () => {
  const report = auditEntries({
    dictionary: 'ui',
    reference: { Build: '組建', DPS: '每秒傷害', Notes: '備註' },
    target: { Build: 'Build', DPS: 'DPS', Notes: '메모' },
    policy: { literalAllowlist: { ui: { DPS: 'standard acronym' } }, excluded: {} },
  });
  assert.deepEqual(report.issues.map((issue) => issue.code), ['UNRESOLVED_ENGLISH']);
});

test('auditEntries rejects a Chinese target value', () => {
  const report = auditEntries({
    dictionary: 'ui',
    reference: { Notes: '備註' },
    target: { Notes: '備註' },
    policy: { literalAllowlist: {}, excluded: {} },
  });
  assert.deepEqual(report.issues.map((issue) => issue.code), ['CHINESE_DISPLAY']);
});

test('auditEntries rejects configured non-official Korean terms only for matching source terms', () => {
  const report = auditEntries({
    dictionary: 'ui',
    reference: { '{0}% more Ailment Duration': true },
    target: { '{0}% more Ailment Duration': '질병 지속시간 {0}% 증폭' },
    policy: {
      literalAllowlist: {},
      excluded: {},
      officialTermRules: [{ source: 'Ailment', forbidden: '질병', official: '상태 이상' }],
    },
  });
  assert.equal(report.issues[0].code, 'NON_OFFICIAL_TERM');
  assert.equal(report.issues[0].detail, '질병 -> 상태 이상');

  const unrelated = auditEntries({
    dictionary: 'ui',
    reference: { 'Disease Vector': true },
    target: { 'Disease Vector': '질병 매개' },
    policy: {
      literalAllowlist: {},
      excluded: {},
      officialTermRules: [{ source: 'Ailment', forbidden: '질병', official: '상태 이상' }],
    },
  });
  assert.deepEqual(unrelated.issues, []);
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

test('auditEntries rejects a removed unnumbered GGG placeholder', () => {
  const report = auditEntries({
    dictionary: 'ui',
    reference: { 'Grants Minions {}% increased Critical Strike Chance': true },
    target: { 'Grants Minions {}% increased Critical Strike Chance': '소환수의 치명타 확률 증가' },
    policy: { literalAllowlist: {}, excluded: {} },
  });
  assert.equal(report.issues[0].code, 'FORMAT_MISMATCH');
});

test('summarizeAudit keeps counts without copying issue payloads', () => {
  const summary = summarizeAudit({
    total: 2,
    resolved: 1,
    excluded: 0,
    dictionaries: [{ dictionary: 'ui', total: 2, resolved: 1, excluded: 0, issues: [{ code: 'MISSING_KEY', key: 'Build' }] }],
    issues: [{ code: 'MISSING_KEY', key: 'Build', detail: 'large payload' }],
  });
  assert.deepEqual(summary, {
    total: 2,
    resolved: 1,
    excluded: 0,
    issues: 1,
    issueCodes: { MISSING_KEY: 1 },
    dictionaries: [{ dictionary: 'ui', total: 2, resolved: 1, excluded: 0, issues: 1 }],
  });
});

test('runtime audit accepts a key resolved by any loaded dictionary', () => {
  const report = auditRuntimeEntries({
    inventory: ['Build', 'Maximum Life'],
    dictionaries: {
      tags: { 'Maximum Life': '최대 생명력' },
      ui: { Build: '빌드' },
    },
    loadOrder: ['tags', 'ui'],
    policy: { literalAllowlist: {}, excluded: {} },
  });
  assert.equal(report.total, 2);
  assert.equal(report.resolved, 2);
  assert.deepEqual(report.issues, []);
});
