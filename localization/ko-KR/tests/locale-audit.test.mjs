import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSignature } from '../lib/format-signature.mjs';
import { auditEntries, summarizeAudit } from '../lib/locale-audit.mjs';

test('formatSignature preserves printf, numbered placeholders, newlines and colour tags', () => {
  assert.deepEqual(
    formatSignature('Gain {0}% of %s\n^xFF00FFDamage'),
    ['LF', 'PRINTF:%s', 'SLOT:{0}', 'TAG:^xFF00FF'],
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

test('auditEntries rejects a damaged placeholder signature', () => {
  const report = auditEntries({
    dictionary: 'ui',
    reference: { 'Level {0}': '等級 {0}' },
    target: { 'Level {0}': '레벨' },
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
