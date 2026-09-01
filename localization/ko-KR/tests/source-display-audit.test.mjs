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
    internalLiteralAllowlist: [{
      path: 'host/fixture.cpp',
      sha256: literalSha256(fixture),
      reason: 'reverse parser fixture',
    }],
  }, 'host/fixture.cpp').issues.length, 0);
});

test('semantic adjacent regular and raw literals use exact path plus decoded-expression hash', () => {
  const text = 'auto json = u8R"json({"key":")json" /* keep */ L"設定" R"json("})json";';
  const decoded = '{"key":"設定"}';
  const policy = {
    internalLiteralAllowlist: [{
      path: 'host/atlas_diff.cpp',
      sha256: literalSha256(decoded),
      reason: 'exact synthetic JSON parser fixture',
    }],
  };

  const allowed = auditSourceText(text, policy, 'host/atlas_diff.cpp');
  const wrongPath = auditSourceText(text, policy, 'host/other.cpp');

  assert.equal(allowed.displayLiterals, 1);
  assert.equal(allowed.allowedInternalLiterals, 1);
  assert.deepEqual(allowed.issues, []);
  assert.equal(wrongPath.issues[0].code, 'CHINESE_SOURCE_DISPLAY');
  assert.equal(wrongPath.issues[0].literal, decoded);
});

test('prefixes and supported escapes do not change semantic expression identity', () => {
  const decoded = '設定\0A更新\n';
  const text = 'auto value = u8"\\u8A2D\\u5B9A\\0\\x41" /* gap */ L"更新\\n";';
  const report = auditSourceText(text, {
    internalLiteralAllowlist: [{
      path: 'host/fixture.cpp',
      sha256: literalSha256(decoded),
      reason: 'decoded expression identity',
    }],
  }, 'host/fixture.cpp');

  assert.equal(report.displayLiterals, 1);
  assert.equal(report.allowedInternalLiterals, 1);
  assert.deepEqual(report.issues, []);
});

test('an allowlisted expression does not hide different visible text in the same file', () => {
  const policy = {
    internalLiteralAllowlist: [{
      path: 'host/fixture.cpp',
      sha256: literalSha256('設定更新'),
      reason: 'one exact expression',
    }],
  };
  const report = auditSourceText(
    'auto internal = u8"設定" "更新"; ImGui::Text(u8"更新" "顯示");',
    policy,
    'host/fixture.cpp',
  );

  assert.equal(report.allowedInternalLiterals, 1);
  assert.deepEqual(report.issues.map((row) => [row.code, row.literal]), [
    ['CHINESE_SOURCE_DISPLAY', '更新顯示'],
  ]);
});

test('unsupported octal escapes are deterministic audit issues', () => {
  for (const escape of ['\\1', '\\00', '\\07', '\\01']) {
    const report = auditSourceText(`auto value = u8"設定${escape}";`, {
      internalLiteralAllowlist: [],
    }, 'host/fixture.cpp');
    assert.equal(report.issues[0].code, 'UNSUPPORTED_ESCAPE');
    assert.equal(report.issues[0].escape, escape);
  }
});

test('malformed and duplicate internal literal policy rows fail before scanning', () => {
  const valid = {
    path: 'host/fixture.cpp',
    sha256: 'A'.repeat(64),
    reason: 'reviewed internal fixture',
  };
  const invalidLists = [
    null,
    {},
    ['not-an-object'],
    [{ sha256: valid.sha256, reason: valid.reason }],
    [{ ...valid, path: 7 }],
    [{ ...valid, path: 'host\\fixture.cpp' }],
    [{ ...valid, path: 'C:/host/fixture.cpp' }],
    [{ ...valid, sha256: 7 }],
    [{ ...valid, sha256: 'a'.repeat(64) }],
    [{ ...valid, sha256: 'BAD' }],
    [{ ...valid, reason: '   ' }],
    [{ ...valid, extra: true }],
    [valid, { ...valid }],
  ];
  for (const rows of invalidLists) {
    const report = auditSourceText('ImGui::Text(u8"設定");', {
      internalLiteralAllowlist: rows,
    }, 'host/fixture.cpp');
    assert.deepEqual(new Set(report.issues.map((row) => row.code)), new Set(['INVALID_POLICY_DOCUMENT']));
    assert.equal(report.displayLiterals, 0);
  }
});

test('missing internal literal policy fails closed before scanning', () => {
  const direct = auditSourceText('ImGui::Text(u8"設定");', {}, 'host/fixture.cpp');
  assert.equal(direct.displayLiterals, 0);
  assert.deepEqual(direct.issues.map((row) => row.code), ['INVALID_POLICY_DOCUMENT']);

  const root = mkdtempSync(join(tmpdir(), 'missing-source-display-policy-'));
  try {
    mkdirSync(join(root, 'host'));
    writeFileSync(join(root, 'host', 'ui.cpp'), 'ImGui::Text(u8"設定");', 'utf8');
    const scanned = scanSourceDisplay({ engineRoot: root, policy: {} });
    assert.equal(scanned.filesScanned, 0);
    assert.deepEqual(scanned.issues.map((row) => row.code), ['INVALID_POLICY_DOCUMENT']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('policy paths reject non-scalars but accept Korean paths', () => {
  const invalid = auditSourceText('ImGui::Text(u8"設定");', {
    internalLiteralAllowlist: [{
      path: 'host/\uD800.cpp',
      sha256: 'A'.repeat(64),
      reason: 'invalid path scalar',
    }],
  }, 'host/fixture.cpp');
  assert.equal(invalid.displayLiterals, 0);
  assert.deepEqual(invalid.issues.map((row) => row.code), ['INVALID_POLICY_DOCUMENT']);

  const decoded = '設定\uFFFD';
  const valid = auditSourceText(`ImGui::Text(u8"${decoded}");`, {
    internalLiteralAllowlist: [{
      path: 'host/한글.cpp',
      sha256: literalSha256(decoded),
      reason: 'valid Korean path and replacement scalar',
    }],
  }, 'host/한글.cpp');
  assert.equal(valid.allowedInternalLiterals, 1);
  assert.deepEqual(valid.issues, []);
});

test('direct unpaired surrogate source text is an encoding issue', () => {
  const report = auditSourceText('auto value = u8"設定\uD800";', {
    internalLiteralAllowlist: [],
  }, 'host/fixture.cpp');
  assert.equal(report.displayLiterals, 0);
  assert.deepEqual(report.issues.map((row) => row.code), ['INVALID_SOURCE_ENCODING']);
});

test('file scanner decodes UTF-8 fatally and accepts valid replacement scalar', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-encoding-audit-'));
  try {
    mkdirSync(join(root, 'host'));
    writeFileSync(join(root, 'host', 'invalid.cpp'), Buffer.from([
      ...Buffer.from('auto value = u8"', 'utf8'), 0xED, 0xA0, 0x80,
      ...Buffer.from('";', 'utf8'),
    ]));
    writeFileSync(join(root, 'host', 'valid.cpp'), 'auto value = u8"\uFFFD";', 'utf8');
    const report = scanSourceDisplay({
      engineRoot: root,
      policy: { internalLiteralAllowlist: [] },
    });
    assert.deepEqual(report.issues.map((row) => row.code), ['INVALID_SOURCE_ENCODING']);
    assert.equal(report.issues[0].file, 'host/invalid.cpp');
    assert.equal(report.displayLiterals, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Unicode surrogate escapes are rejected deterministically', () => {
  const report = auditSourceText('auto value = u8"設定\\uD800";', {
    internalLiteralAllowlist: [],
  }, 'host/fixture.cpp');
  assert.equal(report.issues[0].code, 'UNSUPPORTED_ESCAPE');
  assert.equal(report.issues[0].escape, '\\uD800');
});

test('LF and CRLF line splices preserve one semantic adjacent expression', () => {
  const decoded = '設定更新';
  const policy = {
    internalLiteralAllowlist: [{
      path: 'host/splice.cpp',
      sha256: literalSha256(decoded),
      reason: 'line-spliced semantic fixture',
    }],
  };
  for (const newline of ['\n', '\r\n']) {
    const text = `auto between = u8"設定" \\${newline} L"更新"; `
      + `auto inside = u8"設定\\${newline}更新";`;
    const report = auditSourceText(text, policy, 'host/splice.cpp');
    assert.equal(report.displayLiterals, 2);
    assert.equal(report.allowedInternalLiterals, 2);
    assert.deepEqual(report.issues, []);
  }
});

test('prefix line splices preserve semantic identity for regular and raw literals', () => {
  const policy = {
    internalLiteralAllowlist: [{
      path: 'host/prefix.cpp',
      sha256: literalSha256('設定'),
      reason: 'phase-2 prefix splice fixture',
    }],
  };
  for (const prefix of ['u8', 'u', 'U', 'L']) {
    for (const newline of ['\n', '\r\n']) {
      for (const token of ['"設定"', 'R"tag(設定)tag"']) {
        const report = auditSourceText(
          `auto value = ${prefix}\\${newline}${token};`, policy, 'host/prefix.cpp',
        );
        assert.equal(report.displayLiterals, 1);
        assert.equal(report.allowedInternalLiterals, 1);
        assert.deepEqual(report.issues, []);
      }
    }
  }
});

test('all spliced raw prefixes hash only the raw payload', () => {
  const forms = [
    'R\\{nl}', 'u8R\\{nl}', 'uR\\{nl}', 'UR\\{nl}', 'LR\\{nl}',
    'u\\{nl}8R', 'u8\\{nl}R', 'u\\{nl}R', 'U\\{nl}R', 'L\\{nl}R',
    'u\\{nl}8\\{nl}R\\{nl}',
  ];
  const policy = {
    internalLiteralAllowlist: [{
      path: 'host/raw-prefix.cpp',
      sha256: literalSha256('設定'),
      reason: 'phase-2 raw prefix fixture',
    }],
  };
  for (const form of forms) {
    for (const delimiter of ['', 'tag']) {
      for (const newline of ['\n', '\r\n']) {
        const prefix = form.replaceAll('{nl}', newline);
        const report = auditSourceText(
          `auto value = ${prefix}"${delimiter}(設定)${delimiter}";`,
          policy,
          'host/raw-prefix.cpp',
        );
        assert.equal(report.displayLiterals, 1);
        assert.equal(report.allowedInternalLiterals, 1);
        assert.deepEqual(report.issues, []);
      }
    }
  }
});

test('raw payload splices retain original LF and CRLF semantic identity', () => {
  for (const prefixNewline of ['\n', '\r\n']) {
    for (const payloadNewline of ['\n', '\r\n']) {
      for (const delimiter of ['', 'tag']) {
        const rawPayload = `設定\\${payloadNewline}更新`;
        const decoded = `${rawPayload}追加`;
        const prefix = `u\\${prefixNewline}8R\\${prefixNewline}`;
        const source = `Label(${prefix}"${delimiter}(${rawPayload})${delimiter}" /* keep */ L"追加");`;
        const correct = auditSourceText(source, {
          internalLiteralAllowlist: [{
            path: 'host/raw-payload.cpp',
            sha256: literalSha256(decoded),
            reason: 'raw payload splice fixture',
          }],
        }, 'host/raw-payload.cpp');
        assert.equal(correct.displayLiterals, 1);
        assert.equal(correct.allowedInternalLiterals, 1);
        assert.deepEqual(correct.issues, []);

        const collapsed = auditSourceText(source, {
          internalLiteralAllowlist: [{
            path: 'host/raw-payload.cpp',
            sha256: literalSha256('設定更新追加'),
            reason: 'incorrect collapsed identity probe',
          }],
        }, 'host/raw-payload.cpp');
        assert.equal(collapsed.allowedInternalLiterals, 0);
        assert.equal(collapsed.issues[0].code, 'CHINESE_SOURCE_DISPLAY');
        assert.equal(collapsed.issues[0].literal, decoded);
        assert.equal(collapsed.issues[0].sha256, literalSha256(decoded));
      }
    }
  }
});

test('scanSourceDisplay validates internal policy once before reading source text', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-display-policy-'));
  try {
    mkdirSync(join(root, 'host'));
    writeFileSync(join(root, 'host', 'one.cpp'), 'Label(u8"設定");', 'utf8');
    writeFileSync(join(root, 'host', 'two.cpp'), 'Label(u8"更新");', 'utf8');
    const report = scanSourceDisplay({
      engineRoot: root,
      policy: { internalLiteralAllowlist: [{ sha256: 'A'.repeat(64), reason: 'missing path' }] },
    });
    assert.equal(report.filesScanned, 0);
    assert.equal(report.displayLiterals, 0);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].code, 'INVALID_POLICY_DOCUMENT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    internalLiteralAllowlist: [],
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
