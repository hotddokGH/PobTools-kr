import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSourceText, literalSha256 } from '../lib/source-display-audit.mjs';

test('visible C++ Han literal is rejected', () => {
  const report = auditSourceText('ImGui::Button(u8"設定");', { internalLiteralAllowlist: [] });
  assert.equal(report.issues[0].code, 'CHINESE_SOURCE_DISPLAY');
});

test('Korean literal and a hashed internal parser fixture are accepted', () => {
  assert.equal(auditSourceText('ImGui::Button(u8"설정");', { internalLiteralAllowlist: [] }).issues.length, 0);
  const fixture = '稀有度';
  assert.equal(auditSourceText(`const char* fixture = u8"${fixture}";`, {
    internalLiteralAllowlist: [{ sha256: literalSha256(fixture), reason: 'reverse parser fixture' }],
  }).issues.length, 0);
});

test('leaked machine-translation markers are rejected', () => {
  const report = auditSourceText('ImGui::TextUnformatted(u8"아틀라스TTTT데이터");', {
    internalLiteralAllowlist: [],
  });
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].code, 'MACHINE_TRANSLATION_MARKER');
});

test('comments are not classified as display literals', () => {
  const report = auditSourceText('// "設定"\n/* u8"更新" */\nImGui::Text(u8"완료");', {
    internalLiteralAllowlist: [],
  });
  assert.equal(report.issues.length, 0);
  assert.equal(report.displayLiterals, 1);
});

test('non-display diagnostic fixtures can be excluded by exact source path', () => {
  const report = auditSourceText('const char* fixture = u8"稀有度";', {
    excludedPaths: [{ path: 'host/filter_selftest.cpp', reason: 'diagnostic-only fixture' }],
  }, 'host/filter_selftest.cpp');
  assert.equal(report.displayLiterals, 0);
  assert.equal(report.issues.length, 0);
  assert.equal(report.excludedFile, true);
});
