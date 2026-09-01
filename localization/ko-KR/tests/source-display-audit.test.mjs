import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSourceText, literalSha256, scanSourceDisplay } from '../lib/source-display-audit.mjs';

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

test('overlay inventory issues block the source-display audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-display-audit-'));
  try {
    mkdirSync(join(root, 'host'));
    writeFileSync(join(root, 'host', 'ui.cpp'), 'ImGui::Text(u8"완료");', 'utf8');
    const report = scanSourceDisplay({
      engineRoot: root,
      policy: { internalLiteralAllowlist: [] },
      overlayReport: {
        filesScanned: 1,
        displayLiterals: 1,
        reused: 0,
        official: 0,
        reviewed: 0,
        intentional: 0,
        issues: [{ code: 'MISSING_MAPPING', path: 'host/ui.cpp', source: '新增' }],
      },
    });
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].code, 'MISSING_MAPPING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI writes to explicit paths and exits one for overlay issues', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-display-cli-'));
  try {
    const engineRoot = join(root, 'engine');
    const overlayPath = join(root, 'overlay.json');
    const reportPath = join(root, 'chosen', 'audit.json');
    mkdirSync(join(engineRoot, 'host'), { recursive: true });
    writeFileSync(join(engineRoot, 'host', 'ui.cpp'), 'ImGui::Text(u8"완료");', 'utf8');
    writeFileSync(overlayPath, JSON.stringify({
      filesScanned: 1,
      displayLiterals: 1,
      reused: 0,
      official: 0,
      reviewed: 0,
      intentional: 0,
      issues: [{ code: 'SUGGESTION_ONLY', path: 'host/ui.cpp', source: '更新' }],
    }), 'utf8');
    const script = fileURLToPath(new URL('../audit-source-display.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [
      script,
      '--engine-root', engineRoot,
      '--overlay-report', overlayPath,
      '--report', reportPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.issues[0].code, 'SUGGESTION_ONLY');
    assert.equal(dirname(reportPath), join(root, 'chosen'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
